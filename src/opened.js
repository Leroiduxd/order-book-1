// src/opened.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';
import { spawn } from 'child_process'; // ⬅️ pour lancer le script backfill

const TAG = 'Opened';

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Opened);

  logInfo(TAG, 'listening…');

  contract.on(
    'Opened',
    async (id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX, evt) => {
      try {
        // 1️⃣  Enregistrer l’event dans la DB
        await upsertOpenedEvent({
          id, state, asset, longSide, lots,
          entryOrTargetX6, slX6, tpX6, liqX6,
          trader, leverageX
        });

        logInfo(
          TAG,
          `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash}`
        );

        // 2️⃣  Si id multiple de 10 → lancer un backfill
        const idNum = Number(id);
        if (idNum % 10 === 0) {
          const cmd = 'node';
          const args = ['src/manual_backfill.js', `--end=${idNum}`, '--count=200'];
          const child = spawn(cmd, args, {
            stdio: 'ignore', // pas de log dans la console principale
            detached: true,  // le process vit indépendamment
          });

          child.unref(); // libère le sous-processus, non bloquant
          logInfo(TAG, `Triggered backfill: node src/manual_backfill.js --end=${idNum} --count=200`);
        }
      } catch (e) {
        logErr(TAG, 'upsertOpenedEvent failed:', e.message || e);
      }
    }
  );
}

// Gestion erreurs globales
process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => {
  logErr(TAG, e);
  process.exit(1);
});
