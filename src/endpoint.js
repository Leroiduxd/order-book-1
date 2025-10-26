// src/endpoint.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { get } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';

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
   Health
-------------------------------- */
app.get('/health', async (_req, res) => {
  try {
    // ping minimal PostgREST
    await get('assets?select=asset_id&limit=1');
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
   Buckets: orders & stops
   /bucket/orders?asset=0&price=108910.01   (ou &bucket=12345)
   /bucket/stops?asset=0&price=108910.01    (ou &bucket=12345)
   Options:
     - side=long|short|all (def all)
     - sort=lots|id  (def lots)
     - order=desc|asc (def desc)
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
    const asset = Number(req.query.asset);
    if (!Number.isInteger(asset)) return bad(res, 'asset_required');

    let bucket = String(req.query.bucket || '').trim();
    const price = String(req.query.price || '').trim();
    if (!bucket && !price) return bad(res, 'price_or_bucket_required');

    if (!bucket) {
      const priceX6 = priceStrToX6(price);
      bucket = await computeBucketId(asset, priceX6);
    }

    const side = parseSideFilter(req.query);
    const sort = parseSort(req.query);
    const ord  = parseOrder(req.query);

    // base query
    let qp = `order_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=position_id,lots,side&order=${sort}.${ord}`;
    if (side !== null) qp += `&side=eq.${side}`;

    const rows = await get(qp);
    ok(res, {
      asset,
      bucket_id: bucket,
      count: rows?.length || 0,
      items: (rows || []).map(r => ({
        id: r.position_id, lots: r.lots ?? 0, side: r.side === true ? 'LONG' : 'SHORT'
      }))
    });
  } catch (e) {
    if (e?.message === 'asset_not_found') return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')       return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/orders', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/bucket/stops', async (req, res) => {
  try {
    const asset = Number(req.query.asset);
    if (!Number.isInteger(asset)) return bad(res, 'asset_required');

    let bucket = String(req.query.bucket || '').trim();
    const price = String(req.query.price || '').trim();
    if (!bucket && !price) return bad(res, 'price_or_bucket_required');

    if (!bucket) {
      const priceX6 = priceStrToX6(price);
      bucket = await computeBucketId(asset, priceX6);
    }

    const side = parseSideFilter(req.query);
    const sort = parseSort(req.query);
    const ord  = parseOrder(req.query);

    let qp = `stop_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=position_id,stop_type,lots,side&order=${sort}.${ord}`;
    if (side !== null) qp += `&side=eq.${side}`;

    const rows = await get(qp);
    const label = (t) => (t === 1 ? 'SL' : t === 2 ? 'TP' : t === 3 ? 'LIQ' : 'UNK');

    ok(res, {
      asset,
      bucket_id: bucket,
      count: rows?.length || 0,
      items: (rows || []).map(r => ({
        id: r.position_id,
        type: label(r.stop_type),
        lots: r.lots ?? 0,
        side: r.side === true ? 'LONG' : 'SHORT'
      }))
    });
  } catch (e) {
    if (e?.message === 'asset_not_found') return res.status(404).json({ error: 'asset_not_found' });
    if (e?.message === 'bad_tick')       return res.status(400).json({ error: 'bad_tick' });
    logErr('API+/bucket/stops', e);
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
    // format “joli” groupé long/short
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

