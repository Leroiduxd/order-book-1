// src/manual.js — backfill avec stateOf + indexation ORDER/SL/TP/LIQ
// Usage: node src/manual.js --end=<uint32_last_id> [--count=100]
import 'dotenv/config';
import { ethers } from 'ethers';
import { setTimeout as sleep } from 'node:timers/promises';

// On réutilise exactement la même voie DB qu'opened.js
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

// =========================
// CONFIG (auto-contenu: .env sinon fallback)
// =========================
const CONTRACT_ADDRESS = (process.env.CONTRACT_ADDR || '0xb449FD01FA7937d146e867b995C261E33C619292').trim();
const RPC_URL          = (process.env.RPC_HTTP   || 'https://atlantic.dplabs-internal.com').trim();

// =========================
// CLI
// =========================
const flags = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.startsWith('--') ? a.slice(2).split('=') : [a, 'true'];
    return [k, v];
  })
);
const END_ID = Number(flags.end ?? NaN);
const COUNT  = Math.max(1, Math.min(Number(flags.count ?? 100), 2000));
if (!Number.isInteger(END_ID) || END_ID < 0) {
  console.error('Usage: node src/manual.js --end=<uint32 last ID> [--count=100]');
  process.exit(1);
}
const START_ID = Math.max(0, END_ID - COUNT + 1);
const IDS = Array.from({ length: END_ID - START_ID + 1 }, (_, i) => START_ID + i);

// Limites d’exécution
const MAX_RPC_PARALLEL = 80;
const PAUSE_BETWEEN_BATCH_MS = 40;

const TAG = 'ManualBackfill';

// =========================
// ABI inline: getTrade(uint32), stateOf(uint32)
// =========================
const TRADES_ABI = [
  {
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
  },
  {
    "inputs":[{"internalType":"uint32","name":"id","type":"uint32"}],
    "name":"stateOf",
    "outputs":[{"internalType":"uint8","name":"","type":"uint8"}],
    "stateMutability":"view","type":"function"
  }
];

// =========================
// Helpers
// =========================
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

function tradeLooksValid(t) {
  const owner = (t?.owner || '').toLowerCase();
  try {
    const margin = BigInt(String(t?.marginUsd6 ?? '0'));
    return (
      owner &&
      owner !== '0x0000000000000000000000000000000000000000' &&
      (Number(t?.asset || 0) > 0 || Number(t?.lots || 0) > 0 || margin > 0n)
    );
  } catch { return false; }
}

// =========================
// MAIN
// =========================
(async function main() {
  logInfo(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDRESS}`);
  logInfo(TAG, `Backfill IDs ${START_ID}..${END_ID} (count=${IDS.length})`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, TRADES_ABI, provider);

  let scanned = 0, ingested = 0, skipped = 0;
  const batches = chunk(IDS, 500);

  for (const group of batches) {
    const tasks = group.map((id) => async () => {
      try {
        // Récupère trade + état en parallèle
        const [t, stRaw] = await Promise.all([
          contract.getTrade(id),
          contract.stateOf(id).catch(() => 0) // fallback 0 si la fn n'existe pas (ancien build)
        ]);
        scanned++;

        if (!tradeLooksValid(t)) {
          skipped++;
          return;
        }
        const state = Number(stRaw) | 0; // 0=ORDER,1=OPENED,2=CLOSED,3=CANCELLED

        // Règle métier demandée :
        // - state=0 (ORDER)  -> indexer un ORDER au prix targetX6 (si 0, fallback entryX6)
        // - state=1 (OPENED) -> indexer SL/TP/LIQ côté antagoniste (!longSide)
        const isOrder  = state === 0;
        const isOpen   = state === 1;

        const entryOrTargetX6 = isOrder
          ? String((t.targetX6 && t.targetX6 !== 0n) ? t.targetX6 : t.entryX6)
          : String(t.entryX6); // pour OPENED, entry

        await upsertOpenedEvent({
          id,
          state,
          asset: Number(t.asset),
          longSide: (Number(t.flags) & 1) === 1,
          lots: Number(t.lots),
          entryOrTargetX6,
          // Pour ORDER on n’indexe pas les stops; pour OPEN oui (db.js gère l’antagoniste)
          slX6: isOpen ? String(t.slX6 ?? 0) : '0',
          tpX6: isOpen ? String(t.tpX6 ?? 0) : '0',
          liqX6:isOpen ? String(t.liqX6 ?? 0) : '0',
          trader: String(t.owner),
          leverageX: Number(t.leverageX)
        });

        ingested++;
      } catch (e) {
        logErr(TAG, `id=${id} → ${e?.shortMessage || e?.message || String(e)}`);
      }
    });

    await runWithConcurrency(tasks, Math.min(MAX_RPC_PARALLEL, tasks.length));
    await sleep(PAUSE_BETWEEN_BATCH_MS);
  }

  logInfo(TAG, `Done. scanned=${scanned} ingested=${ingested} skipped=${skipped}`);
})().catch((e) => {
  logErr(TAG, e?.message || e);
  process.exit(1);
});
