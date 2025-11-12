// src/opened.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

const TAG = 'Opened';

async function main() {
  // Provider WebSocket recommandé (makeProvider() doit renvoyer un WS provider)
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Opened);

  logInfo(TAG, 'listening… (events will be stored to DB)');

  // Écoute des events Opened -> écriture DB
  contract.on(
    'Opened',
    async (id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX, evt) => {
      try {
        await upsertOpenedEvent({
          id, state, asset, longSide, lots,
          entryOrTargetX6, slX6, tpX6, liqX6,
          trader, leverageX
        });

        logInfo(
          TAG,
          `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash}`
        );
      } catch (e) {
        logErr(TAG, 'upsertOpenedEvent failed:', e?.message || e);
      }
    }
  );

  // On log simplement les erreurs/fermetures WS (pas de restart auto)
  const ws = provider?._websocket;
  if (ws && typeof ws.on === 'function') {
    ws.on('close', (code) => {
      logErr(TAG, `WebSocket closed (code=${code}). Waiting for provider/lib to handle reconnect if enabled.`);
    });
    ws.on('error', (err) => {
      logErr(TAG, 'WebSocket error', err);
    });
  } else {
    logInfo(TAG, 'Provider without raw _websocket; continuing without WS hooks.');
  }
}

// Garde-fous (log only)
process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => {
  logErr(TAG, e?.message || e);
  // pas d’auto-exit; on reste vivant pour laisser PM2 superviser si besoin
});
