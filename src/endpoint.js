// src/endpoint.js
import 'dotenv/config';
import express from 'express';
import { get } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';

const app = express();
const PORT = Number(process.env.PORT_EXTRA || 7392);

// ---------- Helpers ----------
const isHexAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(String(s || ''));
const STOP_LABEL_TO_INT = { SL: 1, TP: 2, LIQ: 3 };
const STOP_INT_TO_LABEL = { 1: 'SL', 2: 'TP', 3: 'LIQ' };

function intParam(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

// ---------- 1) Assets list ----------
// GET /assets
app.get('/assets', async (_req, res) => {
  try {
    const rows = await get('assets?select=asset_id,symbol,tick_size_usd6,lot_num,lot_den&order=asset_id.asc');
    res.json(rows || []);
  } catch (e) {
    logErr('API+', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- 2) IDs d’un trader ----------
// GET /trader/:addr/ids
app.get('/trader/:addr/ids', async (req, res) => {
  try {
    const addr = String(req.params.addr || '').trim();
    if (!isHexAddr(addr)) return res.status(400).json({ error: 'invalid address' });
    const addrLc = addr.toLowerCase();

    const [orders, open, closedAll, cancelled] = await Promise.all([
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.0&select=id&order=id.asc`),
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.1&select=id&order=id.asc`),
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.2&select=id,close_reason&order=id.asc`),
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.2&close_reason=eq.0&select=id&order=id.asc`)
    ]);

    const closed = (closedAll || [])
      .filter((r) => r.close_reason !== null && r.close_reason !== 0)
      .map((r) => r.id);

    res.json({
      trader: addrLc,
      orders: (orders || []).map((r) => r.id),
      open: (open || []).map((r) => r.id),
      cancelled: (cancelled || []).map((r) => r.id),
      closed
    });
  } catch (e) {
    logErr('API+', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- 3) Infos d’un trader (compteurs) ----------
// GET /trader/:addr
app.get('/trader/:addr', async (req, res) => {
  try {
    const addr = String(req.params.addr || '').trim();
    if (!isHexAddr(addr)) return res.status(400).json({ error: 'invalid address' });
    const addrLc = addr.toLowerCase();

    const [orders, open, cancelled, closed] = await Promise.all([
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.0&select=id`),
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.1&select=id`),
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.2&close_reason=eq.0&select=id`),
      get(`positions?trader_addr_lc=eq.${addrLc}&state=eq.2&close_reason=not.is.null&close_reason=neq.0&select=id`)
    ]);

    res.json({
      trader: addrLc,
      counts: {
        orders: orders?.length || 0,
        open: open?.length || 0,
        cancelled: cancelled?.length || 0,
        closed: closed?.length || 0
      }
    });
  } catch (e) {
    logErr('API+', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- 4) Par bucket (orders / stops) ----------
// GET /by-bucket?asset=1&bucket=20500000&type=order
// GET /by-bucket?asset=1&bucket=20500000&type=stops&stopType=SL|TP|LIQ&side=long|short&sort=type|id
app.get('/by-bucket', async (req, res) => {
  try {
    const asset  = intParam(req.query.asset, 'asset');
    const bucket = intParam(req.query.bucket, 'bucket');
    const type   = String(req.query.type || 'order').toLowerCase();  // 'order' | 'stops'
    const sort   = String(req.query.sort || '').toLowerCase();       // 'type' | 'id'
    const stopTypeStr = req.query.stopType ? String(req.query.stopType).toUpperCase() : null;
    const sideParam = req.query.side ? String(req.query.side).toLowerCase() : null; // long|short

    if (!['order', 'stops'].includes(type)) {
      return res.status(400).json({ error: 'type must be "order" or "stops"' });
    }

    if (type === 'order') {
      let q = `order_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=position_id,lots,side`;
      if (sideParam === 'long')  q += `&side=eq.true`;
      if (sideParam === 'short') q += `&side=eq.false`;

      const rows = await get(q);
      let items = (rows || []).map(r => ({
        id: Number(r.position_id),
        lots: Number(r.lots || 0),
        side: r.side ? 'LONG' : 'SHORT'
      }));
      if (sort === 'id') items.sort((a, b) => a.id - b.id);
      return res.json({ asset, bucket, kind: 'ORDER', items });
    }

    // stops
    let q = `stop_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=position_id,stop_type,lots,side`;
    if (stopTypeStr) {
      const t = STOP_LABEL_TO_INT[stopTypeStr];
      if (!t) return res.status(400).json({ error: 'stopType must be SL|TP|LIQ' });
      q += `&stop_type=eq.${t}`;
    }
    if (sideParam === 'long')  q += `&side=eq.true`;
    if (sideParam === 'short') q += `&side=eq.false`;

    let rows = await get(q);
    let items = (rows || []).map((r) => ({
      id: Number(r.position_id),
      type: STOP_INT_TO_LABEL[Number(r.stop_type)] || 'UNK',
      lots: Number(r.lots || 0),
      side: r.side ? 'LONG' : 'SHORT'
    }));

    if (sort === 'type') {
      const rank = { SL: 1, TP: 2, LIQ: 3, UNK: 9 };
      items.sort((a, b) => (rank[a.type] - rank[b.type]) || (a.id - b.id));
    } else if (sort === 'id') {
      items.sort((a, b) => a.id - b.id);
    }

    res.json({ asset, bucket, kind: 'STOPS', items });
  } catch (e) {
    logErr('API+', e);
    if (/must be an integer/.test(String(e.message))) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'internal_error' });
  }
});

// ---------- 5) Détails d’une position par ID ----------
// GET /position/:id
app.get('/position/:id', async (req, res) => {
  try {
    const idNum = intParam(req.params.id, 'id');
    const rows = await get(`positions?id=eq.${idNum}`);
    const row = rows?.[0];
    if (!row) return res.status(404).json({ error: 'position_not_found' });
    res.json(row);
  } catch (e) {
    logErr('API+', e);
    if (/must be an integer/.test(String(e.message))) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  logInfo('API+', `listening on http://0.0.0.0:${PORT}`);
});


app.listen(PORT, () => {
  logInfo('API+', `listening on http://0.0.0.0:${PORT}`);
});
