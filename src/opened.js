// src/opened.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';
import { spawn } from 'child_process';

const TAG = 'Opened';

// 🕒 redémarre si aucun event pendant 15s
const WATCHDOG_TIMEOUT = 15_000;
let lastEventTime = Date.now();

function restartProcess() {
  logErr(TAG, `No event for ${WATCHDOG_TIMEOUT / 1000}s → restarting...`);
  process.exit(1); // laisse pm2/systemd relancer
}

function startWatchdog() {
  setInterval(() => {
    if (Date.now() - lastEventTime > WATCHDOG_TIMEOUT) {
      restartProcess();
    }
  }, 5_000);
}

async function main() {
  const provider = makeProvider();               // <- doit être un WebSocketProvider
  const contract = makeContract(provider, ABI.Opened);

  logInfo(TAG, 'listening…');
  startWatchdog();

  // Event listener (inchangé)
  contract.on(
    'Opened',
    async (id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX, evt) => {
      try {
        lastEventTime = Date.now(); // reset watchdog

        await upsertOpenedEvent({
          id, state, asset, longSide, lots,
          entryOrTargetX6, slX6, tpX6, liqX6,
          trader, leverageX
        });

        logInfo(
          TAG,
          `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash}`
        );

        // backfill si id multiple de 10
        const idNum = Number(id);
        if (idNum % 10 === 0) {
          const child = spawn('node', ['src/manual_backfill.js', `--end=${idNum}`, '--count=200'], {
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
          logInfo(TAG, `Triggered backfill: node src/manual_backfill.js --end=${idNum} --count=200`);
        }
      } catch (e) {
        logErr(TAG, 'upsertOpenedEvent failed:', e?.message || e);
      }
    }
  );

  // ✅ ethers v6 : pas de provider.on('close'|'error')
  // on accroche les events au WebSocket brut si présent
  const ws = provider?._websocket;
  if (ws && typeof ws.on === 'function') {
    ws.on('close', () => {
      logErr(TAG, 'WebSocket closed');
      restartProcess();
    });
    ws.on('error', (err) => {
      logErr(TAG, 'WebSocket error', err);
      restartProcess();
    });
  } else {
    logInfo(TAG, 'No _websocket on provider (HTTP or non-WS transport). Watchdog still active.');
  }
}

// erreurs globales
process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => {
  logErr(TAG, e?.message || e);
  process.exit(1);
});

