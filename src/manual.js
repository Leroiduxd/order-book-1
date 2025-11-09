// ======================================================================
// BROKEX • manual reconcile (comme removed.js, via handlers DB)
// Modes :
//   node src/manual.js --end=700 --count=100
//   node src/manual.js --ids=620,621,700
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

// ---------- ENV ----------
const RPC_URL       = (process.env.RPC_URL || process.env.RPC_HTTP || '').trim();
const CONTRACT_ADDR = (process.env.CONTRACT_ADDR || '').trim();
if (!RPC_URL)       throw new Error('RPC_URL manquant dans .env');
if (!CONTRACT_ADDR) throw new Error('CONTRACT_ADDR manquant dans .env');

const TAG = 'Manual';

// ---------- ETHERS (HTTP RPC) ----------
const iface    = new ethers.Interface(ABI.Getters);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDR, iface, provider);

// ---------- Utils ----------
const BI   = (x) => BigInt(x ?? 0);
const eqBI = (a,b) => BI(a) === BI(b);
const toU  = (x) => Number(x ?? 0);

const flagsToLong = (flags) => (Number(flags) & 1) === 1; // bit0 = longSide

async function readDb(id) {
  const rows = await pgGet(`positions?id=eq.${id}`);
  return rows?.[0] || null;
}

async function readBuckets(id) {
  const [orders, stops] = await Promise.all([
    pgGet(`order_buckets?position_id=eq.${id}`),
    pgGet(`stop_buckets?position_id=eq.${id}`)
  ]);
  return { orders: orders || [], stops: stops || [] };
}

function dbAndChainEqualOrder(db, chain) {
  // target et basiques
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
  // entry + stops
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

// Détermine si les stops sont déjà indexés exactement (bucket/side/lots/type)
function stopsIndexedEqual(haveStops, { asset_id, sl_x6, tp_x6, liq_x6, lots, long_side }) {
  const wanted = [];
  if (BI(sl_x6)  !== 0n) wanted.push({ type: 1, px: BI(sl_x6)  });
  if (BI(tp_x6)  !== 0n) wanted.push({ type: 2, px: BI(tp_x6)  });
  if (BI(liq_x6) !== 0n) wanted.push({ type: 3, px: BI(liq_x6) });

  // le handler DB recalcule bucket côté SQL via price_to_bucket — on contrôle juste présence/type/lots/side
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
  // pareil : bucket est recalc côté SQL; on vérifie lots/side/unique
  if (haveOrders.length !== 1) return false;
  const o = haveOrders[0];
  return Number(o.lots) === Number(lots) && Boolean(o.side) === Boolean(long_side);
}

// ---------- Reconcil par ID (idempotent) ----------
async function reconcileId(id) {
  let changed = { created:0, executed:0, stops:0, removed:0, statePatched:0, skipped:0 };

  // 1) chain
  let state, t;
  try {
    state = Number(await contract.stateOf(id));
    t = await contract.getTrade(id);
  } catch (err) {
    E(TAG, `id=${id} read chain failed:`, err?.shortMessage || err?.message || err);
    changed.skipped++; return changed;
  }

  // owner null => rien à faire
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

  // 2) db
  const db = await readDb(id);

  // 3) Routes selon state on-chain
  if (state === 0) {
    // ============ ORDER ============
    if (!db || !dbAndChainEqualOrder(db, chain)) {
      await upsertOpenedEvent({
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
      // DB OK, mais vérifier bucket ORDER existant
      const { orders } = await readBuckets(id);
      if (!orderIndexedEqual(orders, { lots: db.lots, long_side: db.long_side })) {
        await upsertOpenedEvent({
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
      }
    }
  } else if (state === 1) {
    // ============ OPEN ============
    if (!db) {
      // pas en DB -> créer OPEN direct
      await upsertOpenedEvent({
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
      // transition ORDER->OPEN ⇒ faire comme Executed
      if (!eqBI(db.entry_x6, chain.entryX6)) {
        await handleExecutedEvent({ id, entryX6: chain.entryX6 });
        changed.executed++;
      }
      // et s’assurer des stops
      const { stops } = await readBuckets(id);
      if (!stopsIndexedEqual(stops, {
        asset_id: db.asset_id, sl_x6: chain.slX6, tp_x6: chain.tpX6, liq_x6: chain.liqX6,
        lots: db.lots, long_side: db.long_side
      })) {
        await handleStopsUpdatedEvent({ id, slX6: chain.slX6, tpX6: chain.tpX6 });
        changed.stops++;
      }
    } else {
      // déjà OPEN en DB : ne faire que si différences
      let touched = false;
      if (!dbAndChainEqualOpen(db, chain)) {
        // si entry diffère → simulate Executed minimal (évite reindex inutile si égal)
        if (!eqBI(db.entry_x6, chain.entryX6)) {
          await handleExecutedEvent({ id, entryX6: chain.entryX6 });
          touched = true; changed.executed++;
        }
        // stops diff ?
        const { stops } = await readBuckets(id);
        if (!stopsIndexedEqual(stops, {
          asset_id: db.asset_id, sl_x6: chain.slX6, tp_x6: chain.tpX6, liq_x6: chain.liqX6,
          lots: db.lots, long_side: db.long_side
        })) {
          await handleStopsUpdatedEvent({ id, slX6: chain.slX6, tpX6: chain.tpX6 });
          touched = true; changed.stops++;
        }
        // state mismatch (rare)
        if (Number(db.state) !== 1) {
          await pgPatch(`positions?id=eq.${id}`, { state: 1 });
          changed.statePatched++;
          touched = true;
        }
      }
      if (!touched) changed.skipped++;
    }
  } else if (state === 2 || state === 3) {
    // ============ CLOSED / CANCELLED ============
    // on ne retire JAMAIS l’appartenance au trader ; on nettoie juste les index prix
    // et on met à jour l’état si nécessaire
    const needRemoved = !db || Number(db.state) !== 2 || (state === 3 && Number(db.state) !== 3);
    if (needRemoved) {
      await handleRemovedEvent({ id, reason: state === 3 ? 0 : 1, execX6: 0, pnlUsd6: 0 }); // reason arbitraire
      // handleRemovedEvent met state=2 ; si réellement CANCELLED (3), on patch juste l’état
      if (state === 3) {
        await pgPatch(`positions?id=eq.${id}`, { state: 3 });
      }
      changed.removed++;
    } else {
      changed.skipped++;
    }
  } else {
    // états inconnus => no-op
    changed.skipped++;
  }

  return changed;
}

// ---------- CLI ----------
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
  return [k, v];
}));

let ids = [];
if (flags.ids) {
  ids = String(flags.ids).split(',').map(s=>Number(s.trim())).filter(n=>Number.isInteger(n) && n>=0);
} else {
  const END   = Number(flags.end ?? NaN);
  const COUNT = Math.max(1, Math.min(Number(flags.count ?? 100), 500));
  if (!Number.isInteger(END) || END < 0) {
    console.error('Usage: node src/manual.js --end=<uint32> [--count=100]  |  --ids=1,2,3');
    process.exit(1);
  }
  const START = Math.max(0, END - COUNT + 1);
  ids = Array.from({length: END - START + 1}, (_,i)=> START + i);
}

L(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDR}`);
L(TAG, `${flags.ids ? 'MODE=list' : 'MODE=range'} | ids=${ids.length}`);

(async () => {
  const acc = { created:0, executed:0, stops:0, removed:0, statePatched:0, skipped:0 };
  for (const id of ids) {
    try {
      const r = await reconcileId(id);
      for (const k of Object.keys(acc)) acc[k] += r[k] || 0;
    } catch (err) {
      E(TAG, `id=${id} failed:`, err?.message || err);
    }
  }
  L(TAG, `Done. scanned=${ids.length} created=${acc.created} executed=${acc.executed} stops=${acc.stops} removed=${acc.removed} statePatched=${acc.statePatched} skipped=${acc.skipped}`);
})().catch(err => { E(TAG, err?.message || err); process.exit(1); });


