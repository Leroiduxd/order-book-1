// src/executed.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { handleExecutedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

const TAG = 'Executed';

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Executed);

  logInfo(TAG, 'listening…');

  contract.on('Executed', async (id, entryX6, evt) => {
    try {
      // adapte au nouveau db.js: un seul param { id, entryX6 }
      await handleExecutedEvent({ id, entryX6 });

      logInfo(
        TAG,
        `stored id=${id?.toString?.() ?? id} entryX6=${entryX6?.toString?.() ?? entryX6} @ block=${evt.blockNumber} tx=${evt.transactionHash} logIndex=${evt.logIndex}`
      );
    } catch (e) {
      logErr(TAG, 'handleExecutedEvent failed:', e?.message || e);
    }
  });
}

// garde-fous
process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => {
  logErr(TAG, e);
  process.exit(1);
});
