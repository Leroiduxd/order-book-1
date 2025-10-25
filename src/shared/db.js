import { supabase } from './supabase.js';
import { logInfo, logErr } from './logger.js';

/* =========================================================
   Assets cache (tick/lot)
========================================================= */
const assetCache = new Map();
export async function getAsset(asset_id) {
  if (assetCache.has(asset_id)) return assetCache.get(asset_id);
  const { data, error } = await supabase
    .from('assets')
    .select('asset_id, tick_size_usd6, lot_num, lot_den')
    .eq('asset_id', asset_id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Asset ${asset_id} introuvable dans DB (table assets)`);
  assetCache.set(asset_id, data);
  return data;
}

/* =========================================================
   Helpers BigInt & maths
========================================================= */
const BI = (x) => BigInt(x);
function divFloor(a, b) { return a / b; }                 // BigInt floor
function mulDivFloor(a, b, c) { return (a * b) / c; }     // (a*b)/c en BigInt

/* =========================================================
   Notional / Margin
========================================================= */
function computeNotionalAndMargin({ entry_x6, lots, leverage_x, lot_num, lot_den }) {
  const entry   = BI(entry_x6);
  const lotsBI  = BI(lots);
  const lotNum  = BI(lot_num);
  const lotDen  = BI(lot_den);
  const lev     = BI(leverage_x);

  const qty_num = lotsBI * lotNum;  // numérateur de qty_base
  const qty_den = lotDen;           // dénominateur

  const notional = mulDivFloor(entry, qty_num, qty_den);
  const margin   = divFloor(notional, lev);

  return { notional_usd6: notional.toString(), margin_usd6: margin.toString() };
}

/* =========================================================
   Indexation des stops (SL/TP/LIQ) avec UPSERT
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
    const { error } = await supabase
      .from('stop_buckets')
      .upsert(
        {
          asset_id: Number(asset_id),
          bucket_id,
          position_id: Number(position_id),
          stop_type: r.type
        },
        { onConflict: 'asset_id,bucket_id,position_id,stop_type' }
      );
    if (error) {
      if (error.code === '23505') {
        // déjà présent: pas grave
        logInfo('DB', `stop_buckets duplicate ignored asset=${asset_id} bucket=${bucket_id} pos=${position_id} type=${r.type}`);
      } else {
        logErr('DB', `stop_buckets upsert failed asset=${asset_id} bucket=${bucket_id} pos=${position_id} type=${r.type}:`, error.message || error);
        throw error;
      }
    }
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
    // position ouverte immédiatement (market)
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

  // 1) UPSERT position (idempotent)
  const upsertPayload = {
    id: Number(id),
    state: Number(state),
    asset_id: Number(asset),
    trader_addr: String(trader),
    long_side: Boolean(longSide),
    lots: Number(lots),
    leverage_x: Number(leverageX),
    entry_x6: Number(state) === 1 ? String(entryOrTargetX6) : null,
    target_x6: Number(state) === 0 ? String(entryOrTargetX6) : null,
    sl_x6: String(slX6),
    tp_x6: String(tpX6),
    liq_x6: String(liqX6),
    notional_usd6,
    margin_usd6
  };

  {
    const { error } = await supabase
      .from('positions')
      .upsert(upsertPayload, { onConflict: 'id' });
    if (error) throw error;
  }

  // 2) Index
  if (Number(state) === 0) {
    // ORDER -> index target dans order_buckets (UPSERT)
    const tick   = BI(assetRow.tick_size_usd6);
    const price  = BI(entryOrTargetX6);
    const bucket = divFloor(price, tick).toString();

    const { error } = await supabase
      .from('order_buckets')
      .upsert(
        {
          asset_id: Number(asset),
          bucket_id: bucket,
          position_id: Number(id)
        },
        { onConflict: 'asset_id,bucket_id,position_id' }
      );
    if (error) throw error;
  } else {
    // OPEN -> indexer SL/TP/LIQ (clean préalable pour cohérence)
    const { error: delErr } = await supabase
      .from('stop_buckets')
      .delete()
      .eq('position_id', Number(id));
    if (delErr) throw delErr;

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
   - update position: state=1, entry_x6, notional/margin
   - delete order_buckets
   - (re)index SL/TP/LIQ (upsert)
========================================================= */
export async function handleExecutedEvent(ev) {
  const { id, entryX6 } = ev;

  // Lire position pour lots, leverage, asset, stops actuels
  const { data: pos, error: readErr } = await supabase
    .from('positions')
    .select('asset_id, lots, leverage_x, sl_x6, tp_x6, liq_x6')
    .eq('id', Number(id))
    .maybeSingle();
  if (readErr) throw readErr;
  if (!pos) throw new Error(`Position ${id} introuvable pour Executed`);

  const assetRow = await getAsset(Number(pos.asset_id));
  const calc = computeNotionalAndMargin({
    entry_x6: entryX6,
    lots: pos.lots,
    leverage_x: pos.leverage_x,
    lot_num: assetRow.lot_num,
    lot_den: assetRow.lot_den
  });

  // 1) Update position
  {
    const { error } = await supabase
      .from('positions')
      .update({
        state: 1,
        entry_x6: String(entryX6),
        notional_usd6: calc.notional_usd6,
        margin_usd6:   calc.margin_usd6
      })
      .eq('id', Number(id));
    if (error) throw error;
  }

  // 2) Retirer des order_buckets
  {
    const { error } = await supabase
      .from('order_buckets')
      .delete()
      .eq('position_id', Number(id));
    if (error) throw error;
  }

  // 3) (Ré)indexer SL/TP/LIQ (upsert)
  {
    const { error } = await supabase
      .from('stop_buckets')
      .delete()
      .eq('position_id', Number(id));
    if (error) throw error;
  }

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
   - re-index SL/TP (upsert)
========================================================= */
export async function handleStopsUpdatedEvent(ev) {
  const { id, slX6, tpX6 } = ev;

  // Lire position pour asset_id & liq_x6
  const { data: pos, error: posErr } = await supabase
    .from('positions')
    .select('asset_id, liq_x6')
    .eq('id', Number(id))
    .maybeSingle();
  if (posErr) throw posErr;
  if (!pos) throw new Error(`Position ${id} introuvable pour StopsUpdated`);

  // 1) Update SL/TP
  {
    const { error } = await supabase
      .from('positions')
      .update({
        sl_x6: String(slX6),
        tp_x6: String(tpX6)
      })
      .eq('id', Number(id));
    if (error) throw error;
  }

  // 2) Supprimer uniquement SL/TP (1,2), conserver LIQ (3)
  {
    const { error } = await supabase
      .from('stop_buckets')
      .delete()
      .eq('position_id', Number(id))
      .in('stop_type', [1, 2]);
    if (error) throw error;
  }

  // 3) Réindexer SL/TP (upsert)
  await indexStops({
    asset_id: Number(pos.asset_id),
    position_id: Number(id),
    sl_x6: slX6,
    tp_x6: tpX6,
    liq_x6: 0 // LIQ conservé
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

  // 1) Fermer la position
  {
    const { error } = await supabase
      .from('positions')
      .update({
        state: 2,
        close_reason: Number(reason),
        exec_x6: String(execX6),
        pnl_usd6: String(pnlUsd6)
      })
      .eq('id', Number(id));
    if (error) throw error;
  }

  // 2) Supprimer tous les stops (SL/TP/LIQ)
  {
    const { error } = await supabase
      .from('stop_buckets')
      .delete()
      .eq('position_id', Number(id));
    if (error) throw error;
  }

  logInfo('DB', `Removed id=${id} reason=${reason} execX6=${execX6} pnlUsd6=${pnlUsd6}`);
}

