// src/endpoint.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { get } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';
import { verifyAndSync } from './verify.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.API_PORT || process.env.PORT || 7392);

/* -------------------------------
   Helpers
-------------------------------- */
const isHexAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || ''));
const toLowerAddr = (s) => String(s || '').toLowerCase();

/** Parse string price (e.g. "108910.01") to x6 BigInt safely (no FP). */
function priceStrToX6(str) {
  if (typeof str !== 'string') str = String(str);
  const sign = str.trim().startsWith('-') ? '-' : '';
  const [intRaw, fracRaw = ''] = str.replace(/,/g, '').split('.');
  const intPart = (intRaw || '0').replace(/^(-?)0+/, '$1') || '0';
  const fracPart = (fracRaw + '000000').slice(0, 6);
  const digits = (intPart.replace('-', '') || '0') + fracPart;
  return BigInt(sign + digits);
}

/** Compute bucket id from (asset, price x6) using assets.tick_size_usd6 */
async function computeBucketId(assetId, priceX6) {
  const rows = await get(`assets?asset_id=eq.${Number(assetId)}&select=tick_size_usd6&limit=1`);
  const asset = rows?.[0];
  if (!asset) throw Object.assign(new Error('asset_not_found'), { http: 404 });
  const tick = BigInt(asset.tick_size_usd6);
  if (tick <= 0n) throw Object.assign(new Error('bad_tick'), { http: 400 });
  return (BigInt(priceX6) / tick).toString();
}

function ok(res, data) { res.json(data); }
function bad(res, msg = 'bad_request', code = 400) { res.status(code).json({ error: msg }); }

/* -------------------------------
   Uniform resolvers (bucket OR price)
-------------------------------- */
function isPriceLike(v) {
  return /\./.test(String(v || '').trim()); // présence d’un point => interprété comme prix
}

/** Resolve { asset, bucketId } from query.
 * Accepts: ?asset=0 and one of (?bucket, ?price, ?q)
 * Priority: bucket > price > q
 */
async function resolveAssetAndBucket(q) {
  const asset = Number(q.asset);
  if (!Number.isInteger(asset)) throw Object.assign(new Error('asset_required'), { http: 400 });

  const bucketRaw = String(q.bucket || '').trim();
  const priceRaw  = String(q.price  || '').trim();
  const qRaw      = String(q.q      || '').trim();

  if (bucketRaw) return { asset, bucketId: bucketRaw };

  if (priceRaw) {
    const priceX6 = priceStrToX6(priceRaw);
    const bucketId = await computeBucketId(asset, priceX6);
    return { asset, bucketId };
  }

  if (qRaw) {
    if (isPriceLike(qRaw)) {
      const priceX6 = priceStrToX6(qRaw);
      const bucketId = await computeBucketId(asset, priceX6);
      return { asset, bucketId };
    }
    return { asset, bucketId: qRaw };
  }

  throw Object.assign(new Error('price_or_bucket_required'), { http: 400 });
}

/** Resolve a [from..to] bucket range from query.
 * Accepts: ?asset=0 and from/to as prices OR bucket ids.
 * Aliases supported: from|f|qfrom|bucket_from|price_from, to|t|qto|bucket_to|price_to
 */
async function resolveBucketRange(q) {
  const asset = Number(q.asset);
  if (!Number.isInteger(asset)) throw Object.assign(new Error('asset_required'), { http: 400 });

  const fromRaw = String(q.from || q.f || q.qfrom || q.bucket_from || q.price_from || '').trim();
  const toRaw   = String(q.to   || q.t || q.qto   || q.bucket_to   || q.price_to   || '').trim();
  if (!fromRaw || !toRaw) throw Object.assign(new Error('range_required'), { http: 400 });

  async function toBucketId(v) {
    if (isPriceLike(v)) {
      const px6 = priceStrToX6(v);
      return await computeBucketId(asset, px6);
    }
    return String(v);
  }

  let fromId = await toBucketId(fromRaw);
  let toId   = await toBucketId(toRaw);

  // normalize (inclusive)
  if (BigInt(fromId) > BigInt(toId)) {
    const tmp = fromId; fromId = toId; toId = tmp;
  }
  return { asset, fromId, toId };
}

/* -------------------------------
   Health
-------------------------------- */
app.get('/health', async (_req, res) => {
  try {
    await get('assets?select=asset_id&limit=1'); // ping PostgREST
    ok(res, { ok: true });
  } catch (e) {
    logErr('API+', e);
    res.status(500).json({ ok: false, error: 'postgrest_unreachable' });
  }
});

/* -------------------------------
   Assets
-------------------------------- */
app.get('/assets', async (_req, res) => {
  try {
    const rows = await get('assets?select=asset_id,symbol,tick_size_usd6,lot_num,lot_den&order=asset_id.asc');
    ok(res, rows || []);
  } catch (e) {
    logErr('API+/assets', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/assets/:assetId', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isInteger(assetId)) return bad(res, 'asset_id_invalid');
    const rows = await get(`assets?asset_id=eq.${assetId}&select=asset_id,symbol,tick_size_usd6,lot_num,lot_den&limit=1`);
    if (!rows?.length) return res.status(404).json({ error: 'asset_not_found' });
    ok(res, rows[0]);
  } catch (e) {
    logErr('API+/assets/:id', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/* -------------------------------
   Position detail
-------------------------------- */
app.get('/position/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const rows = await get(`positions?id=eq.${id}&select=*&limit=1`);
    if (!rows?.length) return res.status(404).json({ error: 'position_not_found' });
    ok(res, rows[0]);
  } catch (e) {
    logErr('API+/position/:id', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/* -------------------------------
   Trader grouped IDs
-------------------------------- */
app.get('/trader/:addr', async (req, res) => {
  try {
    const addrRaw = String(req.params.addr || '');
    if (!isHexAddr(addrRaw)) return bad(res, 'invalid_address');
    const addr = toLowerAddr(addrRaw);

    const [orders, open, closedAll] = await Promise.all([
      get(`positions?trader_addr_lc=eq.${addr}&state=eq.0&select=id&order=id.asc`),
      get(`positions?trader_addr_lc=eq.${addr}&state=eq.1&select=id&order=id.asc`),
      get(`positions?trader_addr_lc=eq.${addr}&state=eq.2&select=id,close_reason&order=id.asc`)
    ]);

    const cancelled = (closedAll || []).filter(r => r.close_reason === 0).map(r => r.id);
    const closed    = (closedAll || []).filter(r => r.close_reason !== null && r.close_reason !== 0).map(r => r.id);

    ok(res, {
      trader: addr,
      orders: (orders || []).map(r => r.id),
      open:   (open   || []).map(r => r.id),
      cancelled,
      closed
    });
  } catch (e) {
    logErr('API+/trader/:addr', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/* -------------------------------
   Buckets: single bucket (UNIFORME)
   Exemples identiques:
     /bucket/orders?asset=0&bucket=10917030
     /bucket/orders?asset=0&price=109170.30
     /bucket/orders?asset=0&q=10917030   (auto)
     /bucket/orders?asset=0&q=109170.30  (auto)
-------------------------------- */
function parseSideFilter(q) {
  const s = String(q.side || 'all').toLowerCase();
  if (s === 'long') return true;
  if (s === 'short') return false;
  return null; // all
}
function parseSort(q) {
  const s = String(q.sort || 'lots').toLowerCase();
  return s === 'id' ? 'id' : 'lots';
}
function parseOrder(q) {
  const s = String(q.order || 'desc').toLowerCase();
  return s === 'asc' ? 'asc' : 'desc';
}

app.get('/bucket/orders', async (req, res) => {
  try {
    const { asset, bucketId } = await resolveAssetAndBucket(req.query);

    const side = parseSideFilter(req.query);
    const sort = parseSort(req.query);
    const ord  = parseOrder(req.query);

    let qp = `order_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucketId}` +
             `&select=position_id,lots,side&order=${sort}.${ord}`;
    if (side !== null) qp += `&side=eq.${side}`;

    const rows = await get(qp);
    ok(res, {
      asset,
      bucket_id: bucketId,
      count: rows?.length || 0,
      items: (rows || []).map(r => ({
        id: r.position_id,
        lots: r.lots ?? 0,
        side: r.side === true ? 'LONG' : 'SHORT'
      }))
    });
  } catch (e) {
    if (e?.message === 'asset_required')           return res.status(400).json({ error: 'asset_required' });
    if (e?.message === 'price_or_bucket_required') return res.status(400).json({ error: 'price_or_bucket_required' });
    if (e?.message === 'asset_not_found')          return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')                 return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/orders', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/bucket/stops', async (req, res) => {
  try {
    const { asset, bucketId } = await resolveAssetAndBucket(req.query);

    const side = parseSideFilter(req.query);
    const sort = parseSort(req.query);
    const ord  = parseOrder(req.query);

    let qp = `stop_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucketId}` +
             `&select=position_id,stop_type,lots,side&order=${sort}.${ord}`;
    if (side !== null) qp += `&side=eq.${side}`;

    const rows = await get(qp);
    const label = (t) => (t === 1 ? 'SL' : t === 2 ? 'TP' : t === 3 ? 'LIQ' : 'UNK');

    ok(res, {
      asset,
      bucket_id: bucketId,
      count: rows?.length || 0,
      items: (rows || []).map(r => ({
        id: r.position_id,
        type: label(r.stop_type),
        lots: r.lots ?? 0,
        side: r.side === true ? 'LONG' : 'SHORT'
      }))
    });
  } catch (e) {
    if (e?.message === 'asset_required')           return res.status(400).json({ error: 'asset_required' });
    if (e?.message === 'price_or_bucket_required') return res.status(400).json({ error: 'price_or_bucket_required' });
    if (e?.message === 'asset_not_found')          return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')                 return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/stops', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/* -------------------------------
   Buckets: RANGE (prix OU bucket)
   Exemples:
     /bucket/orders-range?asset=0&from=116065.34&to=116095.34
     /bucket/stops-range?asset=0&from=10917030&to=10917100
   Options:
     - side=long|short|all (def all)
     - sort=lots|id       (def lots)
     - order=asc|desc     (def desc)
     - group=1            (retour groupé par bucket_id)
-------------------------------- */
app.get('/bucket/orders-range', async (req, res) => {
  try {
    const { asset, fromId, toId } = await resolveBucketRange(req.query);

    const side = parseSideFilter(req.query);
    const sort = parseSort(req.query);
    const ord  = parseOrder(req.query);
    const group = String(req.query.group || '').trim() === '1';

    let qp = `order_buckets?asset_id=eq.${asset}&bucket_id=gte.${fromId}&bucket_id=lte.${toId}` +
             `&select=bucket_id,position_id,lots,side&order=bucket_id.asc,${sort}.${ord}`;
    if (side !== null) qp += `&side=eq.${side}`;

    const rows = await get(qp) || [];

    if (!group) {
      return ok(res, {
        asset,
        bucket_from: fromId,
        bucket_to: toId,
        count: rows.length,
        items: rows.map(r => ({
          bucket_id: String(r.bucket_id),
          id: r.position_id,
          lots: r.lots ?? 0,
          side: r.side === true ? 'LONG' : 'SHORT'
        }))
      });
    }

    const byBucket = new Map();
    for (const r of rows) {
      const b = String(r.bucket_id);
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b).push({
        id: r.position_id,
        lots: r.lots ?? 0,
        side: r.side === true ? 'LONG' : 'SHORT'
      });
    }
    const buckets = Array.from(byBucket.entries()).map(([bucket_id, items]) => ({ bucket_id, items }));

    ok(res, {
      asset,
      bucket_from: fromId,
      bucket_to: toId,
      bucket_count: buckets.length,
      item_count: rows.length,
      buckets
    });
  } catch (e) {
    if (e?.message === 'asset_required')   return res.status(400).json({ error: 'asset_required' });
    if (e?.message === 'range_required')   return res.status(400).json({ error: 'range_required' });
    if (e?.message === 'asset_not_found')  return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')         return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/orders-range', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/bucket/stops-range', async (req, res) => {
  try {
    const { asset, fromId, toId } = await resolveBucketRange(req.query);

    const side = parseSideFilter(req.query);
    const sort = parseSort(req.query);
    const ord  = parseOrder(req.query);
    const group = String(req.query.group || '').trim() === '1';

    let qp = `stop_buckets?asset_id=eq.${asset}&bucket_id=gte.${fromId}&bucket_id=lte.${toId}` +
             `&select=bucket_id,position_id,stop_type,lots,side&order=bucket_id.asc,${sort}.${ord}`;
    if (side !== null) qp += `&side=eq.${side}`;

    const rows = await get(qp) || [];
    const label = (t) => (t === 1 ? 'SL' : t === 2 ? 'TP' : t === 3 ? 'LIQ' : 'UNK');

    if (!group) {
      return ok(res, {
        asset,
        bucket_from: fromId,
        bucket_to: toId,
        count: rows.length,
        items: rows.map(r => ({
          bucket_id: String(r.bucket_id),
          id: r.position_id,
          type: label(r.stop_type),
          lots: r.lots ?? 0,
          side: r.side === true ? 'LONG' : 'SHORT'
        }))
      });
    }

    const byBucket = new Map();
    for (const r of rows) {
      const b = String(r.bucket_id);
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b).push({
        id: r.position_id,
        type: label(r.stop_type),
        lots: r.lots ?? 0,
        side: r.side === true ? 'LONG' : 'SHORT'
      });
    }
    const buckets = Array.from(byBucket.entries()).map(([bucket_id, items]) => ({ bucket_id, items }));

    ok(res, {
      asset,
      bucket_from: fromId,
      bucket_to: toId,
      bucket_count: buckets.length,
      item_count: rows.length,
      buckets
    });
  } catch (e) {
    if (e?.message === 'asset_required')   return res.status(400).json({ error: 'asset_required' });
    if (e?.message === 'range_required')   return res.status(400).json({ error: 'range_required' });
    if (e?.message === 'asset_not_found')  return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')         return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/stops-range', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/* -------------------------------
   Exposure
-------------------------------- */
app.get('/exposure', async (_req, res) => {
  try {
    const rows = await get('exposure_metrics?select=asset_id,side_label,sum_lots,avg_entry_x6,avg_leverage_x,avg_liq_x6,positions_count&order=asset_id.asc,side_label.asc');
    ok(res, rows || []);
  } catch (e) {
    logErr('API+/exposure', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/exposure/:assetId', async (req, res) => {
  try {
    const assetId = Number(req.params.assetId);
    if (!Number.isInteger(assetId)) return bad(res, 'asset_id_invalid');

    const rows = await get(`exposure_metrics?asset_id=eq.${assetId}&select=asset_id,side_label,sum_lots,avg_entry_x6,avg_leverage_x,avg_liq_x6,positions_count`);
    const out = { asset_id: assetId, long: null, short: null };
    for (const r of (rows || [])) {
      const obj = {
        sum_lots: Number(r.sum_lots || 0),
        avg_entry_x6: r.avg_entry_x6 === null ? null : Number(r.avg_entry_x6),
        avg_leverage_x: r.avg_leverage_x === null ? null : Number(r.avg_leverage_x),
        avg_liq_x6: r.avg_liq_x6 === null ? null : Number(r.avg_liq_x6),
        positions_count: Number(r.positions_count || 0)
      };
      if (String(r.side_label).toUpperCase() === 'LONG') out.long = obj;
      if (String(r.side_label).toUpperCase() === 'SHORT') out.short = obj;
    }
    ok(res, out);
  } catch (e) {
    logErr('API+/exposure/:asset', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/* -------------------------------
   Bucket RANGE (orders + stops, one-shot)
   Endpoint: /bucket/range
   Params:
     - asset (required)
     - from, to  (prix décimal OU bucket_id entier) — inclusif
     - side=long|short|all   (def: all)
     - sort=lots|id          (def: lots) — appliqué aux deux
     - order=asc|desc        (def: desc)
     - group=1               (regroupe par bucket_id)
     - types=orders,stops    (optionnel; def: les deux)
-------------------------------- */
app.get('/bucket/range', async (req, res) => {
  try {
    const { asset, fromId, toId } = await resolveBucketRange(req.query);

    const side  = parseSideFilter(req.query);
    const sort  = parseSort(req.query);
    const ord   = parseOrder(req.query);
    const group = String(req.query.group || '').trim() === '1';

    // allow filtering what to fetch, default both
    const typesRaw = String(req.query.types || 'orders,stops').toLowerCase();
    const wantOrders = /orders/.test(typesRaw);
    const wantStops  = /stops/.test(typesRaw);

    // Build queries
    const queries = [];
    if (wantOrders) {
      let qp = `order_buckets?asset_id=eq.${asset}&bucket_id=gte.${fromId}&bucket_id=lte.${toId}` +
               `&select=bucket_id,position_id,lots,side&order=bucket_id.asc,${sort}.${ord}`;
      if (side !== null) qp += `&side=eq.${side}`;
      queries.push(get(qp));
    } else {
      queries.push(Promise.resolve(null));
    }

    if (wantStops) {
      let qp = `stop_buckets?asset_id=eq.${asset}&bucket_id=gte.${fromId}&bucket_id=lte.${toId}` +
               `&select=bucket_id,position_id,stop_type,lots,side&order=bucket_id.asc,${sort}.${ord}`;
      if (side !== null) qp += `&side=eq.${side}`;
      queries.push(get(qp));
    } else {
      queries.push(Promise.resolve(null));
    }

    const [ordersRowsRaw, stopsRowsRaw] = await Promise.all(queries);
    const ordersRows = ordersRowsRaw || [];
    const stopsRows  = stopsRowsRaw  || [];

    const mapSide = (b) => (b === true ? 'LONG' : 'SHORT');
    const mapType = (t) => (t === 1 ? 'SL' : t === 2 ? 'TP' : t === 3 ? 'LIQ' : 'UNK');

    if (!group) {
      return ok(res, {
        asset,
        bucket_from: fromId,
        bucket_to: toId,
        count_orders: ordersRows.length,
        count_stops:  stopsRows.length,
        items_orders: ordersRows.map(r => ({
          bucket_id: String(r.bucket_id),
          id: r.position_id,
          lots: r.lots ?? 0,
          side: mapSide(r.side)
        })),
        items_stops: stopsRows.map(r => ({
          bucket_id: String(r.bucket_id),
          id: r.position_id,
          type: mapType(r.stop_type),
          lots: r.lots ?? 0,
          side: mapSide(r.side)
        }))
      });
    }

    // group=1 → group both sections by bucket_id
    const groupByBucket = (rows, mapper) => {
      const m = new Map();
      for (const r of rows) {
        const b = String(r.bucket_id);
        if (!m.has(b)) m.set(b, []);
        m.get(b).push(mapper(r));
      }
      return Array.from(m.entries()).map(([bucket_id, items]) => ({ bucket_id, items }));
    };

    const ordersBuckets = groupByBucket(ordersRows, (r) => ({
      id: r.position_id,
      lots: r.lots ?? 0,
      side: mapSide(r.side)
    }));

    const stopsBuckets = groupByBucket(stopsRows, (r) => ({
      id: r.position_id,
      type: mapType(r.stop_type),
      lots: r.lots ?? 0,
      side: mapSide(r.side)
    }));

    ok(res, {
      asset,
      bucket_from: fromId,
      bucket_to: toId,
      orders: {
        bucket_count: ordersBuckets.length,
        item_count: ordersRows.length,
        buckets: ordersBuckets
      },
      stops: {
        bucket_count: stopsBuckets.length,
        item_count: stopsRows.length,
        buckets: stopsBuckets
      }
    });
  } catch (e) {
    if (e?.message === 'asset_required')  return res.status(400).json({ error: 'asset_required' });
    if (e?.message === 'range_required')  return res.status(400).json({ error: 'range_required' });
    if (e?.message === 'asset_not_found') return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')        return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/range', e);
    res.status(500).json({ error: 'internal_error' });
  }
});


/* -------------------------------
   Verify states vs on-chain
   GET /verify/:ids
   Ex: /verify/1000,3000,5000,3487
-------------------------------- */
app.get('/verify/:ids', async (req, res) => {
  try {
    const raw = String(req.params.ids || '').trim();
    if (!raw) return bad(res, 'ids_required');

    const ids = Array.from(
      new Set(
        raw
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .map(n => Number(n))
          .filter(n => Number.isInteger(n) && n >= 0)
      )
    ).sort((a,b) => a - b);

    if (!ids.length) return bad(res, 'ids_invalid');

    const result = await verifyAndSync(ids);

    ok(res, {
      ok: true,
      checked: result.checked,
      updated: result.updated,
      mismatches: result.mismatches
    });
  } catch (e) {
    logErr('API+/verify', e);
    res.status(500).json({ error: 'internal_error' });
  }
});


/* -------------------------------
   404 fallback
-------------------------------- */
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

/* -------------------------------
   Start
-------------------------------- */
app.listen(PORT, '0.0.0.0', () => {
  logInfo('BROKEX', `[API+] listening on http://0.0.0.0:${PORT}`);
});

// guards
process.on('unhandledRejection', (err) => logErr('API+','unhandledRejection', err));
process.on('uncaughtException', (err) => logErr('API+','uncaughtException', err));

