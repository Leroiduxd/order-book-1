// ======================================================================
// BROKEX • backfill_missing_auto
// - Compare DB max id vs chain nextId()-1
// - If equal: run manual_backfill ONLY on the missing holes (skip 0)
// - Else: run manual_backfill on (missing holes + tail [dbMax+1..chainMax]) (skip 0)
// - Chunks ids to avoid long argv
//
// Usage:
//   node src/backfill_missing_auto.js
//
// Env (reuse from your project):
//   RPC_URL / RPC_HTTP        → EVM RPC
//   CONTRACT_ADDR             → contract address (has nextId())
//   POSTGREST_URL             → your PostgREST base (same used by shared/rest.js)
//   BACKFILL_CHUNK_SIZE?      → optional, default 400
//   DB_PAGE_SIZE?             → optional, default 10000
// ======================================================================

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import fetch from 'node-fetch';

// ---------- ENV ----------
const RPC_URL       = (process.env.RPC_URL || process.env.RPC_HTTP || '').trim();
const CONTRACT_ADDR = (process.env.CONTRACT_ADDR || '').trim();
const POSTGREST_URL = (process.env.POSTGREST_URL || process.env.REST_URL || process.env.POSTGREST_ENDPOINT || '').trim();
if (!RPC_URL)       throw new Error('RPC_URL manquant');
if (!CONTRACT_ADDR) throw new Error('CONTRACT_ADDR manquant');
if (!POSTGREST_URL) throw new Error('POSTGREST_URL manquant (ex: http://127.0.0.1:9304)');

const CHUNK = Math.max(1, Number(process.env.BACKFILL_CHUNK_SIZE || 400));
const DB_PAGE_SIZE = Math.max(1000, Number(process.env.DB_PAGE_SIZE || 10000));

const TAG = 'AutoBackfill';

// ---------- ETHERS (nextId) ----------
const ABI_NEXTID = [
  { inputs: [], name: 'nextId', outputs: [{ internalType: 'uint32', name: '', type: 'uint32' }], stateMutability: 'view', type: 'function' }
];
const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDR, ABI_NEXTID, provider);

// ---------- Helpers ----------
const log = (...a) => console.log(new Date().toISOString(), `[${TAG}]`, ...a);
const err = (...a) => console.error(new Date().toISOString(), `[${TAG}]`, ...a);

async function pgGet(path) {
  const url = `${POSTGREST_URL.replace(/\/+$/,'')}/${path.replace(/^\/+/,'')}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`GET ${path} -> HTTP ${r.status} :: ${t}`);
  }
  return r.json();
}

async function getDbMaxId() {
  const rows = await pgGet('positions?select=id&order=id.desc&limit=1');
  const maxId = rows?.[0]?.id;
  if (maxId === undefined || maxId === null) return -1;
  const n = Number(maxId);
  return Number.isFinite(n) ? n : -1;
}

async function getAllDbIds() {
  // paginate ids ascending
  const seen = new Set();
  for (let offset = 0; ; offset += DB_PAGE_SIZE) {
    const rows = await pgGet(`positions?select=id&order=id.asc&limit=${DB_PAGE_SIZE}&offset=${offset}`);
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      const n = Number(r.id);
      if (Number.isInteger(n)) seen.add(n);
    }
    if (rows.length < DB_PAGE_SIZE) break;
  }
  return seen;
}

function computeMissingIds(seen, maxId, { skipZero = true } = {}) {
  const out = [];
  const start = skipZero ? 1 : 0;
  for (let i = start; i <= maxId; i++) {
    if (!seen.has(i)) out.push(i);
  }
  return out;
}

function chunkIds(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function callManualBackfill(idsChunk) {
  return new Promise((resolve) => {
    const args = ['src/manual_backfill.js', `--ids=${idsChunk.join(',')}`];
    const p = spawn('node', args, { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 0));
  });
}

// ---------- Main ----------
(async () => {
  log(`RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDR} | POSTGREST=${POSTGREST_URL}`);

  // 1) Chain max = nextId() - 1
  let chainNext, chainMax;
  try {
    chainNext = await contract.nextId();
    chainMax = Number(chainNext) - 1;
  } catch (e) {
    err('Erreur nextId():', e?.shortMessage || e?.message || e);
    process.exit(1);
  }
  if (!Number.isInteger(chainMax)) {
    err('chainMax invalide');
    process.exit(1);
  }
  log(`Chain nextId=${String(chainNext)} => chainMax=${chainMax}`);

  // 2) DB max
  const dbMax = await getDbMaxId();
  log(`DB maxId=${dbMax}`);

  // 3) Fetch all DB ids & compute missing up to dbMax
  const seen = await getAllDbIds();
  const missingUpToDb = computeMissingIds(seen, dbMax, { skipZero: true });

  // 4) If dbMax < chainMax, add the tail [dbMax+1 .. chainMax]
  let idsToBackfill = [];
  if (dbMax === chainMax) {
    idsToBackfill = missingUpToDb;
    log(`dbMax === chainMax → only holes: missing=${idsToBackfill.length}`);
  } else {
    const tailStart = Math.max(1, dbMax + 1);
    const tail = tailStart <= chainMax ? Array.from({ length: chainMax - tailStart + 1 }, (_, i) => tailStart + i) : [];
    idsToBackfill = Array.from(new Set([...missingUpToDb, ...tail])).sort((a,b)=>a-b);
    log(`dbMax(${dbMax}) != chainMax(${chainMax}) → holes + tail. missing=${missingUpToDb.length}, tail=${tail.length}, total=${idsToBackfill.length}`);
  }

  if (idsToBackfill.length === 0) {
    log('Rien à backfiller. ✅');
    process.exit(0);
  }

  // 5) Chunk + call manual_backfill
  const chunks = chunkIds(idsToBackfill, CHUNK);
  log(`Backfill in ${chunks.length} chunk(s) of ≤ ${CHUNK} ids ...`);

  let fail = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    log(`Chunk ${i+1}/${chunks.length}: ids=[${c[0]}..${c[c.length-1]}] (${c.length})`);
    const code = await callManualBackfill(c);
    if (code !== 0) {
      fail++;
      err(`manual_backfill exited with code=${code} for chunk ${i+1}`);
    }
  }

  if (fail > 0) {
    err(`Terminé avec ${fail} chunk(s) en erreur.`);
    process.exit(2);
  }

  log('Terminé sans erreur. ✅');
  process.exit(0);
})().catch((e) => { err(e?.message || e); process.exit(1); });
