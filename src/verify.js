// src/verify.js
// Pont entre l'API /verify/:ids et le runner state-only.
// Garde la signature attendue par endpoint.js.

import { runManualState } from './manual_state.js';

/**
 * Compare DB.positions.state vs on-chain stateOf(id),
 * applique les corrections (0->1 executed + stops, 1->2/3 removed, sinon patch),
 * et renvoie un récap minimal compatible avec endpoint.js.
 *
 * @param {number[]} ids
 * @returns {{checked:number, updated:number, mismatches:any[]}}
 */
export async function verifyAndSync(ids) {
  const acc = await runManualState(ids, {
    suppressLogs: true,                 // éviter le spam dans les logs API
    dbConcurrency: Number(process.env.DB_CONC  ?? 500),
    rpcConcurrency: Number(process.env.RPC_CONC ?? 100),
    // workers: optionnel (par défaut = min(ids.length, dbConc))
  });

  // "updated" = tout ce qui modifie la DB
  const updated = (acc.patched || 0) + (acc.executed || 0) + (acc.stops || 0) + (acc.removed || 0);

  return {
    checked: acc.scanned || 0,
    updated,
    mismatches: [] // on ne remonte pas le détail ici (manual_state ne les collecte pas)
  };
}

