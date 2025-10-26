// src/stopsUpdated.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { handleStopsUpdatedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

const TAG = 'StopsUpdated';

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.StopsUpdated);

  logInfo(TAG, 'listening…');

  contract.on('StopsUpdated', async (id, slX6, tpX6, evt) => {
    try {
      await handleStopsUpdatedEvent(
        { id, slX6, tpX6 },
        { txHash: evt.transactionHash, blockNum: evt.blockNumber } // ignoré par la fonction, ok
      );
      logInfo(TAG, `stored id=${id} slX6=${slX6} tpX6=${tpX6} @ block=${evt.blockNumber} tx=${evt.transactionHash} logIndex=${evt.logIndex}`);
    } catch (e) {
      logErr(TAG, 'handleStopsUpdatedEvent failed:', e.message || e);
    }
  });
}

main().catch((e) => {
  logErr(TAG, e);
  process.exit(1);
});

