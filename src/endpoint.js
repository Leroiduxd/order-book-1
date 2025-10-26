// src/endpoint.js
import 'dotenv/config';
import express from 'express';
import { get } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';

const app = express();

/** Configure ton port public ici (exposé sur le VPS) */
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
// Retourne la liste des actifs (adapter les colonnes si besoin)
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
// -> { trader, orders:[], open:[], cancelled:[], closed:[] }
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
// -> { trader, counts: { orders, open, cancelled, closed } }
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
// GET /by-bucket?asset=1&bucket=20500000&type=stops&stopType=SL|TP|LIQ&sort=type|id
//
// type=order  -> items: [{ id }]
// type=stops  -> items: [{ id, type: 'SL'|'TP'|'LIQ' }]
app.get('/by-bucket', async (req, res) => {
  try {
    const asset  = intParam(req.query.asset, 'asset');
    const bucket = intParam(req.query.bucket, 'bucket');
    const type   = String(req.query.type || 'order').toLowerCase();
    const sort   = String(req.query.sort || '').toLowerCase();
    const stopTypeStr = req.query.stopType ? String(req.query.stopType).toUpperCase() : null;

    if (!['order', 'stops'].includes(type)) {
      return res.status(400).json({ error: 'type must be "order" or "stops"' });
    }

    if (type === 'order') {
      const rows = await get(`order_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=position_id`);
      let ids = (rows || []).map((r) => Number(r.position_id));
      if (sort === 'id') ids = ids.sort((a, b) => a - b);
      return res.json({ asset, bucket, kind: 'ORDER', items: ids.map((id) => ({ id })) });
    }

    // stops
    let q = `stop_buckets?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=position_id,stop_type`;
    if (stopTypeStr) {
      const t = STOP_LABEL_TO_INT[stopTypeStr];
      if (!t) return res.status(400).json({ error: 'stopType must be SL|TP|LIQ' });
      q += `&stop_type=eq.${t}`;
    }

    let rows = await get(q);
    let items = (rows || []).map((r) => ({
      id: Number(r.position_id),
      type: STOP_INT_TO_LABEL[Number(r.stop_type)] || 'UNK'
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
// -> retourne la ligne complète depuis `positions` (404 si non trouvé)
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
