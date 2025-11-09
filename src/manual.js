// src/manual.js — Réconcilier DB <-> On-chain (ORDER / OPEN / CLOSED / CANCELLED)
import 'dotenv/config';
import { ethers } from 'ethers';
import { setTimeout as sleep } from 'node:timers/promises';

import { ABI } from './shared/abi.js';
import { logInfo, logErr } from './shared/logger.js';
import { get, postArray, patch, del } from './shared/rest.js';
import { upsertOpenedEvent } from './shared/db.js';

const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDR || '').trim();
// accepte soit RPC_HTTP soit RPC_URL
const RPC_URL = (process.env.RPC_HTTP || process.env.RPC_URL || '').trim();

if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDR manquant dans .env');
if (!RPC_URL)          throw new Error('RPC_HTTP/RPC_URL manquant dans .env');

const TAG = 'Manual';

/* ============================
   CLI flags
============================ */
const flags = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
    return [k, v];
  })
);

const MODE = (flags.mode || 'full'); // 'full' | 'state' | 'stops'
const MAX_PAR = Math.max(1, Math.min(Number(flags.par ?? 100), 1000));
const SLEEP_BETWEEN_BATCH_MS = 25;

let ids = [];
if (flags.ids) {
  ids = String(flags.ids)
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 0);
} else {
  const END  = Number(flags.end ?? NaN);
  const CNT  = Math.max(1, Math.min(Number(flags.count ?? 100), 5000));
  if (!Number.isInteger(END) || END < 0) {
    console.error('Usage:\n  node src/manual.js --end=<uint32> --count=<N> [--mode=full|state|stops] [--par=100]\n       ou\n  node src/manual.js --ids=99,80,400,8300 [--mode=…] [--par=…]');
    process.exit(1);
  }
  const START = Math.max(0, END - CNT + 1);
  ids = Array.from({ length: END - START + 1 }, (_, i) => START + i);
}

/* ============================
   Concurrency helpers
============================ */
async function runWithConcurrency(tasks, max) {
  const res = new Array(tasks.length);
  let i = 0, running = 0;
  return new Promise(resolve => {
    const launch = () => {
      while (running < max && i < tasks.length) {
        const idx = i++;
        running++;
        tasks[idx]()
          .then(v => { res[idx] = { ok: true, v }; })
          .catch(e => { res[idx] = { ok: false, e }; })
          .finally(() => {
            running--;
            if (i < tasks.length) launch();
            else if (running === 0) resolve(res);
          });
      }
    };
    launch();
  });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ============================
   Normalisation & utils
============================ */
function ensureStr(x) {
  if (typeof x === 'bigint') return x.toString();
  if (x === null || x === undefined) return '0';
  return String(x);
}
function norm0(x) {
  if (x === null || x === undefined) return '0';
  return String(x);
}
function eq0(a, b) {
  return norm0(a) === norm0(b);
}

function tradeLooksValid(t) {
  const owner = (t?.owner || '').toLowerCase();
  try {
    const margin = BigInt(String(t?.marginUsd6 ?? '0'));
    return (
      owner &&
      owner !== '0x0000000000000000000000000000000000000000' &&
      (Number(t?.asset || 0) > 0 || Number(t?.lots || 0) > 0 || margin > 0n)
    );
  } catch { return false; }
}

/* ============================
   DB helpers (REST)
============================ */
async function fetchDBPos(id) {
  const rows = await get(`positions?id=eq.${id}&select=id,state,asset_id,trader_addr,long_side,lots,leverage_x,entry_x6,target_x6,sl_x6,tp_x6,liq_x6`);
  return rows?.[0] || null;
}
async function clearAllIndexes(id) {
  await del(`order_buckets?position_id=eq.${id}`);
  await del(`stop_buckets?position_id=eq.${id}`);
}
async function reindexAsOrderFromOnChain(id, t) {
  const entryOrTargetX6 = (t.targetX6 && t.targetX6 !== 0n) ? t.targetX6 : t.entryX6;
  await del(`stop_buckets?position_id=eq.${id}`);
  await upsertOpenedEvent({
    id,
    state: 0,
    asset: Number(t.asset),
    longSide: (Number(t.flags) & 1) === 1,
    lots: Number(t.lots),
    entryOrTargetX6: ensureStr(entryOrTargetX6),
    slX6: '0',
    tpX6: '0',
    liqX6: '0',
    trader: String(t.owner),
    leverageX: Number(t.leverageX)
  });
}
async function reindexAsOpenFromOnChain(id, t) {
  await del(`order_buckets?position_id=eq.${id}`);
  await del(`stop_buckets?position_id=eq.${id}`);
  await upsertOpenedEvent({
    id,
    state: 1,
    asset: Number(t.asset),
    longSide: (Number(t.flags) & 1) === 1,
    lots: Number(t.lots),
    entryOrTargetX6: ensureStr(t.entryX6),
    slX6: ensureStr(t.slX6),
    tpX6: ensureStr(t.tpX6),
    liqX6: ensureStr(t.liqX6),
    trader: String(t.owner),
    leverageX: Number(t.leverageX)
  });
}
async function closeOrCancelInDB(id, state /*2|3*/) {
  await patch(`positions?id=eq.${id}`, { state: Number(state) });
  // on NE TOUCHE PAS aux index “trader”, on nettoie seulement order/stop
  await clearAllIndexes(id);
}

function wantStateFix() { return MODE === 'full' || MODE === 'state'; }
function wantStopsFix() { return MODE === 'full' || MODE === 'stops'; }

/* ============================
   ABI lecture
   - On réutilise ABI.State (stateOf)
   - On ajoute une signature minimaliste de getTrade(...)
============================ */
const READ_ABI = [
  ...(ABI.State || []),
  // Adapte si ton contrat diffère – structure attendue par le code ci-dessous:
  // asset(uint32), lots(uint16), leverageX(uint16), entryX6(int64), targetX6(int64),
  // slX6(int64), tpX6(int64), liqX6(int64), owner(address), flags(uint8)
  'function getTrade(uint32 id) view returns (tuple(uint32 asset,uint16 lots,uint16 leverageX,int64 entryX6,int64 targetX6,int64 slX6,int64 tpX6,int64 liqX6,address owner,uint8 flags))'
];

/* ============================
   Main
============================ */
(async function main() {
  logInfo(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDRESS}`);
  logInfo(TAG, `MODE=${MODE} | ids=${ids.length} | PAR=${MAX_PAR}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, READ_ABI, provider);

  let scanned = 0, created = 0, fixedState = 0, fixedIdx = 0, closed = 0, skipped = 0;

  // On batch par 500 ids pour garder les logs lisibles
  const batches = chunk(ids, 500);

  for (const group of batches) {
    const tasks = group.map((id) => async () => {
      try {
        // 1) RPC: on lit en parallèle l’état + la struct
        const [t, stRaw] = await Promise.all([
          contract.getTrade(id),
          contract.stateOf(id).catch(() => 0)
        ]);
        scanned++;
        if (!tradeLooksValid(t)) { skipped++; return; }

        const chainState = Number(stRaw) | 0; // 0=ORDER,1=OPEN,2=CLOSED,3=CANCELLED
        const db = await fetchDBPos(id);

        // 2) Absent en DB -> créer selon l’état
        if (!db) {
          if (chainState === 0) { await reindexAsOrderFromOnChain(id, t); created++; return; }
          if (chainState === 1) { await reindexAsOpenFromOnChain(id, t);  created++; return; }
          // CLOSED/CANCELLED -> créer “vide” + état, pas d’index
          await patch(`positions?id=eq.${id}`, { state: chainState }).catch(async () => {
            await upsertOpenedEvent({
              id,
              state: 0,
              asset: Number(t.asset),
              longSide: (Number(t.flags) & 1) === 1,
              lots: Number(t.lots),
              entryOrTargetX6: '0',
              slX6: '0', tpX6: '0', liqX6: '0',
              trader: String(t.owner),
              leverageX: Number(t.leverageX)
            });
            await closeOrCancelInDB(id, chainState);
          });
          closed++;
          return;
        }

        // 3) Présent en DB -> réconciliation
        const dbState = Number(db.state);

        // -- ÉTAT --
        if (wantStateFix() && dbState !== chainState) {
          if (chainState === 0)       { await reindexAsOrderFromOnChain(id, t); fixedState++; return; }
          else if (chainState === 1)  { await reindexAsOpenFromOnChain(id, t);  fixedState++; return; }
          else                        { await closeOrCancelInDB(id, chainState); closed++;    return; }
        }

        // -- STOPS/ORDER si état identique --
        if (!wantStopsFix()) return;

        if (chainState === 0) {
          const chainTarget = (t.targetX6 && t.targetX6 !== 0n) ? ensureStr(t.targetX6) : ensureStr(t.entryX6);
          const dbTarget   = norm0(db.target_x6);
          const needFix    = !eq0(dbTarget, chainTarget)
                           || Number(db.asset_id) !== Number(t.asset)
                           || Boolean(db.long_side) !== ((Number(t.flags)&1)===1)
                           || Number(db.lots) !== Number(t.lots);
          if (needFix) { await reindexAsOrderFromOnChain(id, t); fixedIdx++; }
        } else if (chainState === 1) {
          const needFix =
            !eq0(db.entry_x6, t.entryX6) ||
            !eq0(db.sl_x6,    t.slX6)    ||
            !eq0(db.tp_x6,    t.tpX6)    ||
            !eq0(db.liq_x6,   t.liqX6)   ||
            Number(db.asset_id) !== Number(t.asset) ||
            Boolean(db.long_side) !== ((Number(t.flags)&1)===1) ||
            Number(db.lots) !== Number(t.lots);

          if (needFix) { await reindexAsOpenFromOnChain(id, t); fixedIdx++; }
        } else {
          // CLOSED/CANCELLED: on nettoie les index de prix (pas l'index trader)
          await clearAllIndexes(id);
        }

      } catch (e) {
        logErr(TAG, `id=${id} -> ${e?.shortMessage || e?.message || String(e)}`);
      }
    });

    await runWithConcurrency(tasks, Math.min(MAX_PAR, tasks.length));
    await sleep(SLEEP_BETWEEN_BATCH_MS);
  }

  logInfo(TAG, `Done. scanned=${scanned} created=${created} fixedState=${fixedState} fixedIdx=${fixedIdx} closed=${closed} skipped=${skipped}`);
})().catch((e) => {
  logErr(TAG, e?.message || e);
  process.exit(1);
});


