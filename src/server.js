import 'dotenv/config';
import express from 'express';
import { supabase } from './shared/supabase.js';
import { logInfo, logErr } from './shared/logger.js';

const app = express();
const PORT = Number(process.env.PORT || 8080);

/** Parse string price (e.g. "108910.01") to x6 BigInt safely (no FP). */
function priceStrToX6(str) {
  if (typeof str !== 'string') str = String(str);
  const parts = str.split('.');
  const intPart = parts[0].replace(/^0+/, '') || '0';
  const fracPart = (parts[1] || '').padEnd(6, '0').slice(0, 6); // 6 decimals
  const sign = str.trim().startsWith('-') ? '-' : '';
  const digits = (intPart.replace('-', '') || '0') + fracPart;
  return BigInt(sign + digits);
}

/** GET /trader/:addr/ids
 *  Retourne seulement les IDs, classés par statut:
 *  - orders (state=0)
 *  - open (state=1)
 *  - cancelled (state=2 & close_reason=0)
 *  - closed (state=2 & close_reason IN 1..4)
 */
app.get('/trader/:addr/ids', async (req, res) => {
  try {
    const addr = String(req.params.addr || '').toLowerCase();
    if (!addr.match(/^0x[a-f0-9]{40}$/)) {
      return res.status(400).json({ error: 'invalid address (lowercase expected)' });
    }

    // Récupérer IDs en 3 requêtes (simples et lisibles)
    const [{ data: orders }, { data: open }, { data: closedAll }, { data: cancelled },] = await Promise.all([
      supabase.from('positions').select('id').eq('trader_addr_lc', addr).eq('state', 0),
      supabase.from('positions').select('id').eq('trader_addr_lc', addr).eq('state', 1),
      supabase.from('positions').select('id, close_reason').eq('trader_addr_lc', addr).eq('state', 2),
      supabase.from('positions').select('id').eq('trader_addr_lc', addr).eq('state', 2).eq('close_reason', 0),
    ]);

    const closed = (closedAll || [])
      .filter((r) => r.close_reason !== null && r.close_reason !== 0)
      .map((r) => r.id);

    res.json({
      trader: addr,
      orders: (orders || []).map((r) => r.id),
      open: (open || []).map((r) => r.id),
      cancelled: (cancelled || []).map((r) => r.id),
      closed
    });
  } catch (e) {
    logErr('API', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** GET /positions?ids=1,2,3
 *  Retourne les données d'une ou plusieurs positions.
 */
app.get('/positions', async (req, res) => {
  try {
    const idsStr = String(req.query.ids || '').trim();
    if (!idsStr) return res.status(400).json({ error: 'ids query param required' });

    const ids = idsStr.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
    if (!ids.length) return res.status(400).json({ error: 'no valid ids' });

    const { data, error } = await supabase
      .from('positions')
      .select(`
        id, state, asset_id, trader_addr_lc, long_side, lots, leverage_x,
        entry_x6, target_x6, sl_x6, tp_x6, liq_x6,
        close_reason, exec_x6, pnl_usd6,
        notional_usd6, margin_usd6, created_at, updated_at
      `)
      .in('id', ids);
    if (error) throw error;

    res.json(data || []);
  } catch (e) {
    logErr('API', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** Helper: calcule bucket_id pour (asset_id, price) */
async function computeBucketId(asset_id, priceStr) {
  const priceX6 = priceStrToX6(String(priceStr));
  const { data: asset, error } = await supabase
    .from('assets')
    .select('tick_size_usd6')
    .eq('asset_id', Number(asset_id))
    .maybeSingle();
  if (error) throw error;
  if (!asset) throw new Error('asset_not_found');
  const tick = BigInt(asset.tick_size_usd6);
  if (tick <= 0n) throw new Error('bad_tick');

  return (priceX6 / tick).toString();
}

/** GET /orders/by-price?asset=0&price=108910.01
 *  Retourne les IDs de positions en ordre LIMIT pour (asset, bucket(price)).
 */
app.get('/orders/by-price', async (req, res) => {
  try {
    const asset = Number(req.query.asset);
    const price = String(req.query.price || '').trim();
    if (!Number.isInteger(asset)) return res.status(400).json({ error: 'asset (int) required' });
    if (!price) return res.status(400).json({ error: 'price required' });

    const bucket_id = await computeBucketId(asset, price);

    const { data, error } = await supabase
      .from('order_buckets')
      .select('position_id')
      .eq('asset_id', asset)
      .eq('bucket_id', bucket_id);
    if (error) throw error;

    res.json({ asset, price, bucket_id, ids: (data || []).map((r) => r.position_id) });
  } catch (e) {
    logErr('API', e);
    if (e.message === 'asset_not_found') return res.status(404).json({ error: 'asset_not_found' });
    res.status(500).json({ error: 'internal_error' });
  }
});

/** GET /stops/by-price?asset=0&price=108910.01
 *  Retourne les IDs et types (SL/TP/LIQ) des positions indexées à ce bucket.
 */
app.get('/stops/by-price', async (req, res) => {
  try {
    const asset = Number(req.query.asset);
    const price = String(req.query.price || '').trim();
    if (!Number.isInteger(asset)) return res.status(400).json({ error: 'asset (int) required' });
    if (!price) return res.status(400).json({ error: 'price required' });

    const bucket_id = await computeBucketId(asset, price);

    const { data, error } = await supabase
      .from('stop_buckets')
      .select('position_id, stop_type')
      .eq('asset_id', asset)
      .eq('bucket_id', bucket_id);
    if (error) throw error;

    // map type -> label
    const typeLabel = (t) => (t === 1 ? 'SL' : t === 2 ? 'TP' : t === 3 ? 'LIQ' : 'UNK');

    res.json({
      asset, price, bucket_id,
      items: (data || []).map((r) => ({ id: r.position_id, type: typeLabel(r.stop_type) }))
    });
  } catch (e) {
    logErr('API', e);
    if (e.message === 'asset_not_found') return res.status(404).json({ error: 'asset_not_found' });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  logInfo('API', `listening on http://0.0.0.0:${PORT}`);
});
