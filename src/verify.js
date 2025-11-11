// ---- ADD BELOW your existing export verifyAndSync(...) ----
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Run the FULL reconcile (manual.js) as if calling:
 *   node src/manual.js --ids=1,2,3 [--dbConcurrency=.. --rpcConcurrency=.. --workers=..]
 *
 * Returns the parsed "Done." line stats from manual.js.
 *
 * @param {number[]} ids
 * @param {{ dbConcurrency?:number, rpcConcurrency?:number, workers?:number }} [opts]
 * @returns {Promise<{checked:number, created:number, executed:number, stops:number, removed:number, statePatched:number, skipped:number, raw:string}>}
 */
export async function verifyAndSyncFull(ids, opts = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('ids_required');
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = path.dirname(__filename);
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
      // Try to parse the final "Done. ..." line from manual.js logs
      const doneLine = (out.split('\n').reverse().find(l => /Done\.\s+scanned=/.test(l)) || '').trim();

      // Default summary
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

      if (doneLine) {
        // Example line:
        // Done. scanned=100 created=2 executed=5 stops=3 removed=1 statePatched=0 skipped=89
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
      }

      if (code !== 0) {
        // Non-zero exit; still return what we could parse to help debugging
        return reject(Object.assign(new Error('manual_full_failed'), { code, summary }));
      }
      resolve(summary);
    });
  });
}

