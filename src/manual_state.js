// ======================================================================
// BROKEX • manual_state (STATE-ONLY RECONCILE + consistency checks)
// - Appelle UNIQUEMENT stateOf(id) (PAS de getTrade)
// - Compare à DB.positions.state
// - Cas 0->1 : Executed + index SL/TP si non nuls
// - Cas 1->2/3 : handleRemovedEvent (nettoie SL/TP/LIQ/ORDER) + set state 3 si besoin
// - Cas égaux : vérifie/retape les index (voir détails ci-dessous)
// - Autres mismatch : patch state uniquement
//
// Vérifs supplémentaires quand états égaux :
//   state=0 : ORDER bien indexé ? sinon upsertOpenedEvent(state:0)
//   state=1 : pas d'ORDER résiduel ? sinon handleExecutedEvent
//             SL/TP présents si non nuls ? sinon handleStopsUpdatedEvent
//   state=2/3 : AUCUN index (ORDER/SL/TP/LIQ) ? sinon handleRemovedEvent
//
// Usage CLI:
//   node src/manual_state.js --end=1200 --count=100
//   node src/manual_state.js --ids=905,906,940
//   node src/manual_state.js --end=5000 --count=1000 --dbConcurrency=500 --rpcConcurrency=100 --workers=300
// ======================================================================

import 'dotenv/config';
import { ethers } from 'ethers';
import { ABI } from './shared/abi.js';
import { logInfo as L, logErr as E } from './shared/logger.js';
import { get as pgGet, patch as pgPatch } from './shared/rest.js';
import {
  handleExecutedEvent,
  handleStopsUpdatedEvent,
  handleRemovedEvent,
  upsertOpenedEvent
} from './shared/db.js';

// ---------- ENV ----------
const RPC_URL       = (process.env.RPC_URL || process.env.RPC_HTTP || '').trim();
const CONTRACT_ADDR = (process.env.CONTRACT_ADDR || '').trim();
if (!RPC_URL)       throw new Error('RPC_URL manquant dans .env');
if (!CONTRACT_ADDR) throw new Error('CONTRACT_ADDR manquant dans .env');

const TAG = 'ManualState';

// ---------- ETHERS (HTTP RPC) ----------
const iface    = new ethers.Interface(ABI.Getters);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDR, iface, provider);

// ---------- Concurrency utils ----------
class Semaphore {
  constructor(max) { this.max = Math.max(1, max | 0); this.cur = 0; this.q = []; }
  async acquire() {
    if (this.cur < this.max) {
      this.cur++; let reld = false;
      return () => { if (!reld) { reld = true; this.cur--; this._next(); } };
    }
    return new Promise(res => {
      this.q.push(() => {
        this.cur++; let reld = false;
        res(() => { if (!reld) { reld = true; this.cur--; this._next(); } });
      });
    });
  }
  _next() { if (this.q.length && this.cur < this.max) this.q.shift()(); }
}

function makeCtx({ dbConcurrency = 500, rpcConcurrency = 100 } = {}) {
  const dbSem  = new Semaphore(Number(dbConcurrency));
  const rpcSem = new Semaphore(Number(rpcConcurrency));
  const withDb  = async fn => { const r = await dbSem.acquire();  try { return await fn(); } finally { r(); } };
  const withRpc = async fn => { const r = await rpcSem.acquire(); try { return await fn(); } finally { r(); } };
  return { withDb, withRpc };
}

// ---------- DB helpers ----------
async function readDbRow(id, withDb) {
  return withDb(async () => {
    const sel = 'id,state,sl_x6,tp_x6,liq_x6,target_x6,entry_x6,lots,long_side,asset_id,leverage_x,trader_addr';
    const row = (await pgGet(`positions?id=eq.${id}&select=${sel}&limit=1`))?.[0] || null;
    return row ? {
      id: Number(row.id),
      state: Number(row.state),
      sl_x6: BigInt(row.sl_x6 ?? 0),
      tp_x6: BigInt(row.tp_x6 ?? 0),
      liq_x6: BigInt(row.liq_x6 ?? 0),
      target_x6: BigInt(row.target_x6 ?? 0),
      entry_x6: BigInt(row.entry_x6 ?? 0),
      lots: Number(row.lots ?? 0),
      long_side: Boolean(row.long_side),
      asset_id: Number(row.asset_id ?? 0),
      leverage_x: Number(row.leverage_x ?? 0),
      trader_addr: String(row.trader_addr || '')
    } : null;
  });
}
async function patchDbState(id, state, withDb) {
  return withDb(async () => pgPatch(`positions?id=eq.${id}`, { state }));
}
async function readBucketsByPosition(id, withDb) {
  return withDb(async () => {
    const [orders, stops] = await Promise.all([
      pgGet(`order_buckets?position_id=eq.${id}`),
      pgGet(`stop_buckets?position_id=eq.${id}`)
    ]);
    return { orders: orders || [], stops: stops || [] };
  });
}

// ---------- equality helpers ----------
const BI = (x) => BigInt(x ?? 0);

function orderIndexedEqual(orders, { lots, long_side }) {
  if ((orders?.length || 0) !== 1) return false;
  const o = orders[0];
  return Number(o.lots) === Number(lots) && Boolean(o.side) === Boolean(long_side);
}
function stopsIndexedOkForOpen(stops, { sl_x6, tp_x6, liq_x6, lots, long_side }) {
  const need = [];
  if (sl_x6 !== 0n)  need.push({ type: 1 });
  if (tp_x6 !== 0n)  need.push({ type: 2 });
  if (liq_x6 !== 0n) need.push({ type: 3 }); // présence seulement (création LIQ non gérée ici)
  const sideShort = !Boolean(long_side);

  // chaque type demandé doit exister avec lots/side attendus
  for (const w of need) {
    const m = stops.find(r =>
      Number(r.stop_type) === w.type &&
      Number(r.lots) === Number(lots) &&
      Boolean(r.side) === sideShort
    );
    if (!m) return false;
  }
  // Si des stops existent alors que correspondants = 0 → on tolère (on ne supprime pas ici sauf state 2/3)
  return true;
}
function hasAnyIndex(orders, stops) {
  return (orders?.length || 0) > 0 || (stops?.length || 0) > 0;
}

// ---------- Core (STATE-ONLY + consistency) ----------
export async function reconcileStateOnly(id, ctx) {
  const { withDb, withRpc } = ctx;
  const out = { id, patched:0, executed:0, stops:0, removed:0, skipped:0, missingDb:0, rpcFailed:0, reason:'' };

  // 1) Lecture on-chain (state only)
  let chainState;
  try {
    chainState = Number(await withRpc(() => contract.stateOf(id)));
  } catch (e) {
    out.rpcFailed=1; out.reason = e?.shortMessage || e?.message || 'rpc error';
    return out;
  }

  // 2) Lecture DB + buckets
  const db = await readDbRow(id, withDb);
  if (!db) {
    out.missingDb=1; out.reason='db-missing';
    return out;
  }
  const { orders, stops } = await readBucketsByPosition(id, withDb);

  // 3) États différents → logique habituelle
  if (db.state !== chainState) {
    // 0 -> 1
    if (db.state === 0 && chainState === 1) {
      const entryX6 = db.entry_x6 !== 0n ? db.entry_x6 : (db.target_x6 !== 0n ? db.target_x6 : 0n);
      try {
        if (entryX6 !== 0n) {
          await withDb(() => handleExecutedEvent({ id, entryX6 }));
          out.executed++;
        } else {
          await patchDbState(id, 1, withDb);
          out.patched++;
        }
        if (db.sl_x6 !== 0n || db.tp_x6 !== 0n) {
          await withDb(() => handleStopsUpdatedEvent({ id, slX6: db.sl_x6, tpX6: db.tp_x6 }));
          out.stops++;
        }
        out.reason = 'order->open (executed + stops if any)';
        return out;
      } catch (e) {
        out.rpcFailed=1; out.reason = e?.message || String(e);
        return out;
      }
    }

    // 1 -> 2/3
    if (db.state === 1 && (chainState === 2 || chainState === 3)) {
      try {
        await withDb(() => handleRemovedEvent({ id, reason: chainState===3 ? 0 : 1, execX6: 0, pnlUsd6: 0 }));
        if (chainState === 3) await patchDbState(id, 3, withDb);
        out.removed++; out.reason = chainState===3 ? 'open->cancelled (clean indexes)' : 'open->closed (clean indexes)';
        return out;
      } catch (e) {
        out.rpcFailed=1; out.reason = e?.message || String(e);
        return out;
      }
    }

    // sinon: patch minimal
    try {
      await patchDbState(id, chainState, withDb);
      out.patched=1; out.reason=`patched ${db.state} -> ${chainState}`;
    } catch (e) {
      out.rpcFailed=1; out.reason = e?.message || String(e);
    }
    return out;
  }

  // 4) États égaux → CONSISTENCY CHECKS
  // state 2/3 → aucun index résiduel (ORDER/SL/TP/LIQ)
  if (chainState === 2 || chainState === 3) {
    if (hasAnyIndex(orders, stops)) {
      try {
        await withDb(() => handleRemovedEvent({ id, reason: chainState===3 ? 0 : 1, execX6: 0, pnlUsd6: 0 }));
        if (chainState === 3) await patchDbState(id, 3, withDb); // par sûreté
        out.removed++; out.reason = 'closed/cancelled but had indexes → cleaned';
      } catch (e) {
        out.rpcFailed=1; out.reason = e?.message || String(e);
      }
      return out;
    }
    out.skipped=1; out.reason='in-sync (closed/cancelled, no indexes)';
    return out;
  }

  // state 0 → ORDER doit être indexé correctement
  if (chainState === 0) {
    if (!orderIndexedEqual(orders, { lots: db.lots, long_side: db.long_side })) {
      try {
        await withDb(() => upsertOpenedEvent({
          id,
          state: 0,
          asset: db.asset_id,
          longSide: db.long_side,
          lots: db.lots,
          entryOrTargetX6: db.target_x6, // pour ORDER c'est target
          slX6: db.sl_x6,
          tpX6: db.tp_x6,
          liqX6: db.liq_x6,
          trader: db.trader_addr,
          leverageX: db.leverage_x
        }));
        out.executed++; // on compte comme correction d’index (pas un vrai execute)
        out.reason = 'order indexed (fixed)';
      } catch (e) {
        out.rpcFailed=1; out.reason = e?.message || String(e);
      }
      return out;
    }
    out.skipped=1; out.reason='in-sync (order indexed)';
    return out;
  }

  // state 1 → pas d’ORDER, et SL/TP présents si non nuls
  if (chainState === 1) {
    // a) ORDER persistant ?
    if ((orders?.length || 0) > 0) {
      const entryX6 = db.entry_x6 !== 0n ? db.entry_x6 : (db.target_x6 !== 0n ? db.target_x6 : 0n);
      try {
        if (entryX6 !== 0n) {
          await withDb(() => handleExecutedEvent({ id, entryX6 }));
        } else {
          // fallback minimal : patch state=1 (devrait être déjà 1) pour déclencher une ré-index éventuelle côté handlers
          await patchDbState(id, 1, withDb);
        }
        out.executed++; out.reason = 'open had lingering ORDER → cleaned via executed';
        return out;
      } catch (e) {
        out.rpcFailed=1; out.reason = e?.message || String(e);
        return out;
      }
    }
    // b) SL/TP requis présents ?
    if (!stopsIndexedOkForOpen(stops, db)) {
      try {
        // on ne peut gérer que SL/TP via handleStopsUpdatedEvent (LIQ souvent géré ailleurs)
        await withDb(() => handleStopsUpdatedEvent({ id, slX6: db.sl_x6, tpX6: db.tp_x6 }));
        out.stops++; out.reason = 'open stops (SL/TP) fixed';
      } catch (e) {
        out.rpcFailed=1; out.reason = e?.message || String(e);
      }
      return out;
    }
    out.skipped=1; out.reason='in-sync (open: no order, stops ok)';
    return out;
  }

  // fallback
  out.skipped=1; out.reason='in-sync';
  return out;
}

// ---------- Runner réutilisable (API /verify/:ids) ----------
export async function runManualState(ids, {
  dbConcurrency  = Number(process.env.DB_CONC  ?? 500),
  rpcConcurrency = Number(process.env.RPC_CONC ?? 100),
  workers,           // optionnel, def = min(ids.length, dbConc)
  suppressLogs = false
} = {}) {
  const ctx = makeCtx({ dbConcurrency, rpcConcurrency });
  const W = Math.min(ids.length || 1, Number(workers ?? dbConcurrency));

  const acc = { scanned:0, patched:0, executed:0, stops:0, removed:0, skipped:0, missingDb:0, rpcFailed:0 };
  let idx = 0;

  async function workerMain(wid) {
    while (true) {
      const i = idx++;
      if (i >= ids.length) return;
      const id = ids[i];
      const r = await reconcileStateOnly(id, ctx);
      acc.scanned++;
      acc.patched   += r.patched   || 0;
      acc.executed  += r.executed  || 0;
      acc.stops     += r.stops     || 0;
      acc.removed   += r.removed   || 0;
      acc.skipped   += r.skipped   || 0;
      acc.missingDb += r.missingDb || 0;
      acc.rpcFailed += r.rpcFailed || 0;
      if (!suppressLogs) L(TAG, `worker=${wid} id=${id} -> ${JSON.stringify(r)}`);
    }
  }

  await Promise.all(Array.from({ length: W }, (_, i) => workerMain(i)));

  if (!suppressLogs) {
    L(TAG, `Done. scanned=${acc.scanned} patched=${acc.patched} executed=${acc.executed} stops=${acc.stops} removed=${acc.removed} skipped=${acc.skipped} missingDb=${acc.missingDb} rpcFailed=${acc.rpcFailed}`);
  }
  return acc;
}

// ---------- CLI wrapper ----------
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v='true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
  return [k, v];
}));
function buildIdsFromFlags(f) {
  if (f.ids) {
    return String(f.ids)
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n >= 0);
  }
  const END   = Number(f.end ?? NaN);
  const COUNT = Math.max(1, Math.min(Number(f.count ?? 100), 50000));
  if (!Number.isInteger(END) || END < 0) {
    console.error('Usage: node src/manual_state.js --end=<uint32> [--count=100]  |  --ids=1,2,3');
    process.exit(1);
  }
  const START = Math.max(0, END - COUNT + 1);
  return Array.from({ length: END - START + 1 }, (_, i) => START + i);
}
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const ids = buildIdsFromFlags(flags);
  const dbConc  = Number(flags.dbConcurrency  ?? flags.db_concurrency  ?? process.env.DB_CONC  ?? 500);
  const rpcConc = Number(flags.rpcConcurrency ?? flags.rpc_concurrency ?? process.env.RPC_CONC ?? 100);
  const workers = flags.workers ? Number(flags.workers) : undefined;

  L(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDR}`);
  L(TAG, `${flags.ids ? 'MODE=list' : 'MODE=range'} | ids=${ids.length} | dbConc=${dbConc} rpcConc=${rpcConc} workers=${Math.min(ids.length || 1, Number(workers ?? dbConc))}`);

  runManualState(ids, { dbConcurrency: dbConc, rpcConcurrency: rpcConc, workers })
    .then(() => process.exit(0))
    .catch(err => { E(TAG, err?.message || err); process.exit(1); });
}

