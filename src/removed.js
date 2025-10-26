// src/removed.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { handleRemovedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

const TAG = 'Removed';

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Removed);

  logInfo(TAG, 'listening…');

  contract.on('Removed', async (id, reason, execX6, pnlUsd6, evt) => {
    try {
      await handleRemovedEvent({ id, reason, execX6, pnlUsd6 });
      logInfo(
        TAG,
        `stored id=${id} reason=${reason} execX6=${execX6} pnlUsd6=${pnlUsd6} @ block=${evt.blockNumber} tx=${evt.transactionHash} logIndex=${evt.logIndex}`
      );
    } catch (e) {
      logErr(TAG, 'handleRemovedEvent failed:', e.message || e);
    }
  });
}

process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => { logErr(TAG, e); process.exit(1); });

