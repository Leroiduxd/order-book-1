// src/manual.js — simple, prend la config si dispo + ABI inline
import 'dotenv/config';
import { ethers } from 'ethers';
import { setTimeout as sleep } from 'node:timers/promises';

/* =========================
   CONFIG (import si possible)
========================= */
let API_BASE, VERIFY_BASE, CONTRACT_ADDRESS, RPC_URL;

// Essaie ../config.js (repo classique: config à la racine)
try {
  const cfg = await import(new URL('../config.js', import.meta.url));
  API_BASE         = cfg.API_BASE ?? 'https://api.brokex.trade';
  VERIFY_BASE      = cfg.VERIFY_BASE ?? API_BASE;
  CONTRACT_ADDRESS = cfg.EXECUTOR_ADDR ?? '0xb449FD01FA7937d146e867b995C261E33C619292';
  RPC_URL          = cfg.EXECUTOR_RPC ?? 'https://atlantic.dplabs-internal.com';
} catch {
  // Essaie ./config.js (au cas où)
  try {
    const cfg2 = await import(new URL('./config.js', import.meta.url));
    API_BASE         = cfg2.API_BASE ?? 'https://api.brokex.trade';
    VERIFY_BASE      = cfg2.VERIFY_BASE ?? API_BASE;
    CONTRACT_ADDRESS = cfg2.EXECUTOR_ADDR ?? '0xb449FD01FA7937d146e867b995C261E33C619292';
    RPC_URL          = cfg2.EXECUTOR_RPC ?? 'https://atlantic.dplabs-internal.com';
  } catch {
    // Defaults si pas de config trouvée
    API_BASE         = 'https://api.brokex.trade';
    VERIFY_BASE      = API_BASE;
    CONTRACT_ADDRESS = '0xb449FD01FA7937d146e867b995C261E33C619292';
    RPC_URL          = 'https://atlantic.dplabs-internal.com';
  }
}

/* =========================
   CLI
========================= */
const flags = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
    return [k, v];
  })
);
const END_ID = Number(flags.end ?? NaN);
const COUNT  = Math.max(1, Math.min(Number(flags.count ?? 100), 1000)); // borne haute
if (!Number.isInteger(END_ID) || END_ID < 0) {
  console.error('Usage: node src/manual.js --end=<uint32 last ID> [--count=100]');
  process.exit(1);
}
const START_ID = Math.max(0, END_ID - COUNT + 1);
const IDS = Array.from({ length: END_ID - START_ID + 1 }, (_, i) => START_ID + i);

const MAX_API_PARALLEL = 200;
const MAX_RPC_PARALLEL = 50;
const PAUSE_BETWEEN_PHASES_MS = 200;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* =========================
   ABI INLINE: getTrade(uint32)
========================= */
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

/* =========================
   Helpers
========================= */
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
    if (!r.ok) return { id, ok: false };
    const json = await r.json().catch(() => null);
    if (!json || json?.error === 'position_not_found') return { id, ok: false };
    return { id, ok: true, data: json };
  } catch {
    return { id, ok: false };
  }
}

async function getTradeExists(contract, id) {
  try {
    const t = await contract.getTrade(id);
    const owner = (t?.owner || '').toLowerCase?.() || '';
    const exists =
      (owner && owner !== '0x0000000000000000000000000000000000000000') ||
      Number(t?.asset || 0) > 0 ||
      Number(t?.lots || 0) > 0 ||
      Number(t?.marginUsd6 || 0) > 0;
    return { id, ok: !!exists };
  } catch {
    return { id, ok: false };
  }
}

function pingVerify(ids) {
  if (!ids?.length) return;
  const url = `${VERIFY_BASE}/verify/${ids.join(',')}`;
  fetch(url).catch(() => {}); // fire-and-forget
}

/* =========================
   MAIN
========================= */
(async function main() {
  log(`Manual verify: IDs ${START_ID}..${END_ID} (count=${IDS.length})`);
  log(`API=${API_BASE} | VERIFY=${VERIFY_BASE} | RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDRESS}`);

  // 1) API check
  const apiTasks = IDS.map(id => () => fetchAPIPosition(id));
  const apiRes = await runWithConcurrency(apiTasks, Math.min(MAX_API_PARALLEL, apiTasks.length));

  const apiOk = [];
  const apiMiss = [];
  apiRes.forEach((r, idx) => {
    const id = IDS[idx];
    if (r.ok && r.v?.ok) apiOk.push(id);
    else apiMiss.push(id);
  });
  log(`API OK=${apiOk.length} | API MISS=${apiMiss.length}`);

  await sleep(PAUSE_BETWEEN_PHASES_MS);

  // 2) RPC fallback pour les manquants
  let rpcOk = [];
  if (apiMiss.length) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, TRADES_ABI, provider);

    const rpcTasks = apiMiss.map(id => () => getTradeExists(contract, id));
    const rpcRes = await runWithConcurrency(rpcTasks, Math.min(MAX_RPC_PARALLEL, rpcTasks.length));

    for (let i = 0; i < rpcRes.length; i++) {
      const id = apiMiss[i];
      const r = rpcRes[i];
      if (r.ok && r.v?.ok) rpcOk.push(id);
    }
    log(`RPC PRESENT=${rpcOk.length}`);
  }

  // 3) Envoi à /verify pour indexation/refresh (comme Opened)
  const toVerify = rpcOk.sort((a, b) => a - b);
  if (toVerify.length) {
    log(`VERIFY push: ${toVerify.length} ids → ${VERIFY_BASE}/verify/...`);
    // petit batch pour éviter de bourriner
    const size = 200;
    for (let i = 0; i < toVerify.length; i += size) {
      pingVerify(toVerify.slice(i, i + size));
      await sleep(50);
    }
  } else {
    log('Rien à vérifier (déjà indexé côté API ou absent côté RPC).');
  }

  log('✅ Terminé.');
})().catch(e => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(1);
});

