// manual.js
// Node ESM – exécute un batch "API -> RPC fallback -> VERIFY" sur une plage d'IDs
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { ethers } from 'ethers';

// On réutilise ta config existante (bases, contrat, rpc)
import { API_BASE, VERIFY_BASE, EXECUTOR_ADDR as CONTRACT_ADDRESS, EXECUTOR_RPC as RPC_URL } from './config.js';

// ---------- Options ----------
const MAX_API_PARALLEL = 200;   // ne pas surcharger l'API
const MAX_RPC_PARALLEL = 50;    // limiter la pression RPC
const SLEEP_BETWEEN_PHASE_MS = 300; // micro-pause entre phases

// CLI: --end=12345 --count=100
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
  return [k, v];
}));

const END_ID = Number(flags.end ?? NaN);
const COUNT  = Math.max(1, Math.min( Number(flags.count ?? 100), 500 )); // borne 1..500

if (!Number.isInteger(END_ID) || END_ID < 0) {
  console.error('Usage: node manual.js --end=<uint32 last ID> [--count=100]');
  process.exit(1);
}

const START_ID = Math.max(0, END_ID - COUNT + 1);
const IDS = Array.from({ length: END_ID - START_ID + 1 }, (_, i) => START_ID + i);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- ABI minimal getTrade(uint32) (inline, comme demandé) ----------
const TRADES_ABI = [{
  "inputs":[{"internalType":"uint32","name":"id","type":"uint32"}],
  "name":"getTrade",
  "outputs":[{"components":[
    {"internalType":"address","name":"owner","type":"address"},
    {"internalType":"uint32","name":"asset","type":"uint32"},
    {"internalType":"uint16","name":"lots","type":"uint16"},
    {"internalType":"uint8","name":"flags","type":"uint8"},
    {"internalType":"uint8","name":"_pad0","type":"uint8"},
    {"internalType":"int64","name":"entryX6","type":"int64"},
    {"internalType":"int64","name":"targetX6","type":"int64"},
    {"internalType":"int64","name":"slX6","type":"int64"},
    {"internalType":"int64","name":"tpX6","type":"int64"},
    {"internalType":"int64","name":"liqX6","type":"int64"},
    {"internalType":"uint16","name":"leverageX","type":"uint16"},
    {"internalType":"uint16","name":"_pad1","type":"uint16"},
    {"internalType":"uint64","name":"marginUsd6","type":"uint64"}],
    "internalType":"struct Trades.Trade","name":"","type":"tuple"}],
  "stateMutability":"view","type":"function"
}];

// ---------- Helpers ----------
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function runWithConcurrency(tasks, max) {
  const res = new Array(tasks.length);
  let i = 0, running = 0;
  return new Promise(resolve => {
    const launch = () => {
      while (running < max && i < tasks.length) {
        const idx = i++;
        running++;
        tasks[idx]()
          .then(v => { res[idx] = { ok: true, v }; })
          .catch(e => { res[idx] = { ok: false, e }; })
          .finally(() => {
            running--;
            if (i < tasks.length) launch();
            else if (running === 0) resolve(res);
          });
      }
    };
    launch();
  });
}

async function fetchAPIPosition(id) {
  const url = `${API_BASE}/position/${id}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { id, ok: false, reason: `HTTP ${r.status}` };
    const json = await r.json().catch(() => null);
    if (!json || json?.error === 'position_not_found') return { id, ok: false, reason: json?.error || 'not_found' };
    return { id, ok: true, data: json };
  } catch (e) {
    return { id, ok: false, reason: e?.message || String(e) };
  }
}

async function getTradeRPC(contract, id) {
  try {
    const t = await contract.getTrade(id);
    return { id, ok: true, trade: t };
  } catch (e) {
    return { id, ok: false, reason: e?.shortMessage || e?.message || String(e) };
  }
}

function pingVerify(ids) {
  if (!ids?.length) return;
  const url = `${VERIFY_BASE}/verify/${ids.join(',')}`;
  // fire-and-forget
  fetch(url).catch(() => {});
}

// ---------- Main ----------
(async function main() {
  log(`Manual verify: IDs ${START_ID}..${END_ID} (count=${IDS.length})`);
  log(`API_BASE=${API_BASE} | VERIFY_BASE=${VERIFY_BASE}`);
  log(`RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDRESS}`);

  // 1) Phase API (par chunks, concurrence MAX_API_PARALLEL)
  log(`Phase API: ${IDS.length} requêtes (≤${MAX_API_PARALLEL} //)…`);
  const apiTasks = IDS.map(id => () => fetchAPIPosition(id));
  const apiRes = await runWithConcurrency(apiTasks, Math.min(MAX_API_PARALLEL, apiTasks.length));

  const apiOk   = [];
  const apiMiss = []; // à compléter par RPC
  apiRes.forEach((r, idx) => {
    const id = IDS[idx];
    if (r.ok && r.v?.ok) apiOk.push(id);
    else apiMiss.push(id);
  });

  log(`API OK=${apiOk.length} | API MISS=${apiMiss.length}`);
  await sleep(SLEEP_BETWEEN_PHASE_MS);

  // 2) Phase RPC pour les MISS
  const needRpc = apiMiss;
  let rpcOk = [];
  if (needRpc.length) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, TRADES_ABI, provider);

    log(`Phase RPC: ${needRpc.length} getTrade() (≤${MAX_RPC_PARALLEL} //)…`);
    const rpcTasks = needRpc.map(id => () => getTradeRPC(contract, id));
    const rpcRes = await runWithConcurrency(rpcTasks, Math.min(MAX_RPC_PARALLEL, rpcTasks.length));

    // On retient les IDs "existants" on-chain (owner != 0x0 OU asset/lots/margin non nuls)
    for (let i = 0; i < rpcRes.length; i++) {
      const id = needRpc[i];
      const r = rpcRes[i];
      if (r.ok && r.v?.ok) {
        const t = r.v.trade;
        const owner = (t?.owner || '').toLowerCase?.() || '';
        const exists =
          (owner && owner !== '0x0000000000000000000000000000000000000000') ||
          Number(t?.asset || 0) > 0 ||
          Number(t?.lots || 0) > 0 ||
          Number(t?.marginUsd6 || 0) > 0;

        if (exists) rpcOk.push(id);
      }
    }
    log(`RPC EXIST=${rpcOk.length}`);
  }

  await sleep(SLEEP_BETWEEN_PHASE_MS);

  // 3) VERIFY: on pousse à l’API les IDs manquants/trouvés on-chain + (optionnel) rafraîchir les OK
  //    - Cas manquant API mais présent on-chain => VERIFY doit indexer/actualiser "comme opened.js"
  //    - On peut aussi pusher les apiOk pour forcer un refresh d’état (soft).
  const toVerify = Array.from(new Set([...rpcOk, ...apiOk])).sort((a,b)=>a-b);
  log(`VERIFY push: ${toVerify.length} ids → ${VERIFY_BASE}/verify/...`);

  // en morceaux de 200 pour éviter des URLs trop longues
  const packets = chunk(toVerify, 200);
  for (const pack of packets) {
    pingVerify(pack);
    await sleep(50); // micro-pace
  }

  log('Done.');
})().catch(e => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
