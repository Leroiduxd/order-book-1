// src/opened.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';
import { spawn } from 'child_process';

const TAG = 'Opened';

// 🕒 Temps max d'inactivité (en ms)
const WATCHDOG_TIMEOUT = 15_000;
let lastEventTime = Date.now();

// 🔁 Fonction de redémarrage
function restartProcess() {
  logErr(TAG, `No event received for ${WATCHDOG_TIMEOUT / 1000}s → restarting listener...`);
  process.exit(1); // ton process manager (ex: pm2, systemd ou supervisor) le relancera automatiquement
}

// Démarre le watchdog (timer de vérification)
function startWatchdog() {
  setInterval(() => {
    const now = Date.now();
    if (now - lastEventTime > WATCHDOG_TIMEOUT) {
      restartProcess();
    }
  }, 5_000); // vérifie toutes les 5 secondes
}

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Opened);

  logInfo(TAG, 'listening…');
  startWatchdog(); // 🟢 démarre la surveillance dès le lancement

  contract.on(
    'Opened',
    async (id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX, evt) => {
      try {
        lastEventTime = Date.now(); // 🩵 reset du timer à chaque event reçu

        // 1️⃣ Enregistrer l’event dans la DB
        await upsertOpenedEvent({
          id, state, asset, longSide, lots,
          entryOrTargetX6, slX6, tpX6, liqX6,
          trader, leverageX
        });

        logInfo(
          TAG,
          `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash}`
        );

        // 2️⃣ Si id multiple de 10 → lancer un backfill local (non bloquant)
        const idNum = Number(id);
        if (idNum % 10 === 0) {
          const cmd = 'node';
          const args = ['src/manual_backfill.js', `--end=${idNum}`, '--count=200'];
          const child = spawn(cmd, args, {
            stdio: 'ignore',
            detached: true,
          });
          child.unref();
          logInfo(TAG, `Triggered backfill: node src/manual_backfill.js --end=${idNum} --count=200`);
        }
      } catch (e) {
        logErr(TAG, 'upsertOpenedEvent failed:', e.message || e);
      }
    }
  );

  // 🧠 bonus : si la connexion RPC/WSS plante, redémarre aussi
  provider.on('error', (err) => {
    logErr(TAG, 'provider error', err);
    restartProcess();
  });
  provider.on('close', () => {
    logErr(TAG, 'provider closed');
    restartProcess();
  });
}

// Gestion erreurs globales
process.on('unhandledRejection', (err) => logErr(TAG, 'unhandledRejection', err));
process.on('uncaughtException', (err) => logErr(TAG, 'uncaughtException', err));

main().catch((e) => {
  logErr(TAG, e);
  process.exit(1);
});
