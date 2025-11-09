// src/manual.js — backfill local "comme opened.js" (sans API HTTP)
// Usage: node src/manual.js --end=<uint32_last_id> [--count=100]

import 'dotenv/config';
import { ethers } from 'ethers';
import { setTimeout as sleep } from 'node:timers/promises';

// ✅ on importe les mêmes helpers que opened.js
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

// =========================
// CONFIG (import si possible, sinon défauts)
// =========================
let CONTRACT_ADDRESS, RPC_URL;
try {
  const cfg = await import(new URL('../config.js', import.meta.url));
  CONTRACT_ADDRESS = cfg.EXECUTOR_ADDR ?? '0xb449FD01FA7937d146e867b995C261E33C619292';
  RPC_URL          = cfg.EXECUTOR_RPC  ?? 'https://atlantic.dplabs-internal.com';
} catch {
  try {
    const cfg2 = await import(new URL('./config.js', import.meta.url));
    CONTRACT_ADDRESS = cfg2.EXECUTOR_ADDR ?? '0xb449FD01FA7937d146e867b995C261E33C619292';
    RPC_URL          = cfg2.EXECUTOR_RPC  ?? 'https://atlantic.dplabs-internal.com';
  } catch {
    CONTRACT_ADDRESS = '0xb449FD01FA7937d146e867b995C261E33C619292';
    RPC_URL          = 'https://atlantic.dplabs-internal.com';
  }
}

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
const COUNT  = Math.max(1, Math.min(Number(flags.count ?? 100), 2000)); // borne haute

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
// ABI getTrade(uint32) — inline
// =========================
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

function tradeExistsLikeOpened(t) {
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
/* MAIN */
// =========================
(async function main() {
  logInfo(TAG, `RPC=${RPC_URL} | CONTRACT=${CONTRACT_ADDRESS}`);
  logInfo(TAG, `Backfill IDs ${START_ID}..${END_ID} (count=${IDS.length})`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, TRADES_ABI, provider);

  // On interroge directement le RPC (pas d’API), et on upsert comme l’event Opened
  const batches = chunk(IDS, 500);
  let scanned = 0, ingested = 0, skipped = 0;

  for (const group of batches) {
    const tasks = group.map((id) => async () => {
      try {
        const t = await contract.getTrade(id);
        const tr = {
          id,
          owner: String(t.owner),
          asset: Number(t.asset),
          lots: Number(t.lots),
          flags: Number(t.flags),
          entryX6: String(t.entryX6),
          targetX6: String(t.targetX6),
          slX6: String(t.slX6),
          tpX6: String(t.tpX6),
          liqX6: String(t.liqX6),
          leverageX: Number(t.leverageX),
          marginUsd6: String(t.marginUsd6),
        };
        scanned++;

        if (!tradeExistsLikeOpened(tr)) {
          skipped++;
          return;
        }

        // Payload identique à opened.js → upsertOpenedEvent(...)
        await upsertOpenedEvent({
          id,
          state: 1, // 1 = Opened
          asset: tr.asset,
          longSide: (tr.flags & 1) === 1, // si flag bit0 = long
          lots: tr.lots,
          entryOrTargetX6: tr.entryX6,    // ta sémantique: pour Opened c’est entryX6
          slX6: tr.slX6,
          tpX6: tr.tpX6,
          liqX6: tr.liqX6,
          trader: tr.owner,
          leverageX: tr.leverageX,
        });

        ingested++;
      } catch (e) {
        logErr(TAG, `getTrade/upsert id=${id} → ${e?.shortMessage || e?.message || String(e)}`);
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
