import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';

const TAG = 'Opened';

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Opened);

  logInfo(TAG, 'listening…');

  contract.on(
    'Opened',
    async (id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX, evt) => {
      try {
        await upsertOpenedEvent(
          { id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX },
          { txHash: evt.transactionHash, blockNum: evt.blockNumber }
        );
        logInfo(TAG, `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash} logIndex=${evt.logIndex}`);
      } catch (e) {
        logErr(TAG, 'upsertOpenedEvent failed:', e.message || e);
      }
    }
  );
}

main().catch((e) => {
  logErr(TAG, e);
  process.exit(1);
});
