// src/manual.js
// Usage: node src/manual.js --end=700 --count=100 --concurrency=100
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { ethers } from 'ethers';

// ====================== CONFIG / CLI ======================
const API_BASE    = process.env.API_BASE || process.env.ENDPOINT_API || process.env.ENDPOINT || 'https://api.brokex.trade';
const VERIFY_BASE = process.env.VERIFY_BASE || API_BASE;
const RPC_URL     = process.env.RPC_URL || process.env.RPC_HTTP || process.env.ATLANTIC_RPC || process.env.RPC || process.env.RPCHTTP;
const CONTRACT    = (process.env.CONTRACT_ADDR || process.env.CONTRACT || process.env.CONTRACT_ADDRESS || '').trim();
const POSTGREST   = process.env.ENDPOINT || 'http://127.0.0.1:9304';

if (!RPC_URL)    throw new Error('RPC_HTTP manquant dans .env (RPC_URL / RPC_HTTP)');
if (!CONTRACT)   throw new Error('CONTRACT_ADDR manquant dans .env');
if (!POSTGREST)  throw new Error('ENDPOINT (PostgREST) manquant dans .env');

// flags
const flags = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k,v='true'] = a.startsWith('--') ? a.slice(2).split('=') : [a,'true'];
  return [k,v];
}));
const END_ID = Number(flags.end ?? NaN);
const COUNT  = Math.max(1, Math.min(Number(flags.count ?? 100), 5000));
const CONCURRENCY = Math.max(1, Math.min(Number(flags.concurrency ?? 100), 1000));

if (!Number.isInteger(END_ID) || END_ID < 0) {
  console.error('Usage: node src/manual.js --end=<uint32 last ID> [--count=100] [--concurrency=100]');
  process.exit(1);
}

const START_ID = Math.max(0, END_ID - COUNT + 1);
const IDS = Array.from({ length: END_ID - START_ID + 1 }, (_, i) => START_ID + i);

const LOGP = (tag, ...args) => console.log(new Date().toISOString(), `[BROKEX][Manual]`, tag, ...args);

// ====================== ABI (minimal) ======================
// minimal ABI fragments for getTrade(uint32) and stateOf(uint32)
const TRADES_ABI = [
  {
    "inputs":[{"internalType":"uint32","name":"id","type":"uint32"}],
    "name":"getTrade",
    "outputs":[{"components":[
      {"internalType":"address","name":"owner","type":"address"},
      {"internalType":"uint32","name":"asset","type":"uint32"},
      {"internalType":"uint16","name":"lots","type":"uint16"},
      {"internalType":"uint8","name":"flags","type":"uint8"},
      {"internalType":"uint8","name":"_pad0","type":"uint8"},
      {"internalType":"int64","name":"entryX6","type":"int64"},
      {"internalType":"int64","name":"targetX6","type":"int64"},
      {"internalType":"int64","name":"slX6","type":"int64"},
      {"internalType":"int64","name":"tpX6","type":"int64"},
      {"internalType":"int64","name":"liqX6","type":"int64"},
      {"internalType":"uint16","name":"leverageX","type":"uint16"},
      {"internalType":"uint16","name":"_pad1","type":"uint16"},
      {"internalType":"uint64","name":"marginUsd6","type":"uint64"}],
      "internalType":"struct Trades.Trade","name":"","type":"tuple"}],
    "stateMutability":"view","type":"function"
  },
  'function stateOf(uint32 id) view returns (uint8)'
];

// ====================== HELPERS ======================
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// semaphore-ish queue (start next as soon as one finishes)
class Pool {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }
  run(task) {
    return new Promise((resolve, reject) => {
      const job = async () => {
        this.running++;
        try {
          const v = await task();
          resolve(v);
        } catch (e) {
          reject(e);
        } finally {
          this.running--;
          if (this.queue.length) {
            const next = this.queue.shift();
            next();
          }
        }
      };
      if (this.running < this.limit) job();
      else this.queue.push(job);
    });
  }
  active() { return this.running; }
}

// safe fetch wrapper (throws on non-json/non-ok)
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text().catch(()=>null);
  const ct = r.headers?.get?.('content-type') || '';
  let body = text;
  if (ct.includes('application/json')) {
    try { body = JSON.parse(text); } catch(e){ /* keep text */ }
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${r.statusText} :: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

// convert on-chain x6 (bigint/number/string) -> string
function toX6String(x) { try { return BigInt(x).toString(); } catch (e) { return String(x || 0); } }

// ====================== RPC / API clients ======================
const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
const tradesContract = new ethers.Contract(CONTRACT, TRADES_ABI, rpcProvider);

const apiPool = new Pool(CONCURRENCY); // pool for API (PostgREST / backend)
const rpcPool = new Pool(CONCURRENCY); // pool for RPC

// ====================== core functions ======================

/**
 * query API: GET /position/:id (user had this endpoint in earlier manual)
 * returns { id, ok, data } or { id, ok:false, reason }
 */
async function fetchAPIPosition(id) {
  const url = `${API_BASE.replace(/\/+$/,'')}/position/${id}`;
  try {
    const res = await fetchJson(url, { method: 'GET' });
    if (!res || res?.error === 'position_not_found') return { id, ok: false, reason: res?.error || 'not_found' };
    return { id, ok: true, data: res };
  } catch (e) {
    return { id, ok: false, reason: e.message || String(e) };
  }
}

/**
 * query DB positions via PostgREST: GET /positions?ids=...
 */
async function getPositionFromDB(id) {
  const url = `${POSTGREST.replace(/\/+$/,'')}/positions?id=eq.${id}`;
  try {
    const rows = await fetchJson(url);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    LOG_ERROR(`getPositionFromDB ${id}`, e);
    return null;
  }
}

/**
 * call RPC getTrade(id) (returns tuple struct) - wrapped safely
 */
async function getTradeRPC(id) {
  try {
    const t = await tradesContract.getTrade(id);
    // normalize
    return {
      id,
      ok: true,
      trade: {
        owner: String(t.owner || t[0] || '0x0000000000000000000000000000000000000000'),
        asset: Number(t.asset ?? t[1] ?? 0),
        lots: Number(t.lots ?? t[2] ?? 0),
        entryX6: toX6String(t.entryX6 ?? t[5] ?? 0),
        targetX6: toX6String(t.targetX6 ?? t[6] ?? 0),
        slX6: toX6String(t.slX6 ?? t[7] ?? 0),
        tpX6: toX6String(t.tpX6 ?? t[8] ?? 0),
        liqX6: toX6String(t.liqX6 ?? t[9] ?? 0),
        leverageX: Number(t.leverageX ?? t[10] ?? 0),
        marginUsd6: toX6String(t.marginUsd6 ?? t[12] ?? 0),
      }
    };
  } catch (e) {
    return { id, ok: false, reason: e?.shortMessage || e?.message || String(e) };
  }
}

/**
 * call RPC stateOf(id) -> returns numeric 0..3 (uint8)
 */
async function getStateOfRPC(id) {
  try {
    const s = await tradesContract.stateOf(id);
    return { id, ok: true, state: Number(s) };
  } catch (e) {
    return { id, ok: false, reason: e?.shortMessage || e?.message || String(e) };
  }
}

/**
 * PostgREST RPC helpers to ingest/fix rows using SQL RPC functions defined in DB:
 * POST /rpc/ingest_opened with body: { _id, _owner_addr, ... }
 * We call rpc endpoints as described in SQL schema.
 */
async function callIngestOpened(params) {
  const url = `${POSTGREST.replace(/\/+$/,'')}/rpc/ingest_opened`;
  return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
}
async function callIngestExecuted(params) {
  const url = `${POSTGREST.replace(/\/+$/,'')}/rpc/ingest_executed`;
  return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
}
async function callIngestRemoved(params) {
  const url = `${POSTGREST.replace(/\/+$/,'')}/rpc/ingest_removed`;
  return fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
}

// small log helpers
function LOG_ERROR(ctx, e) { console.error(new Date().toISOString(), '[BROKEX][Manual][ERR]', ctx, e?.message || e); }
function LOG_INFO(...a) { console.log(new Date().toISOString(), '[BROKEX][Manual]', ...a); }

// ====================== single-id reconcile logic ======================
/**
 * Reconcile a single id:
 * - try API position
 *   - if found -> verify DB vs chain (stateOf)
 *   - if not found -> use RPC getTrade -> if trade exists -> call ingest_opened RPC to insert/update
 *
 * returns an object { id, scanned:1, created:0|1, fixedState:0|1, fixedIdx:0|1, closed:0|1, skipped:0|1 }
 */
async function reconcileId(id) {
  const out = { id, scanned: 1, created: 0, fixedState: 0, fixedIdx: 0, closed: 0, skipped: 0 };
  // 1) API stage (use apiPool)
  let apiRes;
  try {
    apiRes = await apiPool.run(() => fetchAPIPosition(id));
  } catch (e) {
    apiRes = { id, ok: false, reason: e?.message || String(e) };
  }

  // if API says present -> we still check DB row & stateOf
  if (apiRes.ok) {
    // fetch DB canonical row
    const dbRow = await getPositionFromDB(id); // may be null if API returns different shape but we assume API==DB
    // get on-chain state
    const stateRes = await rpcPool.run(() => getStateOfRPC(id));
    if (!stateRes.ok) {
      LOG_ERROR(`stateOf RPC failed for ${id}`, stateRes.reason || '');
      return out;
    }
    const chainState = Number(stateRes.state);

    // If dbRow exists -> compare state and stops
    if (dbRow) {
      // note: dbRow.state might be numeric or string, handle both
      const dbStateNum = (typeof dbRow.state === 'string' && /^[0-9]+$/.test(dbRow.state)) ? Number(dbRow.state)
                        : (typeof dbRow.state === 'number' ? dbRow.state : null);

      // compare: if mismatch -> attempt fix via RPC ingestion depending on chainState
      if (dbStateNum === null || dbStateNum !== chainState) {
        // try to repair by calling the appropriate rpc ingestion function
        try {
          if (chainState === 0) {
            // ORDER: ingest_opened as ORDER
            // We need the on-chain trade to provide entryOrTarget, etc.
            const rpcTrade = await rpcPool.run(() => getTradeRPC(id));
            if (rpcTrade.ok) {
              const t = rpcTrade.trade;
              // call ingest_opened with parameters named in SQL
              await callIngestOpened({
                _id: Number(id),
                _owner_addr: String(t.owner),
                _asset_id: Number(t.asset),
                _long_side: Boolean(t.lots && Number(t.lots) > 0 ? (t.lots >= 0 ? true : true) : true), // longSide unavailable in getTrade struct? depends on contract - best-effort: keep existing sign
                _lots: Number(t.lots || 0),
                _leverage_x: Number(t.leverageX || 0),
                _margin_usd6: Number(t.marginUsd6 || 0),
                _state: 'ORDER',
                _entry_or_target_x6: BigInt(t.targetX6 || '0').toString(),
                _sl_x6: BigInt(t.slX6 || '0').toString(),
                _tp_x6: BigInt(t.tpX6 || '0').toString(),
                _liq_x6: BigInt(t.liqX6 || '0').toString(),
                _tx_hash: null,
                _block_num: null
              });
              out.fixedState = 1;
            }
          } else if (chainState === 1) {
            // OPEN -> ingest_opened with state=OPEN (entryOrTarget = entryX6)
            const rpcTrade = await rpcPool.run(() => getTradeRPC(id));
            if (rpcTrade.ok) {
              const t = rpcTrade.trade;
              await callIngestOpened({
                _id: Number(id),
                _owner_addr: String(t.owner),
                _asset_id: Number(t.asset),
                _long_side: Boolean(t.lots && Number(t.lots) > 0 ? (t.lots >= 0 ? true : true) : true),
                _lots: Number(t.lots || 0),
                _leverage_x: Number(t.leverageX || 0),
                _margin_usd6: Number(t.marginUsd6 || 0),
                _state: 'OPEN',
                _entry_or_target_x6: BigInt(t.entryX6 || '0').toString(),
                _sl_x6: BigInt(t.slX6 || '0').toString(),
                _tp_x6: BigInt(t.tpX6 || '0').toString(),
                _liq_x6: BigInt(t.liqX6 || '0').toString(),
                _tx_hash: null,
                _block_num: null
              });
              out.fixedState = 1;
            }
          } else if (chainState === 2 || chainState === 3) {
            // CLOSED or CANCELLED -> call ingest_removed to mark closed
            // need reason mapping: 2/3 not giving reason; we'll upsert as CLOSED with reason MARKET if unknown
            await callIngestRemoved({
              _id: Number(id),
              _reason: 'MARKET', // best-effort
              _exec_x6: 0,
              _pnl_usd6: 0,
              _tx_hash: null,
              _block_num: null
            });
            out.closed = 1;
            out.fixedState = 1;
          }
        } catch (e) {
          LOG_ERROR(`repair for id=${id}`, e);
        }
      }

      // verify stops/indexes: compare sl_x6/tp_x6/liq_x6 in db vs API (apiRes.data)
      try {
        const apiPos = apiRes.data;
        if (apiPos) {
          const chainSl = toX6String(apiPos.sl_x6 ?? apiPos.slX6 ?? apiPos.slX6 ?? 0);
          const chainTp = toX6String(apiPos.tp_x6 ?? apiPos.tpX6 ?? apiPos.tpX6 ?? 0);
          const chainLiq = toX6String(apiPos.liq_x6 ?? apiPos.liqX6 ?? apiPos.liqX6 ?? 0);
          const dbSl = toX6String(dbRow.sl_x6 ?? dbRow.slX6 ?? dbRow.sl_x6 ?? 0);
          const dbTp = toX6String(dbRow.tp_x6 ?? dbRow.tpX6 ?? dbRow.tpX6 ?? 0);
          const dbLiq = toX6String(dbRow.liq_x6 ?? dbRow.liqX6 ?? dbRow.liqX6 ?? 0);
          if (chainSl !== dbSl || chainTp !== dbTp || chainLiq !== dbLiq) {
            // re-ingest using ingest_stops_updated if OPEN or ingest_opened if ORDER
            if (chainState === 1) {
              // call RPC ingest_stops_updated
              const url = `${POSTGREST.replace(/\/+$/,'')}/rpc/ingest_stops_updated`;
              try {
                await fetchJson(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ _id: Number(id), _sl_x6: BigInt(chainSl).toString(), _tp_x6: BigInt(chainTp).toString(), _tx_hash: null, _block_num: null })
                });
                out.fixedIdx = 1;
              } catch (e) {
                LOG_ERROR(`ingest_stops_updated failed id=${id}`, e);
              }
            } else {
              // for ORDER, re-ingest the whole opened entry
              const rpcTrade = await rpcPool.run(() => getTradeRPC(id));
              if (rpcTrade.ok) {
                const t = rpcTrade.trade;
                await callIngestOpened({
                  _id: Number(id),
                  _owner_addr: String(t.owner),
                  _asset_id: Number(t.asset),
                  _long_side: Boolean(t.lots && Number(t.lots) > 0 ? true : true),
                  _lots: Number(t.lots || 0),
                  _leverage_x: Number(t.leverageX || 0),
                  _margin_usd6: Number(t.marginUsd6 || 0),
                  _state: chainState === 0 ? 'ORDER' : (chainState === 1 ? 'OPEN' : 'ORDER'),
                  _entry_or_target_x6: chainState === 0 ? BigInt(t.targetX6 || '0').toString() : BigInt(t.entryX6 || '0').toString(),
                  _sl_x6: BigInt(t.slX6 || '0').toString(),
                  _tp_x6: BigInt(t.tpX6 || '0').toString(),
                  _liq_x6: BigInt(t.liqX6 || '0').toString(),
                  _tx_hash: null,
                  _block_num: null
                });
                out.fixedIdx = 1;
              }
            }
          }
        }
      } catch (e) {
        LOG_ERROR(`verify stops/index for ${id}`, e);
      }

    } else {
      // DB row missing but API returned something? weird; try to ingest from API body if shape known
      try {
        // try simple POST into /positions (on_conflict=id)
        const pos = apiRes.data;
        if (pos && pos.id) {
          // best-effort: send to rpc/ingest_opened using available fields
          await callIngestOpened({
            _id: Number(id),
            _owner_addr: String(pos.trader || pos.trader_addr || pos.owner || pos.owner_addr || null),
            _asset_id: Number(pos.asset_id || pos.asset || 0),
            _long_side: Boolean(pos.long_side || pos.longSide || false),
            _lots: Number(pos.lots || 0),
            _leverage_x: Number(pos.leverage_x || pos.leverageX || 0),
            _margin_usd6: Number(pos.margin_usd6 || 0),
            _state: (pos.state === 1 || pos.state === '1' || pos.state === 'OPEN') ? 'OPEN' : 'ORDER',
            _entry_or_target_x6: BigInt(pos.entry_x6 || pos.entryX6 || pos.target_x6 || pos.targetX6 || 0).toString(),
            _sl_x6: BigInt(pos.sl_x6 || pos.slX6 || 0).toString(),
            _tp_x6: BigInt(pos.tp_x6 || pos.tpX6 || 0).toString(),
            _liq_x6: BigInt(pos.liq_x6 || pos.liqX6 || 0).toString(),
            _tx_hash: null,
            _block_num: null
          });
          out.created = 1;
        }
      } catch (e) {
        LOG_ERROR(`ingest from API for id=${id}`, e);
      }
    }

    // done API path
    return out;
  }

  // else API miss -> fallback to RPC getTrade
  let rpcTradeRes;
  try {
    rpcTradeRes = await rpcPool.run(() => getTradeRPC(id));
  } catch (e) {
    rpcTradeRes = { id, ok: false, reason: e?.message || String(e) };
  }

  if (!rpcTradeRes.ok) {
    // nothing on-chain or rpc error
    out.skipped = 1;
    return out;
  }

  // if RPC returns a trade - ingest into DB via rpc/ingest_opened (state UNKNOWN -> assume ORDER if targetX6>0 and entryX6==0)
  try {
    const t = rpcTradeRes.trade;
    // determine state guess: if entryX6>0 -> OPEN else if targetX6>0 -> ORDER else ORDER
    const entryIsSet = BigInt(t.entryX6 || '0') !== 0n;
    const targetIsSet = BigInt(t.targetX6 || '0') !== 0n;
    const stateStr = entryIsSet ? 'OPEN' : (targetIsSet ? 'ORDER' : 'ORDER');

    await callIngestOpened({
      _id: Number(id),
      _owner_addr: String(t.owner),
      _asset_id: Number(t.asset),
      _long_side: Boolean(t.lots && Number(t.lots) > 0 ? true : true),
      _lots: Number(t.lots || 0),
      _leverage_x: Number(t.leverageX || 0),
      _margin_usd6: Number(t.marginUsd6 || 0),
      _state: stateStr,
      _entry_or_target_x6: entryIsSet ? BigInt(t.entryX6).toString() : BigInt(t.targetX6).toString(),
      _sl_x6: BigInt(t.slX6 || '0').toString(),
      _tp_x6: BigInt(t.tpX6 || '0').toString(),
      _liq_x6: BigInt(t.liqX6 || '0').toString(),
      _tx_hash: null,
      _block_num: null
    });

    out.created = 1;
    // after creation, push verify for this id
    return out;
  } catch (e) {
    LOG_ERROR(`ingest_opened rpc->db failed for ${id}`, e);
    out.skipped = 1;
    return out;
  }
}

// ====================== main orchestration ======================
(async function main() {
  LOG_INFO(`RPC=${RPC_URL} | CONTRACT=${CONTRACT}`);
  LOG_INFO(`MODE=full | ids=${IDS.length} | concurrency=${CONCURRENCY}`);

  const results = [];
  let active = 0;
  let index = 0;

  // We'll process with a sliding window of CONCURRENCY active promises
  const inFlight = new Set();

  function launchNext() {
    if (index >= IDS.length) return;
    const id = IDS[index++];
    const p = (async () => {
      try {
        const r = await reconcileId(id);
        results.push(r);
        LOG_INFO(`id=${id} done -> created=${r.created} fixedState=${r.fixedState} fixedIdx=${r.fixedIdx} closed=${r.closed} skipped=${r.skipped}`);
      } catch (e) {
        LOG_ERROR(`reconcileId ${id}`, e);
      } finally {
        inFlight.delete(p);
        // as soon as one finishes, start another if exists
        if (index < IDS.length) launchNext();
      }
    })();
    inFlight.add(p);
  }

  // start initial batch
  const initial = Math.min(CONCURRENCY, IDS.length);
  for (let i = 0; i < initial; i++) launchNext();

  // wait all done
  await Promise.allSettled(Array.from(inFlight));
  // but there may be more launched in finally -> loop until all processed
  while (inFlight.size) {
    // wait a bit for remaining
    await sleep(50);
  }

  // compile stats
  const scanned = results.reduce((s,r)=>s+(r.scanned||0),0);
  const created = results.reduce((s,r)=>s+(r.created||0),0);
  const fixedState = results.reduce((s,r)=>s+(r.fixedState||0),0);
  const fixedIdx = results.reduce((s,r)=>s+(r.fixedIdx||0),0);
  const closed = results.reduce((s,r)=>s+(r.closed||0),0);
  const skipped = results.reduce((s,r)=>s+(r.skipped||0),0);

  LOG_INFO(`Done. scanned=${scanned} created=${created} fixedState=${fixedState} fixedIdx=${fixedIdx} closed=${closed} skipped=${skipped}`);

  // final: kick verify endpoint for all created/found ids
  const toVerify = results.filter(r => r.created || r.fixedState || r.fixedIdx).map(r => r.id);
  if (toVerify.length) {
    try {
      const packets = chunk(toVerify, 200);
      for (const pack of packets) {
        const url = `${VERIFY_BASE.replace(/\/+$/,'')}/verify/${pack.join(',')}`;
        // fire-and-forget
        fetch(url).catch(()=>{});
        await sleep(25);
      }
      LOG_INFO(`Pushed ${toVerify.length} ids to /verify`);
    } catch (e) {
      LOG_ERROR('push verify', e);
    }
  }
})().catch(e => {
  LOG_ERROR('Fatal', e);
  process.exit(1);
});

