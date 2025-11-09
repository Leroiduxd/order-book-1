// src/manual.js
// ======================================================================
// BROKEX • manual sync (idempotent)
// - .env: RPC_URL, CONTRACT_ADDR, ENDPOINT (PostgREST)
// - ABI import: ./shared/abi.js  (Getters: getTrade + stateOf)
// - Modes :
//     node src/manual.js --end=700 --count=100
//     node src/manual.js --ids=620,621,700
// ======================================================================

import 'dotenv/config';
import { ethers } from 'ethers';
import { ABI } from './shared/abi.js';

// ---------- ENV ----------
const RPC_URL       = process.env.RPC_URL;
const CONTRACT_ADDR = (process.env.CONTRACT_ADDR || '').trim();
const ENDPOINT      = (process.env.ENDPOINT || 'http://127.0.0.1:9304').replace(/\/+$/, '');

if (!RPC_URL)       throw new Error('RPC_URL manquant dans .env');
if (!CONTRACT_ADDR) throw new Error('CONTRACT_ADDR manquant dans .env');

const TAG = 'Manual';

// ---------- HTTP helpers (PostgREST) ----------
async function httpGet(path) {
  const r = await fetch(`${ENDPOINT}/${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status} ${await r.text()}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : null;
}
async function httpPostArr(path, arr) {
  const r = await fetch(`${ENDPOINT}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Prefer':'return=minimal, resolution=ignore-duplicates' },
    body: JSON.stringify(arr)
  });
  if (!r.ok && r.status !== 409) throw new Error(`POST ${path} -> HTTP ${r.status} ${await r.text()}`);
}
async function httpPatch(path, body) {
  const r = await fetch(`${ENDPOINT}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type':'application/json', 'Prefer':'return=minimal' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`PATCH ${path} -> HTTP ${r.status} ${await r.text()}`);
}
async function httpDel(path) {
  const r = await fetch(`${ENDPOINT}/${path}`, {
    method: 'DELETE',
    headers: { 'Prefer':'return=minimal' }
  });
  if (!r.ok) throw new Error(`DELETE ${path} -> HTTP ${r.status} ${await r.text()}`);
}

// ---------- Utils ----------
const log = (...a) => console.log(`[BROKEX][${TAG}]`, ...a);
const BI  = (x) => BigInt(x);
const toBool = (n)=> Boolean(n); // pour flags -> longSide si tu l’utilises plus tard

// Récupère l’asset pour connaître son tick_size_usd6
const assetCache = new Map();
async function getAsset(asset_id) {
  const k = Number(asset_id);
  if (assetCache.has(k)) return assetCache.get(k);
  const rows = await httpGet(`assets?asset_id=eq.${k}&select=asset_id,tick_size_usd6,lot_num,lot_den`);
  const row = rows?.[0];
  if (!row) throw new Error(`Asset ${k} introuvable`);
  assetCache.set(k, row);
  return row;
}
const divFloor = (a,b) => a / b;

// Vérifie présence d’index existants en DB pour cette position
async function readOrderBucket(positionId) {
  const rows = await httpGet(`order_buckets?position_id=eq.${positionId}`);
  return rows || [];
}
async function readStopBuckets(positionId) {
  const rows = await httpGet(`stop_buckets?position_id=eq.${positionId}`);
  return rows || [];
}

// Calcule le bucket d’un prix (x6) pour un asset
async function priceToBucket(asset_id, price_x6) {
  const asset = await getAsset(asset_id);
  const tick  = BI(asset.tick_size_usd6);
  return divFloor(BI(price_x6), tick).toString();
}

// ---------- Ethers (RPC) ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const iface    = new ethers.Interface(ABI.Getters);
const contract = new ethers.Contract(CONTRACT_ADDR, iface, provider);

async function readChain(id) {
  // stateOf: 0=ORDER,1=OPEN,2=CLOSED,3=CANCELLED
  const state = Number(await contract.stateOf(id));
  // getTrade struct
  const t = await contract.getTrade(id);
  return {
    state,
    owner: t.owner,
    asset: Number(t.asset),
    lots: Number(t.lots),
    leverageX: Number(t.leverageX),
    entryX6: Number(t.entryX6),   // pour OPEN
    targetX6: Number(t.targetX6), // pour ORDER
    slX6: Number(t.slX6),
    tpX6: Number(t.tpX6),
    liqX6: Number(t.liqX6),
    marginUsd6: Number(t.marginUsd6),
    longSide: null // si tu stockes longSide côté event, garde DB comme source pour longSide
  };
}

// ---------- DB read ----------
async function readDbPosition(id) {
  const rows = await httpGet(`positions?id=eq.${id}`);
  return rows?.[0] || null;
}

// ---------- Indexers (idempotents) ----------
async function ensureOrderIndex(asset_id, position_id, target_x6, lots, side) {
  // compare bucket actuel vs DB
  const wantBucket = await priceToBucket(Number(asset_id), Number(target_x6));
  const have = await readOrderBucket(position_id);
  const already = have.some(r => String(r.bucket_id) === String(wantBucket) && Number(r.lots) === Number(lots) && Boolean(r.side) === Boolean(side));
  if (!already) {
    // nettoie puis insère le bon
    await httpDel(`order_buckets?position_id=eq.${position_id}`);
    await httpPostArr(
      'order_buckets?on_conflict=asset_id,bucket_id,position_id',
      [{
        asset_id: Number(asset_id),
        bucket_id: wantBucket,
        position_id: Number(position_id),
        lots: Number(lots || 0),
        side: Boolean(side)
      }]
    );
    return true;
  }
  return false;
}

async function ensureStopsIndex(asset_id, position_id, sl_x6, tp_x6, liq_x6, lots, long_side) {
  // On veut SL/TP/LIQ indexés sur la **side antagoniste**
  const want = [];
  if (Number(sl_x6))  want.push({ type: 1, px: Number(sl_x6)  });
  if (Number(tp_x6))  want.push({ type: 2, px: Number(tp_x6)  });
  if (Number(liq_x6)) want.push({ type: 3, px: Number(liq_x6) });

  const have = await readStopBuckets(position_id);
  // calcul des buckets cibles
  const wantExpanded = [];
  for (const w of want) {
    const bucket = await priceToBucket(Number(asset_id), Number(w.px));
    wantExpanded.push({ stop_type: w.type, bucket_id: bucket });
  }

  // Détecte si déjà en place
  let equal = true;
  for (const w of wantExpanded) {
    const match = have.find(r =>
      Number(r.stop_type) === Number(w.stop_type) &&
      String(r.bucket_id) === String(w.bucket_id) &&
      Number(r.lots) === Number(lots) &&
      Boolean(r.side) === !Boolean(long_side)
    );
    if (!match) { equal = false; break; }
  }
  if (equal && wantExpanded.length === have.length) return false; // no-op exact

  // Sinon, on supprime tout et on remet proprement (simple & sûr)
  await httpDel(`stop_buckets?position_id=eq.${position_id}`);
  if (!wantExpanded.length) return true;

  await httpPostArr(
    'stop_buckets?on_conflict=asset_id,bucket_id,position_id,stop_type',
    wantExpanded.map(w => ({
      asset_id: Number(asset_id),
      bucket_id: String(w.bucket_id),
      position_id: Number(position_id),
      stop_type: Number(w.stop_type),
      lots: Number(lots || 0),
      side: !Boolean(long_side)
    }))
  );
  return true;
}

// ---------- Reconcil per ID ----------
async function processId(id) {
  let created = 0, fixedState = 0, fixedIdx = 0, closed = 0, skipped = 0;

  // 1) Lire on-chain
  let chain;
  try { chain = await readChain(id); }
  catch { skipped++; return { created, fixedState, fixedIdx, closed, skipped }; }

  // si pas d’owner => rien
  if (!chain?.owner || chain.owner === ethers.ZeroAddress) { skipped++; return { created, fixedState, fixedIdx, closed, skipped }; }

  // 2) Lire DB
  const db = await readDbPosition(id);

  // 3) Si pas en DB -> créer (comme Opened)
  if (!db) {
    // Besoin de long_side/lots/leverage: on les dérive de chain (long_side: garde false par défaut si inconnu)
    const body = {
      id: Number(id),
      state: Number(chain.state),
      asset_id: Number(chain.asset),
      trader_addr: String(chain.owner),
      long_side: Boolean(db?.long_side ?? true), // si tu ne peux pas déduire ici, laisse true par défaut
      lots: Number(chain.lots || 0),
      leverage_x: Number(chain.leverageX || 0),
      entry_x6: chain.state === 1 ? String(chain.entryX6) : null,
      target_x6: chain.state === 0 ? String(chain.targetX6) : null,
      sl_x6: String(chain.slX6 || 0),
      tp_x6: String(chain.tpX6 || 0),
      liq_x6: String(chain.liqX6 || 0),
      notional_usd6: null,
      margin_usd6:   null
    };
    await httpPostArr('positions?on_conflict=id', [ body ]);

    if (chain.state === 0) {
      const touched = await ensureOrderIndex(chain.asset, id, chain.targetX6, chain.lots, /*side=*/true);
      if (touched) fixedIdx++;
    } else if (chain.state === 1) {
      const touched = await ensureStopsIndex(chain.asset, id, chain.slX6, chain.tpX6, chain.liqX6, chain.lots, /*long_side=*/true);
      if (touched) fixedIdx++;
    }
    created++;
    return { created, fixedState, fixedIdx, closed, skipped };
  }

  // 4) Déjà en DB -> réconciliation
  // a) Etat (seulement si différent)
  if (Number(db.state) !== Number(chain.state)) {
    await httpPatch(`positions?id=eq.${id}`, { state: Number(chain.state) });
    fixedState++;
  }

  // b) Indexation selon l’état on-chain
  if (chain.state === 0) {
    // ORDER: target
    const touched1 = await ensureOrderIndex(db.asset_id, id, chain.targetX6 || db.target_x6, db.lots, db.long_side);
    // supprimer les stops s’ils existent
    const haveStops = await readStopBuckets(id);
    if (haveStops.length) { await httpDel(`stop_buckets?position_id=eq.${id}`); fixedIdx++; }
    if (touched1) fixedIdx++;
  } else if (chain.state === 1) {
    // OPEN: SL/TP/LIQ antagonistes
    // Supprimer l’ORDER s’il existe
    const haveOrder = await readOrderBucket(id);
    if (haveOrder.length) { await httpDel(`order_buckets?position_id=eq.${id}`); fixedIdx++; }
    const touched2 = await ensureStopsIndex(db.asset_id, id,
      chain.slX6 || db.sl_x6, chain.tpX6 || db.tp_x6, chain.liqX6 || db.liq_x6,
      db.lots, db.long_side
    );
    if (touched2) fixedIdx++;
  } else if (chain.state === 2 || chain.state === 3) {
    // CLOSED / CANCELLED : supprimer tout index prix, mais NE PAS supprimer la position
    const haveOrder = await readOrderBucket(id);
    const haveStops = await readStopBuckets(id);
    if (haveOrder.length) { await httpDel(`order_buckets?position_id=eq.${id}`); fixedIdx++; }
    if (haveStops.length) { await httpDel(`stop_buckets?position_id=eq.${id}`); fixedIdx++; }
    closed++;
  }

  return { created, fixedState, fixedIdx, closed, skipped };
}

// ---------- CLI parsing ----------
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
  return [k, v];
}));

let ids = [];
if (flags.ids) {
  ids = String(flags.ids).split(',').map(s=>Number(s.trim())).filter(n=>Number.isInteger(n) && n>=0);
} else {
  const END   = Number(flags.end ?? NaN);
  const COUNT = Math.max(1, Math.min(Number(flags.count ?? 100), 500));
  if (!Number.isInteger(END) || END < 0) {
    console.error('Usage: node src/manual.js --end=<uint32> [--count=100]  |  --ids=1,2,3');
    process.exit(1);
  }
  const START = Math.max(0, END - COUNT + 1);
  ids = Array.from({length: END - START + 1}, (_,i)=> START + i);
}

log(`RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDR}`);
log(`MODE=${flags.ids?'list':'full'} | ids=${ids.length}`);

(async () => {
  let acc = { created:0, fixedState:0, fixedIdx:0, closed:0, skipped:0 };
  for (const id of ids) {
    try {
      const res = await processId(id);
      acc.created   += res.created;
      acc.fixedState+= res.fixedState;
      acc.fixedIdx  += res.fixedIdx;
      acc.closed    += res.closed;
      acc.skipped   += res.skipped;
    } catch (e) {
      // on ignore les ids foireux
    }
  }
  log(`Done. scanned=${ids.length} created=${acc.created} fixedState=${acc.fixedState} fixedIdx=${acc.fixedIdx} closed=${acc.closed} skipped=${acc.skipped}`);
})().catch(e => { console.error(e); process.exit(1); });
