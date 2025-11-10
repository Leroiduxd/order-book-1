// ======================================================================
// BROKEX • manual_backfill (DB-missing → hydrate from chain)
// - Scanne un range OU une liste d’IDs
// - Si l'ID existe déjà en DB: SKIP
// - Sinon: lit stateOf + getTrade, puis:
//     state=0 (ORDER)   -> upsertOpenedEvent(state:0)          (+index LIMIT via handler)
//     state=1 (OPEN)    -> upsertOpenedEvent(state:1)          (+index SL/TP via handler)
//     state=2/3 (CLOSE/CANCEL) -> handleRemovedEvent           (puis patch state=3 si besoin)
// - Concurrence: DB=500, RPC=100 (overridable)
// Usage:
//   node src/manual_backfill.js --end=1200 --count=100
//   node src/manual_backfill.js --ids=905,906,940
//   node src/manual_backfill.js --end=5000 --count=1000 --dbConcurrency=500 --rpcConcurrency=100 --workers=300
// ======================================================================

import 'dotenv/config';
import { ethers } from 'ethers';
import { ABI } from './shared/abi.js';
import { logInfo as L, logErr as E } from './shared/logger.js';
import { get as pgGet, patch as pgPatch } from './shared/rest.js';
import {
  upsertOpenedEvent,
  handleStopsUpdatedEvent,
  handleExecutedEvent,
  handleRemovedEvent
} from './shared/db.js';

// ---------- ENV ----------
const RPC_URL       = (process.env.RPC_URL || process.env.RPC_HTTP || '').trim();
const CONTRACT_ADDR = (process.env.CONTRACT_ADDR || '').trim();
if (!RPC_URL)       throw new Error('RPC_URL manquant dans .env');
if (!CONTRACT_ADDR) throw new Error('CONTRACT_ADDR manquant dans .env');

const TAG = 'ManualBackfill';

// ---------- ETHERS ----------
const iface    = new ethers.Interface(ABI.Getters);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDR, iface, provider);

// ---------- Concurrency ----------
class Semaphore {
  constructor(max) { this.max=Math.max(1, max|0); this.cur=0; this.q=[]; }
  async acquire(){
    if (this.cur < this.max) { this.cur++; let rel=false; return ()=>{ if(!rel){rel=true; this.cur--; this._next(); }}; }
    return new Promise(res => this.q.push(() => { this.cur++; let rel=false; res(()=>{ if(!rel){rel=true; this.cur--; this._next(); }}); }));
  }
  _next(){ if (this.q.length && this.cur < this.max) this.q.shift()(); }
}
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v='true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
  return [k, v];
}));
const DB_CONC  = Number(flags.dbConcurrency  ?? flags.db_concurrency  ?? process.env.DB_CONC  ?? 500);
const RPC_CONC = Number(flags.rpcConcurrency ?? flags.rpc_concurrency ?? process.env.RPC_CONC ?? 100);
const dbSem  = new Semaphore(DB_CONC);
const rpcSem = new Semaphore(RPC_CONC);
const withDb  = async fn => { const r = await dbSem.acquire();  try { return await fn(); } finally { r(); } };
const withRpc = async fn => { const r = await rpcSem.acquire(); try { return await fn(); } finally { r(); } };

// ---------- Utils ----------
const toU = (x)=> Number(x ?? 0);
const isZeroAddr = (a)=> !a || String(a).toLowerCase() === '0x0000000000000000000000000000000000000000';

// ---------- DB helpers ----------
async function dbHasPosition(id){
  return withDb(async ()=>{
    const row = (await pgGet(`positions?id=eq.${id}&select=id`))?.[0];
    return !!row;
  });
}
async function patchState3IfNeeded(id, chainState){
  if (chainState === 3) {
    await withDb(()=> pgPatch(`positions?id=eq.${id}`, { state: 3 }));
  }
}

// ---------- Core: hydrate ONE id if missing ----------
async function hydrateIfMissing(id){
  const out = { id, createdOrder:0, createdOpen:0, executed:0, stops:0, removed:0, skipped:0, ownerZero:0, rpcFailed:0, reason:'' };

  // 1) existe déjà en DB ?
  if (await dbHasPosition(id)) {
    out.skipped=1; out.reason='already-in-db';
    return out;
  }

  // 2) lecture chaîne
  let state, t;
  try {
    state = Number(await withRpc(()=> contract.stateOf(id)));
    t     = await withRpc(()=> contract.getTrade(id));
  } catch (e) {
    out.rpcFailed=1; out.reason = e?.shortMessage || e?.message || 'rpc error';
    return out;
  }
  if (!t || isZeroAddr(t.owner)) {
    out.ownerZero=1; out.reason='owner=0x0 (no trade on-chain)';
    return out;
  }

  const chain = {
    owner: String(t.owner),
    state,
    asset: toU(t.asset),
    lots: toU(t.lots),
    leverageX: toU(t.leverageX),
    entryX6:   toU(t.entryX6),
    targetX6:  toU(t.targetX6),
    slX6:      toU(t.slX6),
    tpX6:      toU(t.tpX6),
    liqX6:     toU(t.liqX6),
    longSide:  (toU(t.flags) & 1) === 1
  };

  // 3) Hydratation selon state
  if (state === 0) {
    // ORDER → on crée via upsertOpenedEvent(state:0)
    await withDb(()=> upsertOpenedEvent({
      id,
      state: 0,
      asset: chain.asset,
      longSide: chain.longSide,
      lots: chain.lots,
      entryOrTargetX6: chain.targetX6,
      slX6: chain.slX6,
      tpX6: chain.tpX6,
      liqX6: chain.liqX6,
      trader: chain.owner,
      leverageX: chain.leverageX
    }));
    out.createdOrder=1; out.reason='created-order';
    return out;
  }

  if (state === 1) {
    // OPEN → on crée via upsertOpenedEvent(state:1) + stops si non nuls
    await withDb(()=> upsertOpenedEvent({
      id,
      state: 1,
      asset: chain.asset,
      longSide: chain.longSide,
      lots: chain.lots,
      entryOrTargetX6: chain.entryX6,
      slX6: chain.slX6,
      tpX6: chain.tpX6,
      liqX6: chain.liqX6,
      trader: chain.owner,
      leverageX: chain.leverageX
    }));
    out.createdOpen=1;

    if (chain.slX6 || chain.tpX6) {
      await withDb(()=> handleStopsUpdatedEvent({ id, slX6: chain.slX6, tpX6: chain.tpX6 }));
      out.stops=1;
    }
    out.reason='created-open(+stops?)';
    return out;
  }

  if (state === 2 || state === 3) {
    // CLOSED/CANCELLED → on nettoie via removed (le handler met state=2); si 3, on patch state=3
    await withDb(()=> handleRemovedEvent({ id, reason: state===3 ? 0 : 1, execX6: 0, pnlUsd6: 0 }));
    await patchState3IfNeeded(id, state);
    out.removed=1; out.reason= (state===3 ? 'created-cancelled' : 'created-closed');
    return out;
  }

  // État inconnu → on s'abstient (pour éviter de créer des lignes incohérentes)
  out.skipped=1; out.reason=`unknown-state-${state}`;
  return out;
}

// ---------- Build ID list ----------
let ids = [];
if (flags.ids) {
  ids = String(flags.ids)
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n >= 0);
} else {
  const END   = Number(flags.end ?? NaN);
  const COUNT = Math.max(1, Math.min(Number(flags.count ?? 100), 50000));
  if (!Number.isInteger(END) || END < 0) {
    console.error('Usage: node src/manual_backfill.js --end=<uint32> [--count=100]  |  --ids=1,2,3');
    process.exit(1);
  }
  const START = Math.max(0, END - COUNT + 1);
  ids = Array.from({ length: END - START + 1 }, (_, i) => START + i);
}

const WORKERS = Math.min(ids.length || 1, Number(flags.workers ?? DB_CONC));

// ---------- Run ----------
L(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDR}`);
L(TAG, `${flags.ids ? 'MODE=list' : 'MODE=range'} | ids=${ids.length} | dbConc=${DB_CONC} rpcConc=${RPC_CONC} workers=${WORKERS}`);

(async () => {
  const acc = { scanned:0, createdOrder:0, createdOpen:0, executed:0, stops:0, removed:0, skipped:0, ownerZero:0, rpcFailed:0 };
  let idx = 0;

  async function workerMain(wid) {
    while (true) {
      const i = idx++;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        const r = await hydrateIfMissing(id);
        acc.scanned++;
        acc.createdOrder += r.createdOrder||0;
        acc.createdOpen  += r.createdOpen||0;
        acc.executed     += r.executed||0; // (garde pour métrique homogène)
        acc.stops        += r.stops||0;
        acc.removed      += r.removed||0;
        acc.skipped      += r.skipped||0;
        acc.ownerZero    += r.ownerZero||0;
        acc.rpcFailed    += r.rpcFailed||0;
        L(TAG, `worker=${wid} id=${id} -> ${JSON.stringify(r)}`);
      } catch (err) {
        E(TAG, `id=${id} failed:`, err?.message || err);
      }
    }
  }

  await Promise.all(Array.from({length: WORKERS}, (_,i) => workerMain(i)));
  L(TAG, `Done. scanned=${acc.scanned} createdOrder=${acc.createdOrder} createdOpen=${acc.createdOpen} stops=${acc.stops} removed=${acc.removed} skipped=${acc.skipped} ownerZero=${acc.ownerZero} rpcFailed=${acc.rpcFailed}`);
})().catch(err => { E(TAG, err?.message || err); process.exit(1); });
