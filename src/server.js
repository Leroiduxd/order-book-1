import 'dotenv/config';
import express from 'express';
import { query } from './shared/pg.js';
import { logInfo, logErr } from './shared/logger.js';

const app = express();
const PORT = Number(process.env.PORT || 8080);

/** Parse "108910.01" -> x6 BigInt string (sans float) */
function priceStrToX6(str) {
  if (typeof str !== 'string') str = String(str);
  const sign = str.trim().startsWith('-') ? '-' : '';
  const [i, f = ''] = str.replace('-', '').split('.');
  const intPart = (i || '0').replace(/^0+/, '') || '0';
  const fracPart = f.padEnd(6, '0').slice(0, 6);
  return sign + intPart + fracPart;
}

/** GET /trader/:addr/ids  (équivalent à avant) */
app.get('/trader/:addr/ids', async (req, res) => {
  try {
    const addr = String(req.params.addr || '');
    if (!addr.match(/^0x[a-fA-F0-9]{40}$/)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    const { rows } = await query(`select public.get_trader_ids_grouped($1::text) as data`, [addr]);
    const data = rows?.[0]?.data || {};
    // Harmonisation avec ton ancien shape
    res.json({
      trader: addr,
      orders: data.order ?? [],
      open: data.open ?? [],
      cancelled: data.cancelled ?? [],
      closed: data.closed ?? []
    });
  } catch (e) {
    logErr('API', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** GET /positions?ids=1,2,3  -> renvoie lignes complètes depuis trades */
app.get('/positions', async (req, res) => {
  try {
    const idsStr = String(req.query.ids || '').trim();
    if (!idsStr) return res.status(400).json({ error: 'ids query param required' });

    const ids = idsStr.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0);
    if (!ids.length) return res.status(400).json({ error: 'no valid ids' });

    const { rows } = await query(
      `select * from public.trades where id = any($1::int8[])`,
      [ids]
    );
    res.json(rows || []);
  } catch (e) {
    logErr('API', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

/** Helper: calcule bucket_id pour (asset, priceStr) -> en appelant price_to_bucket */
async function computeBucketId(asset_id, priceStr) {
  const x6 = priceStrToX6(priceStr);
  const { rows } = await query(
    `select public.price_to_bucket($1::int4, $2::int8) as bucket`,
    [Number(asset_id), x6]
  );
  if (!rows.length || rows[0].bucket === null) throw new Error('bad_asset_or_tick');
  return String(rows[0].bucket);
}

/** GET /orders/by-price?asset=0&price=108910.01
 *  Renvoie toutes les IDs sur ce bucket (ORDER/SL/TP/LIQ) et on filtre côté Node si besoin.
 *  (Toi tu visualisais les LIMIT uniquement ici => on renvoie uniquement ORDER pour compat)
 */
app.get('/orders/by-price', async (req, res) => {
  try {
    const asset = Number(req.query.asset);
    const price = String(req.query.price || '').trim();
    if (!Number.isInteger(asset)) return res.status(400).json({ error: 'asset (int) required' });
    if (!price) return res.status(400).json({ error: 'price required' });

    const bucket_id = await computeBucketId(asset, price);
    const x6 = priceStrToX6(price);

    const { rows } = await query(
      `select * from public.get_ids_by_tick($1::int4, $2::int8)`,
      [asset, x6]
    );

    const ids = (rows || [])
      .filter(r => r.kind === 'ORDER')
      .map(r => Number(r.id));

    res.json({ asset, price, bucket_id, ids });
  } catch (e) {
    logErr('API', e);
    if (e.message === 'bad_asset_or_tick') return res.status(404).json({ error: 'asset_not_found_or_bad_tick' });
    res.status(500).json({ error: 'internal_error' });
  }
});

/** GET /stops/by-price?asset=0&price=108910.01
 *  Renvoie IDs + types (SL/TP/LIQ) pour ce bucket.
 */
app.get('/stops/by-price', async (req, res) => {
  try {
    const asset = Number(req.query.asset);
    const price = String(req.query.price || '').trim();
    if (!Number.isInteger(asset)) return res.status(400).json({ error: 'asset (int) required' });
    if (!price) return res.status(400).json({ error: 'price required' });

    const bucket_id = await computeBucketId(asset, price);
    const x6 = priceStrToX6(price);

    const { rows } = await query(
      `select * from public.get_ids_by_tick($1::int4, $2::int8)`,
      [asset, x6]
    );

    const typeMap = { SL: 'SL', TP: 'TP', LIQ: 'LIQ' };
    const items = (rows || [])
      .filter(r => r.kind === 'SL' || r.kind === 'TP' || r.kind === 'LIQ')
      .map(r => ({ id: Number(r.id), type: typeMap[r.kind] || 'UNK' }));

    res.json({ asset, price, bucket_id, items });
  } catch (e) {
    logErr('API', e);
    if (e.message === 'bad_asset_or_tick') return res.status(404).json({ error: 'asset_not_found_or_bad_tick' });
    res.status(500).json({ error: 'internal_error' });
  }
});

app.listen(PORT, () => {
  logInfo('API', `listening on http://0.0.0.0:${PORT}`);
});

