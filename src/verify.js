// src/verify.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { get, patch, postArray } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';
import { getAsset } from './shared/db.js';

const TAG = 'Verify';

/* ============================================================================
 *  LOGIQUE ORIGINALE : vérifier et synchroniser les états DB vs on-chain
 * ========================================================================== */

/** Lit les états en base pour un set d’IDs. */
async function fetchDbStates(ids) {
  if (!ids.length) return new Map();
  const list = ids.join(',');
  const rows = await get(`positions?id=in.(${list})&select=id,state`);
  // rows: [{ id, state }]
  return new Map((rows || []).map(r => [Number(r.id), Number(r.state)]));
}

/** Patch un état en base. */
async function updateDbState(id, newState) {
  await patch(`positions?id=eq.${id}`, { state: Number(newState) });
}

/** Vérifie et synchronise la DB avec l’on-chain. (inchangé) */
export async function verifyAndSync(ids) {
  const uniq = Array.from(
    new Set(ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0))
  ).sort((a, b) => a - b);

  const provider = makeProvider();
  const contract = makeContract(provider, ABI.State);

  // DB snapshot
  const dbMap = await fetchDbStates(uniq);

  let checked = 0;
  let updated = 0;
  const mismatches = [];

  for (const id of uniq) {
    try {
      const chainState = Number(await contract.stateOf(id)); // 0|1|2|3
      const dbState = dbMap.has(id) ? dbMap.get(id) : null;

      checked += 1;

      // Si l'id n'existe pas en DB, on le signale mais on ne crée rien ici (comportement historique conservé).
      if (dbState === null) {
        mismatches.push({ id, db: null, chain: chainState });
        continue;
      }

      if (dbState !== chainState) {
        await updateDbState(id, chainState);
        mismatches.push({ id, db: dbState, chain: chainState });
        updated += 1;
        logInfo(TAG, `id=${id} state DB ${dbState} → chain ${chainState} (synced)`);
      }
    } catch (e) {
      logErr(TAG, `id=${id} failed:`, e?.message || e);
    }
  }

  return { checked, updated, mismatches };
}

/* ============================================================================
 *  AJOUTS : Backfill “si manquant en DB, va chercher et stocke”
 *    - D’abord via API publique (https://api.brokex.trade/position/:id)
 *    - Sinon fallback on-chain (trades + stateOf)
 *    - Upsert minimal en DB (sans vérifier le contenu existant)
 * ========================================================================== */

/** API publique pour vérifier l’existence en DB (retourne null si 404) */
async function fetchDbPositionViaPublicApi(id) {
  const base = (process.env.PUBLIC_API_BASE || 'https://api.brokex.trade').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/position/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`API_PUBLIC ${res.status} ${res.statusText} :: ${txt}`);
    }
    const json = await res.json();
    return json || null;
  } catch (e) {
    logErr(TAG, `fetchDbPositionViaPublicApi(${id})`, e?.message || e);
    // Ne bloque pas le backfill : on retournera null pour tenter on-chain
    return null;
  }
}

/** Helpers robustes BigNumber → string */
function asStr(v) {
  if (v === null || v === undefined) return '0';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object') {
    if (typeof v.toString === 'function' && v.toString !== Object.prototype.toString) {
      try { return v.toString(); } catch { /* ignore */ }
    }
    if (typeof v._hex === 'string') {
      try { return BigInt(v._hex).toString(); } catch { /* ignore */ }
    }
  }
  try { return BigInt(v).toString(); } catch { return '0'; }
}

/** Convertit le retour du mapping public trades(uint32) en structure positions minimaliste */
function mapTradeToPositionRow(id, t, state) {
  const isLong = (Number(t.flags) & 0x01) !== 0;

  const entry  = asStr(t.entryX6);
  const target = asStr(t.targetX6);
  const sl     = asStr(t.slX6);
  const tp     = asStr(t.tpX6);
  const liq    = asStr(t.liqX6);

  return {
    // ⚠️ ne pas envoyer trader_addr_lc — colonne générée côté DB
    id: String(id),
    state: Number(state),                 // 0=ORDER,1=OPEN,2=CLOSED,3=CANCELLED
    asset_id: Number(t.asset),
    trader_addr: String(t.owner),
    long_side: Boolean(isLong),
    lots: Number(t.lots),
    leverage_x: Number(t.leverageX ?? t.leveragex ?? t.leverage ?? 0),
    entry_x6: Number(state) === 1 ? entry : null,
    target_x6: Number(state) === 0 ? target : null,
    sl_x6: sl,
    tp_x6: tp,
    liq_x6: liq,
    notional_usd6: null,  // (attaché plus bas si possible)
    margin_usd6:   null
  };
}

/** Calcule notional/margin (facultatif) si state=OPEN et assets connus */
async function maybeAttachNotionalAndMargin(row) {
  if (Number(row.state) !== 1) return row; // besoin de entry_x6
  try {
    const asset = await getAsset(Number(row.asset_id)); // via cache
    const BI = (x) => BigInt(String(x));
    const mulDivFloor = (a,b,c) => (a*b)/c;

    const entry = BI(row.entry_x6 || 0);
    const lots  = BI(row.lots || 0);
    const num   = BI(asset?.lot_num ?? 1);
    const den   = BI(asset?.lot_den ?? 1);
    const lev   = BI(row.leverage_x || 1n);

    const qty_num = lots * num; // qty = lots * (num/den)
    const notional = mulDivFloor(entry, qty_num, den); // x6 * qty
    const margin   = notional / (lev === 0n ? 1n : lev);

    row.notional_usd6 = notional.toString();
    row.margin_usd6   = margin.toString();
  } catch {
    // silencieux : si assets pas prêts, on laisse null
  }
  return row;
}

/** Va lire on-chain: trades(id) + stateOf(id) et renvoie une row positions minimaliste */
async function fetchOnChainMinimalRow(id) {
  const provider = makeProvider();
  // ABI.Trade doit contenir: trades(uint32) returns (Trade), ABI.State: stateOf(uint32)
  const contractTrade = makeContract(provider, ABI.Trade);
  const contractState = makeContract(provider, ABI.State);

  const [t, state] = await Promise.all([
    contractTrade.trades(id),
    contractState.stateOf(id)
  ]);

  // Si slot vide (owner=0), on considère inexistant
  const ownerLc = String(t?.owner || '').toLowerCase();
  if (!t || ownerLc === '0x0000000000000000000000000000000000000000') {
    return null;
  }

  let row = mapTradeToPositionRow(id, t, Number(state));
  row = await maybeAttachNotionalAndMargin(row);
  return row;
}

/** Upsert en DB (positions?on_conflict=id) */
async function upsertPositionRow(row) {
  // NB: ne PAS envoyer trader_addr_lc — colonne générée côté DB
  await postArray('positions?on_conflict=id', [row]);
}

/** Vérifie la présence en DB pour un ID:
 *  - essaie API publique (si existe, on considère OK)
 *  - sinon va on-chain et insère minimalement en DB
 *  - NE vérifie PAS le contenu si déjà présent
 *  @returns {Promise<boolean>} true si créé (backfilled), false sinon
 */
async function ensurePositionExists(id) {
  // 1) API publique (DB déjà peuplée ?)
  const apiRow = await fetchDbPositionViaPublicApi(id);
  if (apiRow) return false; // déjà en DB via API publique, rien à faire

  // 2) On-chain → DB si position existe on-chain
  const row = await fetchOnChainMinimalRow(id);
  if (!row) return false;   // rien on-chain (id “vide”), on ne crée pas

  await upsertPositionRow(row);
  logInfo(TAG, `backfilled id=${id} (state=${row.state}) from chain -> DB`);
  return true;
}

/** Backfill sur un intervalle inclusif [fromId..toId]
 *  - Appelle l’API publique pour chaque id; si manquante → RPC
 *  - Parallélise jusqu’à 500 tâches simultanées
 *  @returns {Promise<{ scanned:number, created:number }>}
 */
export async function backfillRangeIfMissing(fromId, toId, { concurrency = 500 } = {}) {
  const from = Number(fromId), to = Number(toId);
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
    throw new Error('bad_range');
  }
  const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i);

  let created = 0, scanned = 0;
  let idx = 0;

  const N = Math.max(1, Math.min(Number(concurrency) || 1, 500)); // cap 500

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= ids.length) break;
      const id = ids[i];
      try {
        const didCreate = await ensurePositionExists(id);
        if (didCreate) created++;
      } catch (e) {
        logErr(TAG, `backfill id=${id}`, e?.message || e);
      } finally {
        scanned++;
      }
    }
  }

  await Promise.all(Array.from({ length: N }, worker));
  return { scanned, created };
}

/** Utilitaire: à appeler quand un nouvel id “latestId” arrive.
 *  Si latestId est un multiple de 10, on backfill le bloc [latestId-9 .. latestId].
 *  Exemple: latestId=3010 → backfill [3001..3010]
 */
export async function backfillIfMultipleOf10(latestId) {
  const id = Number(latestId);
  if (!Number.isInteger(id) || id <= 0) return { scanned: 0, created: 0, skipped: true };

  if (id % 10 !== 0) return { scanned: 0, created: 0, skipped: true };

  const from = Math.max(1, id - 9);
  const to   = id;
  logInfo(TAG, `multiple-of-10 hit: backfilling [${from}..${to}] (up to 500 concurrent RPC calls)`);
  const res = await backfillRangeIfMissing(from, to, { concurrency: 500 });
  return { ...res, skipped: false };
}
