// src/verify.js
// Ponts entre l’API et les runners CLI.
// - verifyAndSync(ids): STATE-ONLY (manual_state.js), n’appelle PAS getTrade
// - verifyAndSyncFull(ids, opts): FULL (manual.js), appelle getTrade + stateOf

import { runManualState } from './manual_state.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * STATE-ONLY: compare DB.positions.state vs on-chain stateOf(id),
 * applique les corrections minimales (0->1 executed + stops, 1->2/3 removed, sinon patch).
 *
 * @param {number[]} ids
 * @returns {{checked:number, updated:number, mismatches:any[]}}
 */
export async function verifyAndSync(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids_required');
  }

  const acc = await runManualState(ids, {
    suppressLogs: true,
    dbConcurrency: Number(process.env.DB_CONC  ?? 500),
    rpcConcurrency: Number(process.env.RPC_CONC ?? 100),
    // workers: laissé par défaut
  });

  const updated =
    (acc.patched  || 0) +
    (acc.executed || 0) +
    (acc.stops    || 0) +
    (acc.removed  || 0);

  return {
    checked: acc.scanned || 0,
    updated,
    mismatches: [] // on peut enrichir plus tard si besoin
  };
}

/**
 * FULL reconcile (équivaut à: node src/manual.js --ids=...).
 * Parse la ligne "Done. scanned=... created=... ..." de manual.js.
 *
 * @param {number[]} ids
 * @param {{ dbConcurrency?:number, rpcConcurrency?:number, workers?:number }} [opts]
 * @returns {Promise<{checked:number, created:number, executed:number, stops:number, removed:number, statePatched:number, skipped:number, raw:string}>}
 */
export async function verifyAndSyncFull(ids, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids_required');
  }

  // __dirname pour ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);

  // verify.js est dans src/, manual.js aussi → chemin absolu vers manual.js
  const scriptPath = path.resolve(__dirname, 'manual.js');

  const argList = [
    scriptPath,
    `--ids=${ids.join(',')}`
  ];
  if (opts.dbConcurrency)  argList.push(`--dbConcurrency=${opts.dbConcurrency}`);
  if (opts.rpcConcurrency) argList.push(`--rpcConcurrency=${opts.rpcConcurrency}`);
  if (opts.workers)        argList.push(`--workers=${opts.workers}`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argList, {
      // cwd optionnel: scriptPath est absolu, donc pas requis,
      // mais on met la racine projet (= src/..)
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';

    child.stdout.on('data', (buf) => { out += buf.toString(); });
    child.stderr.on('data', (buf) => { err += buf.toString(); });
    child.on('error', reject);

    child.on('close', (code) => {
      const summary = {
        checked: 0,
        created: 0,
        executed: 0,
        stops: 0,
        removed: 0,
        statePatched: 0,
        skipped: 0,
        raw: (out || '') + (err ? `\n[stderr]\n${err}` : '')
      };

      // Exemple attendu:
      // Done. scanned=100 created=2 executed=5 stops=3 removed=1 statePatched=0 skipped=89
      const doneLine = (out.split('\n').reverse().find(l => /Done\.\s+scanned=/.test(l)) || '').trim();
      const m = doneLine.match(/scanned=(\d+)\s+created=(\d+)\s+executed=(\d+)\s+stops=(\d+)\s+removed=(\d+)\s+statePatched=(\d+)\s+skipped=(\d+)/);
      if (m) {
        summary.checked      = Number(m[1] || 0);
        summary.created      = Number(m[2] || 0);
        summary.executed     = Number(m[3] || 0);
        summary.stops        = Number(m[4] || 0);
        summary.removed      = Number(m[5] || 0);
        summary.statePatched = Number(m[6] || 0);
        summary.skipped      = Number(m[7] || 0);
      }

      if (code !== 0) {
        return reject(Object.assign(new Error('manual_full_failed'), { code, summary }));
      }
      resolve(summary);
    });
  });
}
