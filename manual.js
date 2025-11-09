// manual.js
import { backfillRangeIfMissing } from './src/verify.js';

const from = parseInt(process.argv[2]);
const to = parseInt(process.argv[3]);

if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
  console.error('❌ Usage: node manual.js <fromId> <toId>');
  process.exit(1);
}

(async () => {
  console.log(`🚀 Backfilling [${from}..${to}] ...`);
  const res = await backfillRangeIfMissing(from, to);
  console.log(`✅ Done: scanned=${res.scanned}, created=${res.created}`);
})();
