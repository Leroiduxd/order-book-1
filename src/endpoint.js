// ===============================================
// BROKEX — Public API (endpoint.js)
// ===============================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { get } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';

const app = express();
app.use(cors());
app.use(express.json());

const ENDPOINT = process.env.ENDPOINT || 'http://127.0.0.1:9304';
const PORT = Number(process.env.PORT_EXTRA || 7392);

console.log('[REST] Using PostgREST ENDPOINT =', ENDPOINT);
console.log('[API+] PORT =', PORT);

// =========================================================
// Endpoint: GET /assets
// =========================================================
app.get('/assets', async (req, res) => {
  try {
    const rows = await get('assets?select=*');
    res.json(rows);
  } catch (err) {
    logErr('API /assets', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================
// Endpoint: GET /trader/:addr/ids
// Renvoie les IDs groupés par state pour un trader
// =========================================================
app.get('/trader/:addr/ids', async (req, res) => {
  try {
    const addr = String(req.params.addr).toLowerCase();
    if (!addr.match(/^0x[a-f0-9]{40}$/)) {
      return res.status(400).json({ error: 'invalid address (lowercase expected)' });
    }

    const rows = await get(`positions?trader_addr_lc=eq.${addr}&select=id,state,close_reason&order=id.asc`);
    const grouped = { orders: [], open: [], closed: [], cancelled: [] };

    for (const r of rows) {
      if (r.state === 0) grouped.orders.push(r.id);
      else if (r.state === 1) grouped.open.push(r.id);
      else if (r.state === 2 && r.close_reason === 0) grouped.cancelled.push(r.id);
      else if (r.state === 2) grouped.closed.push(r.id);
    }

    res.json({ trader: addr, ...grouped });
  } catch (err) {
    logErr('API /trader/:addr/ids', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================
// Endpoint: GET /trader/:addr
// Renvoie les positions complètes d’un trader
// =========================================================
app.get('/trader/:addr', async (req, res) => {
  try {
    const addr = String(req.params.addr).toLowerCase();
    if (!addr.match(/^0x[a-f0-9]{40}$/)) {
      return res.status(400).json({ error: 'invalid address (lowercase expected)' });
    }

    const rows = await get(
      `positions?trader_addr_lc=eq.${addr}&select=id,state,asset_id,long_side,lots,leverage_x,entry_x6,target_x6,sl_x6,tp_x6,liq_x6,close_reason,exec_x6,pnl_usd6,notional_usd6,margin_usd6,created_at,updated_at&order=id.asc`
    );
    res.json(rows);
  } catch (err) {
    logErr('API /trader/:addr', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================
// Endpoint: GET /position/:id
// Renvoie toutes les infos d’une position précise
// =========================================================
app.get('/position/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

    const rows = await get(`positions?id=eq.${id}&select=*`);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    res.json(rows[0]);
  } catch (err) {
    logErr('API /position/:id', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================
// Endpoint: GET /by-bucket?asset=0&bucket=10917030&type=order|stops
// Retourne les positions correspondant à ce bucket
// =========================================================
app.get('/by-bucket', async (req, res) => {
  try {
    const asset = Number(req.query.asset);
    const bucket = String(req.query.bucket || '').trim();
    const type = String(req.query.type || 'order');

    if (!Number.isInteger(asset)) return res.status(400).json({ error: 'asset (int) required' });
    if (!bucket) return res.status(400).json({ error: 'bucket required' });

    let table = type === 'stops' ? 'stop_buckets' : 'order_buckets';
    const rows = await get(`${table}?asset_id=eq.${asset}&bucket_id=eq.${bucket}&select=*`);
    res.json(rows);
  } catch (err) {
    logErr('API /by-bucket', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// =========================================================
// Anti double-listen guard + startup
// =========================================================
if (!global.__BROKEX_ENDPOINT_STARTED__) {
  global.__BROKEX_ENDPOINT_STARTED__ = true;

  process.on('unhandledRejection', (err) => console.error('[API+] UnhandledRejection:', err));
  process.on('uncaughtException', (err) => console.error('[API+] UncaughtException:', err));

  app.listen(PORT, '0.0.0.0', () => {
    logInfo('BROKEX[API+]', `listening on http://0.0.0.0:${PORT}`);
  });
} else {
  console.log('[API+] listen() skipped (already started)');
}
