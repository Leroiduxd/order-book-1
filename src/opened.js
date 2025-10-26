// src/opened.js
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
        await upsertOpenedEvent({
          id, state, asset, longSide, lots,
          entryOrTargetX6, slX6, tpX6, liqX6,
          trader, leverageX
        });
        logInfo(TAG, `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash}`);
      } catch (e) {
        logErr(TAG, 'upsertOpenedEvent failed:', e.message || e);
      }
    }
  );
}

process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => { logErr(TAG, e); process.exit(1); });
