// src/opened.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { upsertOpenedEvent } from './shared/db.js';
import { logInfo, logErr } from './shared/logger.js';
import { spawn } from 'child_process';

const TAG = 'Opened';

// 🕒 Temps max d'inactivité (ms) avant redémarrage automatique
const WATCHDOG_TIMEOUT = 15_000;
let lastEventTime = Date.now();

// Redémarre le process (à relancer via pm2/systemd)
function restartProcess() {
  logErr(TAG, `No event received for ${WATCHDOG_TIMEOUT / 1000}s → restarting...`);
  process.exit(1);
}

// Lance un timer qui vérifie régulièrement l'inactivité
function startWatchdog() {
  setInterval(() => {
    const now = Date.now();
    if (now - lastEventTime > WATCHDOG_TIMEOUT) {
      restartProcess();
    }
  }, 5_000);
}

async function main() {
  const provider = makeProvider();
  const contract = makeContract(provider, ABI.Opened);

  logInfo(TAG, 'listening…');
  startWatchdog();

  // Abonnement à l’event Opened (logique inchangée)
  contract.on(
    'Opened',
    async (id, state, asset, longSide, lots, entryOrTargetX6, slX6, tpX6, liqX6, trader, leverageX, evt) => {
      try {
        lastEventTime = Date.now(); // reset watchdog à chaque event

        // 1) Stocker l’événement en DB (inchangé)
        await upsertOpenedEvent({
          id, state, asset, longSide, lots,
          entryOrTargetX6, slX6, tpX6, liqX6,
          trader, leverageX
        });

        logInfo(
          TAG,
          `stored id=${id} state=${state} asset=${asset} lots=${lots} @ block=${evt.blockNumber} tx=${evt.transactionHash}`
        );

        // 2) Si l'id est multiple de 10 → backfill local non-bloquant (inchangé sauf ajout)
        const idNum = Number(id);
        if (idNum % 10 === 0) {

