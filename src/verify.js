// src/verify.js
import { ABI } from './shared/abi.js';
import { makeProvider, makeContract } from './shared/provider.js';
import { get, patch } from './shared/rest.js';
import { logInfo, logErr } from './shared/logger.js';

const TAG = 'Verify';

/** Lit les états en base pour un set d’IDs. */
async function fetchDbStates(ids) {
  if (!ids.length) return new Map();
  const list = ids.join(',');
  const rows = await get(`positions?id=in.(${list})&select=id,state`);
  // rows: [{ id, state }]
  return new Map((rows || []).map(r => [Number(r.id), Number(r.state)]));
}

/** Patch un état en base. */
async function updateDbState(id, newState) {
  await patch(`positions?id=eq.${id}`, { state: Number(newState) });
}

/** Vérifie et synchronise la DB avec l’on-chain. */
export async function verifyAndSync(ids) {
  // normalisation
  const uniq = Array.from(
    new Set(ids.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0))
  ).sort((a, b) => a - b);

  const provider = makeProvider();
  const contract = makeContract(provider, ABI.State);

  // DB snapshot
  const dbMap = await fetchDbStates(uniq);

  let checked = 0;
  let updated = 0;
  const mismatches = [];

  for (const id of uniq) {
    try {
      const chainState = Number(await contract.stateOf(id)); // 0|1|2|3
      const dbState = dbMap.has(id) ? dbMap.get(id) : null;

      checked += 1;

      // Si l'id n'existe pas en DB, on le signale mais on ne crée rien ici.
      if (dbState === null) {
        mismatches.push({ id, db: null, chain: chainState });
        continue;
      }

      if (dbState !== chainState) {
        await updateDbState(id, chainState);
        mismatches.push({ id, db: dbState, chain: chainState });
        updated += 1;
        logInfo(TAG, `id=${id} state DB ${dbState} → chain ${chainState} (synced)`);
      }
    } catch (e) {
      logErr(TAG, `id=${id} failed:`, e?.message || e);
    }
  }

  return { checked, updated, mismatches };
}
