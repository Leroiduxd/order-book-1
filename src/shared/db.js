// src/shared/db.js
import { query } from './pg.js';
import { logInfo, logErr } from './logger.js';

/* ============================
   Helpers BigInt & maths
=============================== */
const BI = (x) => BigInt(x);
const divFloor = (a, b) => a / b;                 // BigInt floor
const mulDivFloor = (a, b, c) => (a * b) / c;     // (a*b)/c en BigInt

function toInt(x) { return Number(x); }
function toStr(x) { return String(x); }

/* ============================
   Assets (tick/lot)
=============================== */
const assetCache = new Map();
/** Retourne { id, tick_x6, lot_num, lot_den } */
export async function getAsset(asset_id) {
  const k = Number(asset_id);
  if (assetCache.has(k)) return assetCache.get(k);
  const { rows } = await query(
    `select id, tick_x6, lot_num, lot_den from public.assets where id = $1`,
    [k]
  );
  if (!rows.length) throw new Error(`Asset ${k} introuvable (table assets)`);
  assetCache.set(k, rows[0]);
  return rows[0];
}

/* ============================
   Notional / Margin
=============================== */
function computeNotionalAndMargin({ entry_x6, lots, leverage_x, lot_num, lot_den }) {
  const entry   = BI(entry_x6);
  const lotsBI  = BI(lots);
  const lotNum  = BI(lot_num ?? 1);
  const lotDen  = BI(lot_den ?? 1);
  const lev     = BI(leverage_x);

  const qty_num = lotsBI * lotNum;  // numérateur de qty_base
  const qty_den = lotDen;           // dénominateur

  const notional = mulDivFloor(entry, qty_num, qty_den); // USDx6
  const margin   = divFloor(notional, lev);

  return { notional_usd6: notional.toString(), margin_usd6: margin.toString() };
}

/* ============================
   Mappers d'état / raisons
=============================== */
function stateNumToEnum(stateNum) {
  // 0=ORDER, 1=OPEN  (dans ton ancien code)
  return Number(stateNum) === 0 ? 'ORDER' : 'OPEN';
}

// remove_reason : 'CANCELLED' | 'MARKET' | 'SL' | 'TP' | 'LIQ'
function reasonNumToEnum(reason) {
  // Adapte ici si ton event reason est numérique:
  // 0= CANCELLED, 1=MARKET, 2=SL, 3=TP, 4=LIQ (exemple)
  const m = {
    0: 'CANCELLED',
    1: 'MARKET',
    2: 'SL',
    3: 'TP',
    4: 'LIQ',
  };
  const r = m[Number(reason)];
  if (!r) throw new Error(`Unknown remove reason: ${reason}`);
  return r;
}

/* ============================
   OPENED
   - appelle public.ingest_opened(...)
=============================== */
export async function upsertOpenedEvent(ev, meta = {}) {
  const {
    id, state, asset, longSide, lots,
    entryOrTargetX6, slX6, tpX6, liqX6,
    trader, leverageX
  } = ev;

  const st = stateNumToEnum(state);
  const a  = await getAsset(Number(asset));

  // Pour ORDER et OPEN on calcule une marge sur le prix "entryOrTargetX6"
  // (utile pour pré-allocations / cohérence)
  const { margin_usd6 } = computeNotionalAndMargin({
    entry_x6: entryOrTargetX6,
    lots,
    leverage_x: leverageX,
    lot_num: a.lot_num,
    lot_den: a.lot_den
  });

  // Appel de la fonction SQL : ingest_opened
  await query(
    `select public.ingest_opened(
       $1::int8,  -- _id
       $2::text,  -- _owner_addr
       $3::int4,  -- _asset_id
       $4::bool,  -- _long_side
       $5::int2,  -- _lots
       $6::int2,  -- _leverage_x
       $7::int8,  -- _margin_usd6
       $8::trade_state,      -- _state ('ORDER'|'OPEN')
       $9::int8,  -- _entry_or_target_x6
       $10::int8, -- _sl_x6
       $11::int8, -- _tp_x6
       $12::int8, -- _liq_x6
       $13::text, -- _tx_hash
       $14::bigint -- _block_num
     )`,
    [
      toInt(id),
      toStr(trader),
      toInt(asset),
      Boolean(longSide),
      toInt(lots),
      toInt(leverageX),
      BigInt(margin_usd6).toString(),
      st,
      toStr(entryOrTargetX6),
      toStr(slX6 ?? 0),
      toStr(tpX6 ?? 0),
      toStr(liqX6 ?? 0),
      meta.txHash ?? null,
      meta.blockNum ?? null
    ]
  );

  logInfo('DB', `ingest_opened ok id=${id} state=${st} asset=${asset} lots=${lots}`);
}

/* ============================
   EXECUTED
=============================== */
export async function handleExecutedEvent(ev, meta = {}) {
  const { id, entryX6 } = ev;

  await query(
    `select public.ingest_executed(
       $1::int8,  -- _id
       $2::int8,  -- _entry_x6
       $3::text,  -- _tx_hash
       $4::bigint -- _block_num
     )`,
    [
      toInt(id),
      toStr(entryX6),
      meta.txHash ?? null,
      meta.blockNum ?? null
    ]
  );

  logInfo('DB', `ingest_executed ok id=${id} entryX6=${entryX6}`);
}

/* ============================
   STOPS UPDATED
=============================== */
export async function handleStopsUpdatedEvent(ev, meta = {}) {
  const { id, slX6, tpX6 } = ev;

  await query(
    `select public.ingest_stops_updated(
       $1::int8,  -- _id
       $2::int8,  -- _sl_x6
       $3::int8,  -- _tp_x6
       $4::text,  -- _tx_hash
       $5::bigint -- _block_num
     )`,
    [
      toInt(id),
      toStr(slX6 ?? 0),
      toStr(tpX6 ?? 0),
      meta.txHash ?? null,
      meta.blockNum ?? null
    ]
  );

  logInfo('DB', `ingest_stops_updated ok id=${id} sl=${slX6} tp=${tpX6}`);
}

/* ============================
   REMOVED
=============================== */
export async function handleRemovedEvent(ev, meta = {}) {
  const { id, reason, execX6, pnlUsd6 } = ev;

  await query(
    `select public.ingest_removed(
       $1::int8,             -- _id
       $2::remove_reason,    -- _reason
       $3::int8,             -- _exec_x6
       $4::numeric,          -- _pnl_usd6
       $5::text,             -- _tx_hash
       $6::bigint            -- _block_num
     )`,
    [
      toInt(id),
      reasonNumToEnum(reason),
      toStr(execX6 ?? 0),
      toStr(pnlUsd6 ?? 0),
      meta.txHash ?? null,
      meta.blockNum ?? null
    ]
  );

  logInfo('DB', `ingest_removed ok id=${id} reason=${reason} exec=${execX6} pnl=${pnlUsd6}`);
}
