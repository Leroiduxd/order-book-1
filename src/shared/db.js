// src/shared/db.js
import { get, postArray, patch, del } from './rest.js';
import { logInfo } from './logger.js';

/* =========================================================
   Helpers
========================================================= */
const BI = (x) => BigInt(x);
const divFloor = (a, b) => a / b;
const mulDivFloor = (a, b, c) => (a * b) / c;
const idStr = (x) => (typeof x === 'bigint' ? x.toString() : String(x));

/* =========================================================
   Assets cache (assets.asset_id, tick_size_usd6, lot_num, lot_den)
========================================================= */
const assetCache = new Map();
export async function getAsset(asset_id) {
  const k = Number(asset_id);
  if (assetCache.has(k)) return assetCache.get(k);

  const rows = await get(`assets?asset_id=eq.${k}&select=asset_id,tick_size_usd6,lot_num,lot_den`);
  const row = rows?.[0];
  if (!row) throw new Error(`Asset ${k} introuvable (table assets)`);
  assetCache.set(k, row);
  return row;
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
   Indexation des stops (SL/TP/LIQ) via PostgREST
   - side antagoniste (!long_side)
   - conserve lots
========================================================= */
async function indexStops({ asset_id, position_id, sl_x6, tp_x6, liq_x6, long_side, lots }) {
  const asset = await getAsset(Number(asset_id));
  const tick  = BI(asset.tick_size_usd6);

  const rows = [];
  if (Number(sl_x6)  !== 0) rows.push({ px: BI(sl_x6),  type: 1 }); // SL
  if (Number(tp_x6)  !== 0) rows.push({ px: BI(tp_x6),  type: 2 }); // TP
  if (Number(liq_x6) !== 0) rows.push({ px: BI(liq_x6), type: 3 }); // LIQ
  if (!rows.length) return;

  const payload = rows.map(r => ({
    asset_id: Number(asset_id),
    bucket_id: divFloor(r.px, tick).toString(),
    position_id: idStr(position_id),
    stop_type: r.type,
    lots: Number(lots || 0),
    side: !Boolean(long_side) // antagoniste dans l'order book
  }));

  await postArray(
    'stop_buckets?on_conflict=asset_id,bucket_id,position_id,stop_type',
    payload
  );
}

/* =========================================================
   OPENED (state=0=ORDER, state=1=OPEN)
   - positions: upsert (⚠️ ne PAS envoyer trader_addr_lc — colonne générée)
   - state=0: order_buckets upsert (target) avec lots + side=longSide
   - state=1: stop_buckets upsert (SL/TP/LIQ) lots + side=!longSide
   (les triggers Postgres maintiennent exposure_agg automatiquement)
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
  await postArray('positions?on_conflict=id', [
    {
      id: idStr(id),
      state: Number(state),
      asset_id: Number(asset),
      trader_addr: String(trader),
      long_side: Boolean(longSide),
      lots: Number(lots),
      leverage_x: Number(leverageX),
      entry_x6: Number(state) === 1 ? BI(entryOrTargetX6).toString() : null,
      target_x6: Number(state) === 0 ? BI(entryOrTargetX6).toString() : null,
      sl_x6: BI(slX6 ?? 0).toString(),
      tp_x6: BI(tpX6 ?? 0).toString(),
      liq_x6: BI(liqX6 ?? 0).toString(),
      notional_usd6: notional_usd6 ? BI(notional_usd6).toString() : null,
      margin_usd6:   margin_usd6   ? BI(margin_usd6).toString()   : null
    }
  ]);

  // 2) Indexation
  if (Number(state) === 0) {
    // ORDER -> order_buckets (lots + side = longSide)
    const tick   = BI(assetRow.tick_size_usd6);
    const price  = BI(entryOrTargetX6);
    const bucket = divFloor(price, tick).toString();

    await postArray(
      'order_buckets?on_conflict=asset_id,bucket_id,position_id',
      [{
        asset_id: Number(asset),
        bucket_id: bucket,
        position_id: idStr(id),
        lots: Number(lots || 0),
        side: Boolean(longSide)
      }]
    );
  } else {
    // OPEN -> (re)indexer SL/TP/LIQ antagonistes
    await del(`stop_buckets?position_id=eq.${idStr(id)}`);
    await indexStops({
      asset_id: Number(asset),
      position_id: idStr(id),
      sl_x6: slX6,
      tp_x6: tpX6,
      liq_x6: liqX6,
      long_side: Boolean(longSide),
      lots: Number(lots || 0)
    });
  }

  // ⚠️ Les agrégats exposure_agg sont MAJ par trigger quand state=1
  logInfo('DB', `Opened upserted id=${idStr(id)} state=${state} (indexed=${Number(state)===0?'order':'stops'})`);
}

/* =========================================================
   EXECUTED (ORDER -> OPEN)
   - update position: state=1, entry_x6, notional/margin
   - delete order_buckets
   - (re)index SL/TP/LIQ antagonistes
   (trigger mettra à jour exposure_agg car state passe à 1)
========================================================= */
export async function handleExecutedEvent(ev) {
  const { id, entryX6 } = ev;

  // Lire position: besoin de asset_id, lots, leverage_x, stops actuels, long_side
  const rows = await get(`positions?id=eq.${idStr(id)}&select=asset_id,lots,leverage_x,sl_x6,tp_x6,liq_x6,long_side`);
  const pos = rows?.[0];
  if (!pos) throw new Error(`Position ${idStr(id)} introuvable pour Executed`);

  const assetRow = await getAsset(Number(pos.asset_id));
  const calc = computeNotionalAndMargin({
    entry_x6: entryX6,
    lots: pos.lots,
    leverage_x: pos.leverage_x,
    lot_num: assetRow.lot_num,
    lot_den: assetRow.lot_den
  });

  // 1) Update position -> triggers: ajoute à exposure_agg (état devient OPEN)
  await patch(
    `positions?id=eq.${idStr(id)}`,
    {
      state: 1,
      entry_x6: BI(entryX6).toString(),
      notional_usd6: BI(calc.notional_usd6).toString(),
      margin_usd6:   BI(calc.margin_usd6).toString()
    }
  );

  // 2) Nettoyage des index
  await del(`order_buckets?position_id=eq.${idStr(id)}`);
  await del(`stop_buckets?position_id=eq.${idStr(id)}`);

  // 3) (Ré)indexer SL/TP/LIQ antagonistes
  await indexStops({
    asset_id: Number(pos.asset_id),
    position_id: idStr(id),
    sl_x6: pos.sl_x6 ?? 0,
    tp_x6: pos.tp_x6 ?? 0,
    liq_x6: pos.liq_x6 ?? 0,
    long_side: Boolean(pos.long_side),
    lots: Number(pos.lots || 0)
  });

  logInfo('DB', `Executed applied id=${idStr(id)} entryX6=${entryX6} (order->stops indexed)`);
}

/* =========================================================
   STOPS UPDATED
   - update SL/TP (pas LIQ)
   - delete stop_buckets (types 1,2), conserve LIQ (3)
   - re-index SL/TP antagonistes
   (exposure_agg ne change pas ici sauf si tu changes liq_x6)
========================================================= */
export async function handleStopsUpdatedEvent(ev) {
  const { id, slX6, tpX6 } = ev;

  const rows = await get(`positions?id=eq.${idStr(id)}&select=asset_id,liq_x6,long_side,lots`);
  const pos = rows?.[0];
  if (!pos) throw new Error(`Position ${idStr(id)} introuvable pour StopsUpdated`);

  // 1) Update SL/TP
  await patch(
    `positions?id=eq.${idStr(id)}`,
    { sl_x6: BI(slX6 ?? 0).toString(), tp_x6: BI(tpX6 ?? 0).toString() }
  );

  // 2) Supprimer SL/TP (1,2), conserver LIQ (3)
  await del(`stop_buckets?position_id=eq.${idStr(id)}&stop_type=in.(1,2)`);

  // 3) Réindexer SL/TP antagonistes
  await indexStops({
    asset_id: Number(pos.asset_id),
    position_id: idStr(id),
    sl_x6: slX6,
    tp_x6: tpX6,
    liq_x6: 0,
    long_side: Boolean(pos.long_side),
    lots: Number(pos.lots || 0)
  });

  logInfo('DB', `StopsUpdated id=${idStr(id)} slX6=${slX6} tpX6=${tpX6} (LIQ conservé)`);
}

/* =========================================================
   REMOVED (fermeture ou annulation)
   - update position: state=2, close_reason, exec_x6, pnl_usd6
   - delete tous les stops
   (trigger soustrait l'expo si la position était OPEN)
========================================================= */
export async function handleRemovedEvent(ev) {
  const { id, reason, execX6, pnlUsd6 } = ev;

  await patch(
    `positions?id=eq.${idStr(id)}`,
    {
      state: 2,
      close_reason: Number(reason),
      exec_x6: BI(execX6 ?? 0).toString(),
      pnl_usd6: String(pnlUsd6 ?? 0)
    }
  );

  await del(`stop_buckets?position_id=eq.${idStr(id)}`);

  logInfo('DB', `Removed id=${idStr(id)} reason=${reason} execX6=${execX6} pnlUsd6=${pnlUsd6}`);
}

/* =========================================================
   Get Highest Position ID
========================================================= */
export async function getHighestPositionId() {
  try {
    const res = await query('SELECT COALESCE(MAX(id), 0) AS max_id FROM public.positions');
    return BigInt(res.rows[0].max_id); // retourne un BigInt pour cohérence avec ton code
  } catch (err) {
    console.error('[DB] Error in getHighestPositionId:', err);
    throw err;
  }
}

/* =========================================================
   Get Missing Position IDs (from 0 to MAX(id))
========================================================= */
export async function getMissingPositionIds() {
  try {
    const sql = `
      WITH max_id AS (
        SELECT COALESCE(MAX(id), -1) AS mx FROM public.positions
      )
      SELECT s.id AS missing_id
      FROM generate_series(0, (SELECT mx FROM max_id)) AS s(id)
      EXCEPT
      SELECT p.id FROM public.positions p
      ORDER BY missing_id;
    `;
    const res = await pool.query(sql); // ✅ évite toute dépendance à "query"
    // Si vos IDs peuvent dépasser 2^53, préférez String(...)
    return res.rows.map(r => Number(r.missing_id));
  } catch (err) {
    console.error('[DB] Error in getMissingPositionIds:', err);
    throw err;
  }
}
