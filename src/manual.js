// ======================================================================
// BROKEX • manual reconcile (concurrency: DB / RPC limits)
// Modes :
//   node src/manual.js --end=700 --count=100
//   node src/manual.js --ids=620,621,700
// Optional flags:
//   --dbConcurrency=500  --rpcConcurrency=100  --workers=500
// ======================================================================

import 'dotenv/config';
import { ethers } from 'ethers';
import { ABI } from './shared/abi.js';
import { logInfo as L, logErr as E } from './shared/logger.js';

// Handlers DB existants (comme tes scripts d’events)
import {
  upsertOpenedEvent,
  handleExecutedEvent,
  handleStopsUpdatedEvent,
  handleRemovedEvent
} from './shared/db.js';

// Accès lecture PostgREST pour comparer DB vs chain
import { get as pgGet, patch as pgPatch } from './shared/rest.js';

// ---------- ENV / CONCURRENCY ----------
const RPC_URL       = (process.env.RPC_URL || process.env.RPC_HTTP || '').trim();
const CONTRACT_ADDR = (process.env.CONTRACT_ADDR || '').trim();
if (!RPC_URL)       throw new Error('RPC_URL manquant dans .env');
if (!CONTRACT_ADDR) throw new Error('CONTRACT_ADDR manquant dans .env');

const TAG = 'Manual';

// concurrency defaults (overridable via flags or env)
const DEFAULT_DB_CONC  = Number(process.env.DB_CONC || 500);
const DEFAULT_RPC_CONC = Number(process.env.RPC_CONC || 100);

// ---------- ETHERS (HTTP RPC) ----------
const iface    = new ethers.Interface(ABI.Getters);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDR, iface, provider);

// ---------- Utils ----------
const BI   = (x) => BigInt(x ?? 0);
const eqBI = (a,b) => BI(a) === BI(b);
const toU  = (x) => Number(x ?? 0);

const flagsToLong = (flags) => (Number(flags) & 1) === 1; // bit0 = longSide

// ---------- Simple Semaphore (acquire -> release) ----------
class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Math.floor(max));
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      let released = false;
      return () => { if (!released) { released = true; this.current--; this._next(); } };
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.current++;
        let released = false;
        resolve(() => { if (!released) { released = true; this.current--; this._next(); } });
      });
    });
  }
  _next() {
    if (this.queue.length && this.current < this.max) {
      const next = this.queue.shift();
      next();
    }
  }
}

// ---------- Create semaphores (values overridden later from flags) ----------
let DB_CONC = DEFAULT_DB_CONC;
let RPC_CONC = DEFAULT_RPC_CONC;
let WORKERS; // number of parallel id workers (set later)

const dbSem = new Semaphore(DB_CONC);
const rpcSem = new Semaphore(RPC_CONC);

// Helper wrappers that run a function under semaphore control
async function withDb(fn) {
  const release = await dbSem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

async function withRpc(fn) {
  const release = await rpcSem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------- DB wrappers (use withDb when calling) ----------
async function readDb(id) {
  return withDb(() => pgGet(`positions?id=eq.${id}`).then(rows => rows?.[0] || null));
}

async function readBuckets(id) {
  return withDb(() => Promise.all([
    pgGet(`order_buckets?position_id=eq.${id}`),
    pgGet(`stop_buckets?position_id=eq.${id}`)
  ]).then(([orders, stops]) => ({ orders: orders || [], stops: stops || [] })));
}

// NOTE: all calls that modify DB or call handlers must use withDb wrapper
async function runUpsertOpenedEvent(obj) {
  return withDb(() => upsertOpenedEvent(obj));
}
async function runHandleExecutedEvent(obj) {
  return withDb(() => handleExecutedEvent(obj));
}
async function runHandleStopsUpdatedEvent(obj) {
  return withDb(() => handleStopsUpdatedEvent(obj));
}
async function runHandleRemovedEvent(obj) {
  return withDb(() => handleRemovedEvent(obj));
}
async function runPgPatch(path, body) {
  return withDb(() => pgPatch(path, body));
}

// ---------- Equality helpers (unchanged) ----------
function dbAndChainEqualOrder(db, chain) {
  return (
    Number(db?.state) === 0 &&
    eqBI(db?.target_x6, chain.targetX6) &&
    Number(db?.asset_id)   === Number(chain.asset) &&
    Number(db?.lots)       === Number(chain.lots) &&
    Number(db?.leverage_x) === Number(chain.leverageX) &&
    Boolean(db?.long_side) === Boolean(chain.longSide)
  );
}
function dbAndChainEqualOpen(db, chain) {
  return (
    Number(db?.state) === 1 &&
    eqBI(db?.entry_x6, chain.entryX6) &&
    eqBI(db?.sl_x6,    chain.slX6) &&
    eqBI(db?.tp_x6,    chain.tpX6) &&
    eqBI(db?.liq_x6,   chain.liqX6) &&
    Number(db?.asset_id)   === Number(chain.asset) &&
    Number(db?.lots)       === Number(chain.lots) &&
    Number(db?.leverage_x) === Number(chain.leverageX) &&
    Boolean(db?.long_side) === Boolean(chain.longSide)
  );
}
function stopsIndexedEqual(haveStops, { asset_id, sl_x6, tp_x6, liq_x6, lots, long_side }) {
  const wanted = [];
  if (BI(sl_x6)  !== 0n) wanted.push({ type: 1, px: BI(sl_x6)  });
  if (BI(tp_x6)  !== 0n) wanted.push({ type: 2, px: BI(tp_x6)  });
  if (BI(liq_x6) !== 0n) wanted.push({ type: 3, px: BI(liq_x6) });

  const side = !Boolean(long_side);
  if (haveStops.length !== wanted.length) return false;
  for (const w of wanted) {
    const m = haveStops.find(r =>
      Number(r.stop_type) === Number(w.type) &&
      Number(r.lots) === Number(lots) &&
      Boolean(r.side) === side
    );
    if (!m) return false;
  }
  return true;
}
function orderIndexedEqual(haveOrders, { lots, long_side }) {
  if (haveOrders.length !== 1) return false;
  const o = haveOrders[0];
  return Number(o.lots) === Number(lots) && Boolean(o.side) === Boolean(long_side);
}

// ---------- Reconcil per id (uses withRpc / withDb wrappers) ----------
async function reconcileId(id) {
  let changed = { created:0, executed:0, stops:0, removed:0, statePatched:0, skipped:0 };

  // 1) chain (limit concurrent RPC calls)
  let state, t;
  try {
    state = Number(await withRpc(() => contract.stateOf(id)));
    t = await withRpc(() => contract.getTrade(id));
  } catch (err) {
    E(TAG, `id=${id} read chain failed:`, err?.shortMessage || err?.message || err);
    changed.skipped++; return changed;
  }

  if (!t?.owner || String(t.owner).toLowerCase() === '0x0000000000000000000000000000000000000000') {
    changed.skipped++; return changed;
  }

  const chain = {
    state,
    owner: String(t.owner),
    asset: toU(t.asset),
    lots: toU(t.lots),
    leverageX: toU(t.leverageX),
    marginUsd6: toU(t.marginUsd6),
    entryX6: toU(t.entryX6),
    targetX6: toU(t.targetX6),
    slX6: toU(t.slX6),
    tpX6: toU(t.tpX6),
    liqX6: toU(t.liqX6),
    longSide: flagsToLong(toU(t.flags))
  };

  // 2) db (wrapped)
  const db = await readDb(id);

  // 3) Routes selon state on-chain
  if (state === 0) {
    // ============ ORDER ============
    if (!db || !dbAndChainEqualOrder(db, chain)) {
      await runUpsertOpenedEvent({
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
      });
      changed.created++;
    } else {
      const { orders } = await readBuckets(id);
      if (!orderIndexedEqual(orders, { lots: db.lots, long_side: db.long_side })) {
        await runUpsertOpenedEvent({
          id,
          state: 0,
          asset: db.asset_id,
          longSide: db.long_side,
          lots: db.lots,
          entryOrTargetX6: db.target_x6,
          slX6: db.sl_x6,
          tpX6: db.tp_x6,
          liqX6: db.liq_x6,
          trader: db.trader_addr,
          leverageX: db.leverage_x
        });
        changed.created++;
      } else {
        changed.skipped++;
      }
    }
  } else if (state === 1) {
    // ============ OPEN ============
    if (!db) {
      await runUpsertOpenedEvent({
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
      });
      changed.created++;
    } else if (Number(db.state) === 0) {
      if (!eqBI(db.entry_x6, chain.entryX6)) {
        await runHandleExecutedEvent({ id, entryX6: chain.entryX6 });
        changed.executed++;
      }
      const { stops } = await readBuckets(id);
      if (!stopsIndexedEqual(stops, {
        asset_id: db.asset_id, sl_x6: chain.slX6, tp_x6: chain.tpX6, liq_x6: chain.liqX6,
        lots: db.lots, long_side: db.long_side
      })) {
        await runHandleStopsUpdatedEvent({ id, slX6: chain.slX6, tpX6: chain.tpX6 });
        changed.stops++;
      }
    } else {
      let touched = false;
      if (!dbAndChainEqualOpen(db, chain)) {
        if (!eqBI(db.entry_x6, chain.entryX6)) {
          await runHandleExecutedEvent({ id, entryX6: chain.entryX6 });
          touched = true; changed.executed++;
        }
        const { stops } = await readBuckets(id);
        if (!stopsIndexedEqual(stops, {
          asset_id: db.asset_id, sl_x6: chain.slX6, tp_x6: chain.tpX6, liq_x6: chain.liqX6,
          lots: db.lots, long_side: db.long_side
        })) {
          await runHandleStopsUpdatedEvent({ id, slX6: chain.slX6, tpX6: chain.tpX6 });
          touched = true; changed.stops++;
        }
        if (Number(db.state) !== 1) {
          await runPgPatch(`positions?id=eq.${id}`, { state: 1 });
          changed.statePatched++;
          touched = true;
        }
      }
      if (!touched) changed.skipped++;
    }
  } else if (state === 2 || state === 3) {
    const needRemoved = !db || Number(db.state) !== 2 || (state === 3 && Number(db.state) !== 3);
    if (needRemoved) {
      await runHandleRemovedEvent({ id, reason: state === 3 ? 0 : 1, execX6: 0, pnlUsd6: 0 });
      if (state === 3) {
        await runPgPatch(`positions?id=eq.${id}`, { state: 3 });
      }
      changed.removed++;
    } else {
      changed.skipped++;
    }
  } else {
    changed.skipped++;
  }

  return changed;
}

// ---------- CLI ----------
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
  return [k, v];
}));

// parse concurrency overrides
DB_CONC = Number(flags.dbConcurrency ?? flags.db_concurrency ?? DB_CONC);
RPC_CONC = Number(flags.rpcConcurrency ?? flags.rpc_concurrency ?? RPC_CONC);
const explicitWorkers = flags.workers ? Number(flags.workers) : undefined;

// re-create semaphores with actual values (in case overridden)
dbSem.max = Math.max(1, Math.floor(DB_CONC));
rpcSem.max = Math.max(1, Math.floor(RPC_CONC));

let ids = [];
if (flags.ids) {
  ids = String(flags.ids).split(',').map(s=>Number(s.trim())).filter(n=>Number.isInteger(n) && n>=0);
} else {
  const END   = Number(flags.end ?? NaN);
  const COUNT = Math.max(1, Math.min(Number(flags.count ?? 100), 5000));
  if (!Number.isInteger(END) || END < 0) {
    console.error('Usage: node src/manual.js --end=<uint32> [--count=100]  |  --ids=1,2,3');
    process.exit(1);
  }
  const START = Math.max(0, END - COUNT + 1);
  ids = Array.from({length: END - START + 1}, (_,i)=> START + i);
}

WORKERS = explicitWorkers ? Math.max(1, explicitWorkers) : Math.min(ids.length || 1, Math.max(1, DB_CONC));

// log
L(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDR}`);
L(TAG, `${flags.ids ? 'MODE=list' : 'MODE=range'} | ids=${ids.length} | dbConc=${DB_CONC} rpcConc=${RPC_CONC} workers=${WORKERS}`);

// ---------- Worker pool runner ----------
(async () => {
  const acc = { created:0, executed:0, stops:0, removed:0, statePatched:0, skipped:0 };
  let idx = 0;

  async function workerMain(workerId) {
    while (true) {
      const i = idx++;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        const r = await reconcileId(id);
        for (const k of Object.keys(acc)) acc[k] += r[k] || 0;
        L(TAG, `worker=${workerId} processed id=${id} -> ${JSON.stringify(r)}`);
      } catch (err) {
        E(TAG, `id=${id} failed:`, err?.message || err);
      }
    }
  }

  // spawn workers
  const workers = Array.from({length: WORKERS}, (_,i) => workerMain(i));
  await Promise.all(workers);

  L(TAG, `Done. scanned=${ids.length} created=${acc.created} executed=${acc.executed} stops=${acc.stops} removed=${acc.removed} statePatched=${acc.statePatched} skipped=${acc.skipped}`);
})().catch(err => { E(TAG, err?.message || err); process.exit(1); });

