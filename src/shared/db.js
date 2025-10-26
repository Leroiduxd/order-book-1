// src/shared/db.js — version "même logique que Supabase", mais via pg + SQL
import { query } from './pg.js';
import { logInfo, logErr } from './logger.js';

/* =========================================================
   Helpers BigInt & maths
========================================================= */
const BI = (x) => BigInt(x);
const divFloor = (a, b) => a / b;
const mulDivFloor = (a, b, c) => (a * b) / c;

/* =========================================================
   Cache assets  (schema: assets.asset_id, assets.tick_size_usd6, lot_num, lot_den)
========================================================= */
const assetCache = new Map();
export async function getAsset(asset_id) {
  const k = Number(asset_id);
  if (assetCache.has(k)) return assetCache.get(k);

  const { rows } = await query(
    `select asset_id, tick_size_usd6, lot_num, lot_den
       from public.assets
      where asset_id = $1`,
    [k]
  );
  if (!rows.length) throw new Error(`Asset ${k} introuvable dans DB (table assets)`);
  assetCache.set(k, rows[0]);
  return rows[0];
}

/* =========================================================
   Notional / Margin
========================================================= */
function computeNotionalAndMargin({ entry_x6, lots, leverage_x, lot_num, lot_den }) {
  const entry   = BI(entry_x6);
  const lotsBI  = BI(lots);
  const lotNum  = BI(lot_num ?? 1);
  const lotDen  = BI(lot_den ?? 1);
  const lev     = BI(leverage_x);

  const qty_num = lotsBI * lotNum;
  const qty_den = lotDen;

  const notional = mulDivFloor(entry, qty_num, qty_den);
  const margin   = divFloor(notional, lev);

  return { notional_usd6: notional.toString(), margin_usd6: margin.toString() };
}

/* =========================================================
   Indexation des stops (SL/TP/LIQ) via UPSERT SQL
========================================================= */
async function indexStops({ asset_id, position_id, sl_x6, tp_x6, liq_x6 }) {
  const asset = await getAsset(Number(asset_id));
  const tick  = BI(asset.tick_size_usd6);

  const rows = [];
  if (Number(sl_x6)  !== 0) rows.push({ px: BI(sl_x6),  type: 1 }); // SL
  if (Number(tp_x6)  !== 0) rows.push({ px: BI(tp_x6),  type: 2 }); // TP
  if (Number(liq_x6) !== 0) rows.push({ px: BI(liq_x6), type: 3 }); // LIQ

  for (const r of rows) {
    const bucket_id = divFloor(r.px, tick).toString();
    await query(
      `insert into public.stop_buckets(asset_id, bucket_id, position_id, stop_type)
       values ($1::int, $2::bigint, $3::bigint, $4::smallint)
       on conflict (asset_id, bucket_id, position_id, stop_type) do nothing`,
      [Number(asset_id), bucket_id, Number(position_id), r.type]
    );
  }
}

/* =========================================================
   OPENED (state=0=ORDER, state=1=OPEN)
   - positions: upsert
   - state=0: order_buckets upsert (target)
   - state=1: stop_buckets upsert (SL/TP/LIQ)
========================================================= */
export async function upsertOpenedEvent(ev) {
  const {
    id, state, asset, longSide, lots,
    entryOrTargetX6, slX6, tpX6, liqX6,
    trader, leverageX
  } = ev;

  const assetRow = await getAsset(Number(asset));

  let notional_usd6 = null;
  let margin_usd6   = null;

  if (Number(state) === 1) {
    const calc = computeNotionalAndMargin({
      entry_x6: entryOrTargetX6,
      lots,
      leverage_x: leverageX,
      lot_num: assetRow.lot_num,
      lot_den: assetRow.lot_den
    });
    notional_usd6 = calc.notional_usd6;
    margin_usd6   = calc.margin_usd6;
  }

  // 1) UPSERT position
  await query(
    `insert into public.positions(
       id, state, asset_id, trader_addr, long_side, lots, leverage_x,
       entry_x6, target_x6, sl_x6, tp_x6, liq_x6, notional_usd6, margin_usd6
     )
     values (
       $1::bigint, $2::int, $3::int, $4::text, $5::boolean, $6::smallint, $7::smallint,
       case when $2::int=1 then $8::bigint else null end,
       case when $2::int=0 then $8::bigint else null end,
       $9::bigint, $10::bigint, $11::bigint, $12::bigint, $13::bigint
     )
     on conflict (id) do update
     set state=$2::int,
         entry_x6=case when $2::int=1 then $8::bigint else null end,
         target_x6=case when $2::int=0 then $8::bigint else null end,
         sl_x6=$9::bigint,
         tp_x6=$10::bigint,
         liq_x6=$11::bigint,
         notional_usd6=$12::bigint,
         margin_usd6=$13::bigint`,
    [
      Number(id),
      Number(state),
      Number(asset),
      String(trader),
      Boolean(longSide),
      Number(lots),
      Number(leverageX),
      BigInt(entryOrTargetX6).toString(),
      BigInt(slX6 ?? 0).toString(),
      BigInt(tpX6 ?? 0).toString(),
      BigInt(liqX6 ?? 0).toString(),
      notional_usd6 ? BigInt(notional_usd6).toString() : null,
      margin_usd6   ? BigInt(margin_usd6).toString()   : null,
    ]
  );

  // 2) Index
  if (Number(state) === 0) {
    // ORDER -> order_buckets
    const tick   = BI(assetRow.tick_size_usd6);
    const price  = BI(entryOrTargetX6);
    const bucket = divFloor(price, tick).toString();

    await query(
      `insert into public.order_buckets(asset_id, bucket_id, position_id)
       values ($1::int, $2::bigint, $3::bigint)
       on conflict (asset_id, bucket_id, position_id) do nothing`,
      [Number(asset), bucket, Number(id)]
    );
  } else {
    // OPEN -> (re)index SL/TP/LIQ
    await query(`delete from public.stop_buckets where position_id=$1::bigint`, [Number(id)]);
    await indexStops({
      asset_id: Number(asset),
      position_id: Number(id),
      sl_x6: slX6,
      tp_x6: tpX6,
      liq_x6: liqX6
    });
  }

  logInfo('DB', `Opened upserted id=${id} state=${state} (indexed=${Number(state)===0?'order':'stops'})`);
}

/* =========================================================
   EXECUTED (ORDER -> OPEN)
   - positions: update state=1, entry_x6, notional/margin
   - delete order_buckets
   - (re)index SL/TP/LIQ
========================================================= */
export async function handleExecutedEvent(ev) {
  const { id, entryX6 } = ev;

  // Lire position pour lots, leverage, asset, stops
  const { rows: posRows } = await query(
    `select asset_id, lots, leverage_x, sl_x6, tp_x6, liq_x6
       from public.positions
      where id=$1::bigint`,
    [Number(id)]
  );
  const pos = posRows[0];
  if (!pos) throw new Error(`Position ${id} introuvable pour Executed`);

  const assetRow = await getAsset(Number(pos.asset_id));
  const calc = computeNotionalAndMargin({
    entry_x6: entryX6,
    lots: pos.lots,
    leverage_x: pos.leverage_x,
    lot_num: assetRow.lot_num,
    lot_den: assetRow.lot_den
  });

  await query(
    `update public.positions
        set state=1,
            entry_x6=$2::bigint,
            notional_usd6=$3::bigint,
            margin_usd6=$4::bigint
      where id=$1::bigint`,
    [Number(id), BigInt(entryX6).toString(), BigInt(calc.notional_usd6).toString(), BigInt(calc.margin_usd6).toString()]
  );

  await query(`delete from public.order_buckets where position_id=$1::bigint`, [Number(id)]);
  await query(`delete from public.stop_buckets where position_id=$1::bigint`, [Number(id)]);

  await indexStops({
    asset_id: Number(pos.asset_id),
    position_id: Number(id),
    sl_x6: pos.sl_x6 ?? 0,
    tp_x6: pos.tp_x6 ?? 0,
    liq_x6: pos.liq_x6 ?? 0
  });

  logInfo('DB', `Executed applied id=${id} entryX6=${entryX6} (order->stops indexed)`);
}

/* =========================================================
   STOPS UPDATED
   - update SL/TP (pas LIQ)
   - delete stop_buckets (types 1,2), conserve LIQ (3)
   - re-index SL/TP
========================================================= */
export async function handleStopsUpdatedEvent(ev) {
  const { id, slX6, tpX6 } = ev;

  const { rows: posRows } = await query(
    `select asset_id, liq_x6 from public.positions where id=$1::bigint`,
    [Number(id)]
  );
  const pos = posRows[0];
  if (!pos) throw new Error(`Position ${id} introuvable pour StopsUpdated`);

  await query(
    `update public.positions
        set sl_x6=$2::bigint,
            tp_x6=$3::bigint
      where id=$1::bigint`,
    [Number(id), BigInt(slX6 ?? 0).toString(), BigInt(tpX6 ?? 0).toString()]
  );

  await query(
    `delete from public.stop_buckets
      where position_id=$1::bigint
        and stop_type in (1,2)`, // SL, TP
    [Number(id)]
  );

  await indexStops({
    asset_id: Number(pos.asset_id),
    position_id: Number(id),
    sl_x6: slX6,
    tp_x6: tpX6,
    liq_x6: 0
  });

  logInfo('DB', `StopsUpdated id=${id} slX6=${slX6} tpX6=${tpX6} (LIQ conservé)`);
}

/* =========================================================
   REMOVED (fermeture ou annulation)
   - update position: state=2, close_reason, exec_x6, pnl_usd6
   - delete tous les stops
========================================================= */
export async function handleRemovedEvent(ev) {
  const { id, reason, execX6, pnlUsd6 } = ev;

  await query(
    `update public.positions
        set state=2,
            close_reason=$2::int,
            exec_x6=$3::bigint,
            pnl_usd6=$4::numeric
      where id=$1::bigint`,
    [Number(id), Number(reason), BigInt(execX6 ?? 0).toString(), String(pnlUsd6 ?? 0)]
  );

  await query(`delete from public.stop_buckets where position_id=$1::bigint`, [Number(id)]);

  logInfo('DB', `Removed id=${id} reason=${reason} execX6=${execX6} pnlUsd6=${pnlUsd6}`);
}
