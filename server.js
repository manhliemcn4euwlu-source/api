// Pay-per-call HTTP API paid in Nano. No accounts, no keys.
// Flow: call an endpoint -> 402 with price and address -> send Nano -> retry with
// header X-Nano-Payment: <send block hash>. Overpayment stays as credit on that hash.
// Also speaks x402 v2 (scheme "exact", network "nano:mainnet"): the 402 carries a
// PAYMENT-REQUIRED header, the client retries with PAYMENT-SIGNATURE carrying a signed
// send block, and this process verifies and broadcasts it itself (see x402.js).
'use strict';
const zlib = require('node:zlib');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { DatabaseSync } = require('node:sqlite');
const site = require('./site');
const cohorts = require('./cohorts');
const x402 = require('./x402');
const facilitator = require('./facilitator');
const { withHashLock } = require('./hashlock');   // per-hash serialisation shared with the facilitator
const { writeJsonAtomic, readJsonStore } = require('./creditstore');   // durable money files (see creditstore.js)
const nanocurrency = require('nanocurrency');
const { Helper } = require('@x402nano/helper');
const { ExactNanoScheme: X402Reference } = require('@x402nano/exact/facilitator');

const PORT = Number(process.env.PORT || 3000);
const RPC = process.env.NANO_RPC || 'http://127.0.0.1:7076';
const ADDRESS = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const PRICE_RAW = 10n ** 27n;                // 0.001 NANO per call
const MAX_CREDIT_RAW = 10n ** 30n;           // ignore sends above 1 NANO (tranches are not credit)
const NOT_BEFORE = Number(process.env.NOT_BEFORE || 1757210000); // unix time service went live
const DATA = path.join(__dirname, 'data', 'credits.json');
// Source account of every credited hash (data/credit-accounts.json). The purpose registry excludes whole
// accounts (own, funding, donors); a credit stored before its account was listed has to be revoked when the
// ten-minute reload learns the exclusion, and that needs the account (Ops Control HQ, 2026-09-28, from e1001b3).
const CREDIT_ACCOUNTS = path.join(__dirname, 'data', 'credit-accounts.json');
let creditAccounts = {};
{ const r = readJsonStore(CREDIT_ACCOUNTS); if (r.damaged) console.error('credit-accounts: ' + CREDIT_ACCOUNTS + ' is damaged (' + r.error + ')' + (r.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on')); if (r.value && typeof r.value === 'object') creditAccounts = r.value; }
const saveCreditAccounts = () => { try { writeJsonAtomic(CREDIT_ACCOUNTS, creditAccounts); } catch {} };
const X402_LOG = path.join(__dirname, 'data', 'x402.json');   // settled x402 blocks: hash, payer, amount, resource, at
// Work sources, tried in order: WORK_URLS (comma-separated RPC-style work_generate endpoints,
// e.g. a keyed hosted GPU work server), then the local node. Clients may omit block.work on
// the x402 path (extra.work = 'optional'); we compute it here before broadcasting.
const WORK_URLS = (process.env.WORK_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
// PAID_WORK_URLS: a GPU reached over a private tunnel, tried first. Paid requests (x402 settles
// and paid /v1/work) always get it. Free requests get it too, within a shared budget of
// FREE_GPU_PER_MIN proofs a minute across all callers (default 30), so a first payment through
// here takes about a second instead of the 15 to 60 s the CPU path costs. Callers whose account
// has paid this server before (x402 settle, X-Nano-Payment credit, or a settle through the
// facilitator) skip the shared budget: they have already shown they are a payer, not a flood.
// Over budget, free work falls back to WORK_URLS then the node and the reply says which source.
const PAID_WORK_URLS = (process.env.PAID_WORK_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
// A URL fragment names the source (http://127.0.0.1:3007#cpu-simd); otherwise a loopback host is
// the GPU tunnel and anything else is shown by host. Loopback CPU sources get a longer timeout.
const workName = u => { const url = new URL(u); if (url.hash) return url.hash.slice(1); return /^(127\.|localhost)/.test(url.host) ? 'gpu' : url.host; };
const workLocal = u => /^(127\.|localhost)/.test(new URL(u).host);
const FREE_GPU_PER_MIN = Number(process.env.FREE_GPU_PER_MIN || 30);
const workSources = () => ({ paid: [...PAID_WORK_URLS.map(workName), ...WORK_URLS.map(workName), 'node'],
  free: [...PAID_WORK_URLS.map(u => workName(u) + ' (' + FREE_GPU_PER_MIN + '/min shared; prior payers skip the shared GPU budget but stay under the free per-IP cap of ' + FREE_WORK_PER_MIN + '/min)'), ...WORK_URLS.map(workName), 'node'] });
const freeGpu = { tokens: FREE_GPU_PER_MIN, at: Date.now() };
function takeFreeGpu() {   // token bucket: FREE_GPU_PER_MIN a minute, burst the same
  const now = Date.now();
  freeGpu.tokens = Math.min(FREE_GPU_PER_MIN, freeGpu.tokens + (now - freeGpu.at) / 60_000 * FREE_GPU_PER_MIN); freeGpu.at = now;
  if (freeGpu.tokens < 1) return false;
  freeGpu.tokens -= 1; return true;
}
let gpuDownUntil = 0;   // circuit breaker: after a network failure the GPU is skipped for 60 s (the home machine may be off)
const X402_REQ = x402.requirements({ payTo: ADDRESS, amountRaw: PRICE_RAW, maxTimeoutSeconds: 60, workOptional: true });
const x402Reference = new X402Reference(new Helper({ NANO_RPC_URL: RPC })); // reference verify() runs in addition to ours
const settling = new Set();                                    // block hashes with a "process" call in flight
// Sends that reached this address through a fee-taking checkout wallet paid for something else.
// Subnano post purchases and tips arrive this way: the buyer pays a one-time wallet, which forwards
// our share to us and the platform fee to Subnano's collector. Such a hash is never API credit,
// whoever presents it (the chain is public, so anyone could). Marked from the ledger at startup
// and every ten minutes; wallets with an incomplete history are re-checked next round.
const FEE_COLLECTORS = new Set(['nano_1gip4yjax4jzyqfpa3f3pzt1fefbbh4w1wt67wgw75wij34qy7yyio9jeuj4']);  // Subnano (7.5% sales, 5% tips)
const NO_CREDIT_REASON = 'this send came through a marketplace checkout wallet (a Subnano post purchase or tip); it paid for that, not for API calls';
const noCredit = new Map();   // send hash -> reason
// Sends this box knows paid for something else (ladder stakes, own moves, tranches, donations): api/purposes.js.
// Any hash listed there is refused and any credit already on it is zeroed; any send FROM a listed account likewise.
const purposes = require('./purposes');
let purposeReg = { hashes: new Map(), accounts: new Map() };
// purposeRegOk: the registry in memory was built from every source, read and parsed. Until then no bearer
// hash is credited (creditFor answers "retry shortly"): an unreadable or malformed source used to load as
// "absent", so a stake it listed would have been accepted until a later successful reload (Ops Control HQ,
// 2026-09-28, later-fix on 6a03a21). A failed reload after a good one keeps the last complete registry and
// says so in the log; the next round retries. x402 payments are fresh signed blocks and never consult this.
let purposeRegOk = false;
let reloading = null;   // one reload at a time; startup awaits the first (Ops Control HQ, 2026-09-28: the async reload raced the first requests)
function loadPurposes() { return reloading || (reloading = loadPurposesNow().finally(() => { reloading = null; })); }
async function loadPurposesNow() {
  try { purposeReg = purposes.load(); purposeRegOk = true; }
  catch (e) { console.error('purposes: registry NOT reloaded (' + e.message + '); ' + (purposeRegOk ? 'keeping the last complete one' : 'bearer credit stays refused until a load succeeds')); if (!purposeRegOk) setTimeout(loadPurposes, 30_000).unref(); return; }
  for (const [h, reason] of purposeReg.hashes) {
    noCredit.set(h, reason);
    if (h in credits && credits[h] !== '0') { credits[h] = '0'; save(); }
  }
  // A credit whose source account is now excluded is revoked as well, not only one whose hash is listed
  // (the first version zeroed by hash only, so an account exclusion held from the next presentation on, never
  // retroactively; Ops Control HQ, 2026-09-28). The account is looked up once per hash and remembered.
  // The lookups are best effort and bounded: the first failure ends them for this round (one RPC timeout at
  // most, not one per credit), and a credit whose account is still unknown is looked up, or refused, when it
  // is presented (creditForUnlocked), so the barrier cannot hang startup on a stalled node (Ops Control HQ, 2026-09-28).
  let nodeDown = false;
  for (const [h, v] of Object.entries(credits)) {
    if (v === '0' || noCredit.has(h)) continue;
    let acct = creditAccounts[h];
    // The first failed lookup ends the round's lookups, whether rpc() threw or the node answered {"error"} / no
    // block_account (a degraded node or proxy answers JSON errors without throwing; Enrico, 2026-09-28).
    if (!acct && !nodeDown) { try { const b = await rpc({ action: 'block_info', json_block: 'true', hash: h }); acct = b && !b.error && b.block_account; if (!acct) throw new Error(b && b.error || 'no block_account'); } catch (e) { nodeDown = true; console.error('purposes: node unavailable (' + e.message + '), remaining account lookups left to presentation time'); } if (acct) { creditAccounts[h] = acct; saveCreditAccounts(); } }
    const reason = acct && purposeReg.accounts.get(acct);
    if (reason) { noCredit.set(h, reason); credits[h] = '0'; save(); }
  }
}
const feeSend = new Map();    // send hash -> true (a fee send follows it: a checkout wallet's share) | false (positively not); null answers are not cached
// Pure. rows = the payer's account_history from `head: <the send>, reverse: true, count: 2`, oldest first: the send that paid
// us, then the block after it if there is one. A marketplace checkout wallet sends the seller's share and then the fee in
// consecutive blocks, so the fee send is the block AFTER the share, never before it: until 2026-09-30 the fee on either side
// counted, so an ordinary wallet that bought a Subnano post and then paid this API in its next block was refused as a checkout
// send (trollhunters, 2026-09-29). Judged per send, not per account: a wallet's other sends say nothing about this one, and the
// per-account cache repeated a refusal for every later hash from the same wallet (pyfile-toolkit, 2026-09-29). Answers true
// (a fee send follows), false (another block follows, or nothing follows a send older than a minute), or null when it cannot
// tell: nothing follows yet and the send is under a minute old (the fee block followed the share by 1-3 s in every case seen),
// or the rows do not start with the send (an empty history included: not "proven real payer"; pyfile-toolkit, 2026-09-29).
function feePassthrough(rows, fees, address, hash, now = Date.now()) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const first = rows[0];
  if (!first || String(first.hash || '').toUpperCase() !== String(hash || '').toUpperCase() || first.type !== 'send' || first.account !== address) return null;
  const next = rows[1];
  if (next) return next.type === 'send' && fees.has(next.account);
  return now / 1000 - (Number(first.local_timestamp) || 0) > 60 ? false : null;
}
async function feeRows(account, hash) {
  const a = await rpc({ action: 'account_history', account, head: hash, count: '2', reverse: 'true' });
  return a && !a.error && Array.isArray(a.history) ? a.history : null;
}
async function markFeePassthroughs() {
  let rows;
  try {
    const db = new DatabaseSync(site.DB_PATH, { readOnly: true });
    try { rows = db.prepare("select counterparty, meta_json from ledger where kind = 'payment_in' and counterparty like 'nano_%'").all(); } finally { db.close(); }
  } catch (e) { console.error('markFeePassthroughs: ledger:', e.message); return; }
  for (const r of rows) {
    let src; try { src = JSON.parse(r.meta_json || '{}').source_hash; } catch { /* no source hash */ }
    if (!src) continue;
    const h = src.toUpperCase();
    if (noCredit.has(h)) continue;
    let isFee = feeSend.get(h);
    if (isFee === undefined) {
      let rows;
      try { rows = await feeRows(r.counterparty, h); } catch { continue; }   // node unavailable: next round
      if (!rows) continue;
      isFee = feePassthrough(rows, FEE_COLLECTORS, ADDRESS, h);
      if (isFee === null) continue;   // nothing follows the send yet: next round
      feeSend.set(h, isFee);
    }
    if (!isFee) continue;
    noCredit.set(h, NO_CREDIT_REASON);
    if (h in credits && credits[h] !== '0') { credits[h] = '0'; save(); }   // credited before the wallet's fee block was visible
  }
}
// Is the send `hash` from `account` a checkout wallet's share (a fee send to a known collector is the block right after it)?
// Asked when a hash is first presented, so a receipt cannot be spent in the minutes before the ten-minute round sees it. The
// answer is per send and cached per hash (feePassthrough says why). A send under a minute old with nothing after it yet may
// still be followed by its fee block: look once more after 3 s. true: a checkout share (cached). false: positively not
// (cached). null: could not tell: node unavailable, an RPC error, the send not found on the account, or still nothing after
// a send under a minute old after the retry (not cached; the caller answers "retry in a minute"). A null must not become
// credit: it used to collapse to false, so a checkout send presented during an RPC outage became bearer credit until the
// ten-minute pass caught it (Ops Control HQ, 2026-09-28).
async function checkoutWallet(account, hash) {
  hash = String(hash || '').toUpperCase();
  if (feeSend.has(hash)) return feeSend.get(hash);
  for (let attempt = 0; attempt < 2; attempt++) {
    let rows;
    try { rows = await feeRows(account, hash); } catch { return null; }
    if (!rows) return null;
    const r = feePassthrough(rows, FEE_COLLECTORS, ADDRESS, hash);
    if (r !== null) { if (feeSend.size > 10_000) feeSend.clear(); feeSend.set(hash, r); return r; }
    if (attempt) return null;   // still nothing after a send under a minute old: indeterminate, not cached
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}
const RAW_PER_NANO = 10n ** 30n;

// A credit is a payment already on chain; this file is the only record that it has not been spent. Until 2026-10-20 it
// was rewritten in place, so a process killed mid-write left truncated JSON, the loader's `catch {}` answered {}, and every
// unspent balance silently became zero. Writes are now atomic (temp + fsync + rename, previous file kept as .bak) and a
// damaged file is reported instead of being read as "no credits" (llmrt, item 5, 2026-10-20).
const store = readJsonStore(DATA);
let credits = store.value;
if (store.damaged) console.error('credits: ' + DATA + ' is damaged (' + store.error + ')' + (store.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on'));
const save = () => writeJsonAtomic(DATA, credits);
// The paid-call counters, durable since 2026-10-23. They lived only in the process: every restart reset them to zero while
// `started` moved to the restart time, so /v1/stats answered "0 paid calls since 17:05 today" beside x402_settled 39 and
// credited_hashes 45 from the same durable files (llmrt, 2026-10-23, measured on the live service). A reader checking whether
// anything was ever sold here read zero, and the free-route counters next to them were already durable (checks.json), so the two
// halves of one answer disagreed about whether the service had been used at all. `started` is the first boot that recorded a
// number; `process_started_at` is this boot, so a reader can tell the two apart.
// Under `node --test` (NODE_TEST_CONTEXT set) the counters stay in memory unless a test names its own file: most of the suite
// boots this module with a mocked node and would otherwise rewrite the live counter file on every run. A test that is about
// durability passes STATS_FILE, and so does production.
const STATS_FILE = process.env.STATS_FILE || (process.env.NODE_TEST_CONTEXT ? null : path.join(__dirname, 'data', 'stats.json'));
let stats = { calls_paid: 0, calls_x402: 0, calls_402: 0, started: null };
if (STATS_FILE) { const r = readJsonStore(STATS_FILE); if (r.damaged) console.error('stats: ' + STATS_FILE + ' is damaged (' + r.error + ')' + (r.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on')); if (r.value && typeof r.value === 'object') stats = { ...stats, ...r.value }; }
stats.process_started_at = new Date().toISOString();
if (!stats.started) stats.started = stats.process_started_at;
function saveStats() {
  if (!STATS_FILE) return;
  try { writeJsonAtomic(STATS_FILE, { calls_paid: stats.calls_paid, calls_x402: stats.calls_x402, calls_402: stats.calls_402, started: stats.started }); }
  catch {}
}
// A 402 challenge is cheap and frequent (thousands a day), so the write is coalesced: at most one write per two seconds while
// counters move, plus one flush at exit. A counter is not money, so losing the last second of a killed process is acceptable;
// losing the whole history to a restart was not.
let statsFlushTimer = null;
function saveStatsSoon() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => { statsFlushTimer = null; saveStats(); }, 2000);
  if (statsFlushTimer.unref) statsFlushTimer.unref();
}
process.on('exit', () => { if (statsFlushTimer) { clearTimeout(statsFlushTimer); statsFlushTimer = null; saveStats(); } });
// A handed-back call is one that was charged and then not served (a target that never answered, a work_generate failure, a
// redirect that could not be followed). Its price goes back on the hash as credit, so it must stop counting as a paid call:
// until 2026-10-23 only calls_paid was rolled back, and an x402 payment that bought nothing left calls_x402 raised, so
// /v1/stats could answer calls_x402 > calls_paid (llmrt, 2026-10-23, from the source). `rail` is how the call was charged:
// 'x402' when the payment arrived as a PAYMENT-SIGNATURE, 'bearer' when it was an X-Nano-Payment hash.
function unpay(rail) { stats.calls_paid--; if (rail === 'x402' && stats.calls_x402 > 0) stats.calls_x402--; saveStatsSoon(); }
// The settled x402 blocks: the record that a block paid for a call, and the source of the known-payer list. Rewritten in
// place, a crash mid-write emptied it and the catch answered [], so every settled payment left the public record and every
// payer left the known-payer set (llmrt, item 5, 2026-10-20).
const x402Store = readJsonStore(X402_LOG);
let x402Log = Array.isArray(x402Store.value) ? x402Store.value : [];
if (x402Store.damaged) console.error('x402 log: ' + X402_LOG + ' is damaged (' + x402Store.error + ')' + (x402Store.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on'));
const saveX402Log = () => writeJsonAtomic(X402_LOG, x402Log);

// Every node call is bounded: a node that accepts the connection and never answers would otherwise hold
// whatever awaited it forever, and since 6a03a21 the startup barrier awaits a block_info per unrecorded
// credit (Ops Control HQ, 2026-09-28). A local node answers these in milliseconds; 15 s is generous.
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 15_000);
async function rpc(body) {
  const r = await fetch(RPC, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (!r.ok) throw new Error('rpc HTTP ' + r.status);   // a proxy's 429/5xx page is a transport failure, not an answer (Enrico, 2026-09-28)
  return r.json();
}

// work_generate for `hash` at the send threshold via the first source that answers.
// Returns { work, source, ms } or throws with the last error.
const workStats = { generated: 0, by_source: {}, by_tier: {}, last_error: '' };
// tier: 'paid' (GPU, no per-minute limit; at most four proofs at once), 'payer' (free call from an account that has paid before: GPU, no
// shared budget), 'free' (GPU while the shared budget lasts), 'free-slow' (budget spent: hosted key, then node).
async function workForOne(hash, { timeoutMs = 30_000, paid = false, knownPayer = false, threshold = x402.WORK_THRESHOLD } = {}) {
  let tier = paid ? 'paid' : knownPayer ? 'payer' : takeFreeGpu() ? 'free' : 'free-slow';
  const gpuOk = tier !== 'free-slow' && Date.now() >= gpuDownUntil;
  const sources = [...(gpuOk ? PAID_WORK_URLS : []).map(u => ({ name: workName(u), url: u, timeoutMs: paid ? 15_000 : 10_000, gpu: true })),
                   ...WORK_URLS.map(u => ({ name: workName(u), url: u, timeoutMs: workLocal(u) ? Math.max(timeoutMs, 90_000) : timeoutMs })), { name: 'node', url: RPC, timeoutMs: 180_000 }];
  let lastErr = 'no work source';
  for (const src of sources) {
    const t0 = Date.now();
    try {
      const r = await fetch(src.url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'work_generate', hash, difficulty: x402.WORK_THRESHOLD }),
        signal: AbortSignal.timeout(src.timeoutMs) });
      const j = await r.json();
      if (j && j.work) {
        // Every proof is checked against the hash and the threshold before it is passed on: a source answering with work for
        // another hash, or below threshold, used to be served as if valid, and the block built on it was refused by the node
        // after the call was paid for (uknwplayer, 2026-09-29). Such an answer falls through to the next source; when every
        // source fails the caller hands the call back (502, price restored on the hash).
        const w = String(j.work).toLowerCase();
        let valid = false;
        try { valid = nanocurrency.validateWork({ blockHash: hash, work: w, threshold }); } catch { valid = false; }
        if (valid) {
          workStats.generated++; workStats.by_source[src.name] = (workStats.by_source[src.name] || 0) + 1;
          workStats.by_tier[tier] = (workStats.by_tier[tier] || 0) + 1;
          return { work: w, source: src.name, ms: Date.now() - t0, tier };
        }
        lastErr = src.name + ': returned work that is not valid for this hash at ' + threshold;
        workStats.invalid = (workStats.invalid || 0) + 1;
      } else lastErr = src.name + ': ' + (j && (j.error || j.message) || 'no work in response');
    } catch (e) {
      lastErr = src.name + ': ' + e.message;
      if (src.gpu) { gpuDownUntil = Date.now() + 60_000; workStats.gpu_down_until = new Date(gpuDownUntil).toISOString(); }
    }
    workStats.last_error = lastErr;
  }
  throw new Error(lastErr);
}

// One proof per hash at a time, kept for a minute. Several distinct blocks on the same frontier (differing in
// representative, say) presented at once used to cost one proof each: the x402 lock is per block hash, and verify
// computes work over block.previous for every block that passes its cheaper checks, so a payer with one funded
// account could buy K proofs for one payment by presenting K signed variants of the same send together. Now the
// first computes it and the rest share it: at most one proof per frontier, which is what one block on that frontier
// is worth, and a payer who moves their own frontier to make the next one spends a proof of their own each time
// (kilkelly's question on kilkelly/x402-nano-exact-scheme-proposal#1, 2026-10-16). Work over a frontier is usable
// only by that account's owner, so sharing it leaks nothing. A failed attempt is dropped at once so a retry asks again.
const workPending = new Map();   // hash -> Promise<{ work, source, ms, tier }>
const WORK_KEEP_MS = 60_000;
// Paid proofs in flight are capped, as /v1/work's own slot count already was. Distinct accounts are distinct frontiers,
// so a payer with many funded accounts buys one proof per account; each is paid at the route price, so the flood is
// not a loss, but without a cap it queued every other workless payer behind it (kilkelly's Sybil question on the same
// thread, 2026-10-16). Past the cap a workless block is refused before anything is broadcast, with the 402 naming the
// alternative: attach work computed over block.previous and re-present the same signed block, since work sits outside
// the signature. Blocks that arrive with work never touch this path.
const PAID_WORK_MAX = Number(process.env.PAID_WORK_MAX || 4);
let paidWorkBusy = 0;
async function workFor(hash, opts = {}) {
  const key = String(hash).toUpperCase();
  const pending = workPending.get(key);
  if (pending) { const r = await pending; return { ...r, shared: true }; }
  if (opts.paid && paidWorkBusy >= PAID_WORK_MAX)
  {
    // Code first, prose after: the scheme thread (kilkelly, scheme-proposal#1, 2026-10-17) asked where a defined refusal
    // code would live; on the wire it is the leading token of the 402's `error`, so a client can match it without parsing.
    const e = new Error(PAID_WORK_MAX + ' proofs are being generated already; attach work computed over block.previous at ' + x402.WORK_THRESHOLD + ' and re-present the same signed block (work is outside the signature), or retry in a few seconds');
    e.code = 'work_unavailable';
    throw e;
  }
  if (opts.paid) paidWorkBusy++;
  workStats.paid_busy = paidWorkBusy;
  const p = workForOne(hash, opts);
  const release = () => { if (opts.paid) paidWorkBusy--; workStats.paid_busy = paidWorkBusy; };
  workPending.set(key, p);
  p.then(() => { release(); const t = setTimeout(() => { if (workPending.get(key) === p) workPending.delete(key); }, WORK_KEEP_MS); if (t.unref) t.unref(); },
         () => { release(); if (workPending.get(key) === p) workPending.delete(key); });
  return p;
}

// Accounts that have paid this server before, by any route. Free work for their frontier goes
// to the GPU without touching the shared budget. Work over a frontier is only usable by that
// account's owner, so requesting it for someone else's frontier gains an attacker nothing.
const PAYERS = path.join(__dirname, 'data', 'payers.json');
const knownPayers = new Set();
{ const r = readJsonStore(PAYERS); if (r.damaged) console.error('payers: ' + PAYERS + ' is damaged (' + r.error + ')' + (r.recovered ? '; recovered from .bak' : '')); if (Array.isArray(r.value)) for (const a of r.value) knownPayers.add(a); }
for (const e of x402Log) if (e.payer) knownPayers.add(e.payer);
{ const r = readJsonStore(path.join(__dirname, 'data', 'facilitator.json')); for (const e of ((r.value && r.value.settled) || [])) if (e.payer) knownPayers.add(e.payer); }
function rememberPayer(account) {
  if (!account || knownPayers.has(account)) return;
  knownPayers.add(account);
  try { writeJsonAtomic(PAYERS, [...knownPayers]); } catch {}
}
// Is `hash` the frontier of an account that has paid before? One local block_info; false for
// anything that is not a block on this node (e.g. a public key for an open block).
async function isKnownPayerFrontier(hash) {
  if (knownPayers.size === 0) return false;
  try { const b = await rpc({ action: 'block_info', json_block: 'true', hash }); return !!(b && b.block_account && knownPayers.has(b.block_account)); }
  catch { return false; }
}

// Look up a send block hash and turn it into credit (once).
// Every first-credit initialisation for a hash runs under that hash's lock, whoever asks. The 12:25 UTC fix locked only
// charge(), and GET /v1/credit still called the unlocked body: a status read racing a first paid call could finish after
// the debit and write the full block amount back, restoring spent credit (Ops Control HQ, 2026-09-27, from the source).
async function creditFor(hash) {
  if (!/^[0-9A-F]{64}$/i.test(hash)) return { error: 'bad hash' };
  return withHashLock(hash.toUpperCase(), () => creditForUnlocked(hash));
}
async function creditForUnlocked(hash) {
  if (!/^[0-9A-F]{64}$/i.test(hash)) return { error: 'bad hash' };
  hash = hash.toUpperCase();
  if (noCredit.has(hash)) return { error: noCredit.get(hash) };
  // A block this server broadcast for an x402 payment and answered 402 for is its payer's, not bearer credit: it is served
  // only to the re-presentation carrying the X-Nano-Represent token from that 402 (see REPRESENT; pyfile-toolkit, 2026-09-29).
  if (represent[hash]) return { error: 'this block was broadcast through this server for an x402 payment and is waiting for its payer to re-present the same PAYMENT-SIGNATURE with the X-Nano-Represent token from that 402; it is not spendable as X-Nano-Payment credit' };
  if (!purposeRegOk) return { error: 'the list of sends that are not API credit could not be loaded; bearer credit is refused until it is, retry shortly (x402 payments are unaffected)' };
  if (hash in credits) {
    if (!creditAccounts[hash] && credits[hash] !== '0') {   // stored before accounts were kept: look it up now rather than trust the reload to have finished
      try { const b = await rpc({ action: 'block_info', json_block: 'true', hash }); if (b && b.block_account) { creditAccounts[hash] = b.block_account; saveCreditAccounts(); } } catch { /* node unavailable */ }
      if (!creditAccounts[hash]) return { error: 'credit source not verifiable right now; retry shortly' };
    }
    const reason = creditAccounts[hash] && purposeReg.accounts.get(creditAccounts[hash]);   // account excluded since this credit was stored
    if (reason) { noCredit.set(hash, reason); if (credits[hash] !== '0') { credits[hash] = '0'; save(); } return { error: reason }; }
    return { remaining: BigInt(credits[hash]) };
  }
  const b = await rpc({ action: 'block_info', json_block: 'true', hash });
  if (b.error) return { error: 'block not found on this node yet; wait a second and retry' };
  if (b.confirmed !== 'true') return { error: 'block not confirmed yet; retry shortly' };
  if (b.subtype !== 'send' || b.contents.link_as_account !== ADDRESS)
    return { error: 'not a send to ' + ADDRESS };
  if (Number(b.local_timestamp) < NOT_BEFORE) return { error: 'block predates this service' };
  const known = purposeReg.hashes.get(hash) || purposeReg.accounts.get(b.block_account);   // a stake, an own move, a tranche, a donation (JoanAbad82, api#74)
  if (known) { noCredit.set(hash, known); return { error: known }; }
  const checkout = await checkoutWallet(b.block_account, hash);
  // null is also a send under a minute old with nothing after it yet (its fee block may still be settling), so the
  // reason names both and asks for a minute, not "shortly" (PlatinumVera, 2026-09-28 22:30 UTC).
  if (checkout === null) return { error: 'cannot check the payer account right now (node unavailable, or the send is under a minute old and a fee block may still follow it); nothing credited, retry in a minute' };
  if (checkout) { noCredit.set(hash, NO_CREDIT_REASON); return { error: NO_CREDIT_REASON }; }
  const amount = BigInt(b.amount);
  // README: "Overpayment stays as credit on that hash, capped at 1 NANO per hash". The cap is a ceiling on the
  // credit, not a refusal of the payment: a send above it is real money on chain, so refusing it whole left the payer
  // with nothing recorded while the block sat confirmed. Credit the ceiling and name the excess, so the payer can see
  // what was not applied. A tranche is excluded earlier, by the purpose registry and the fee-passthrough check, so
  // this path only sees payments.
  const credited = amount > MAX_CREDIT_RAW ? MAX_CREDIT_RAW : amount;
  credits[hash] = credited.toString();
  save();
  creditAccounts[hash] = b.block_account; saveCreditAccounts();
  rememberPayer(b.block_account);
  if (credited < amount) return { remaining: credited, capped: true, amount_raw: amount.toString(), excess_raw: (amount - credited).toString() };
  return { remaining: credited };
}

function nano(raw) {   // exact decimal NANO string for a raw amount (no float rounding)
  const r = BigInt(raw); const i = r / RAW_PER_NANO; const f = (r % RAW_PER_NANO).toString().padStart(30, '0').replace(/0+$/, '');
  return f ? i + '.' + f : i.toString();
}

// RFC 9110 12.5.3: a coding listed with q=0 is not acceptable and "*" stands for codings not named. The first version
// of the in-process gzip (12:25 UTC the same day) tested for the bare token, so "Accept-Encoding: gzip;q=0" still got a
// gzip body (Ops Control HQ from the source, uknwplayer against /.well-known/x402, 2026-09-27). No header means identity.
function acceptsGzip(header) {
  let gzip = null, star = null;
  for (const part of String(header || '').split(',')) {
    const [coding, ...params] = part.split(';');
    const c = coding.trim().toLowerCase();
    if (!c) continue;
    let q = 1;
    for (const prm of params) { const m = /^\s*q\s*=\s*([0-9]*\.?[0-9]*)\s*$/i.exec(prm); if (m) q = parseFloat(m[1]) || 0; }
    if (c === 'gzip' || c === 'x-gzip') gzip = q > 0;
    else if (c === '*') star = q > 0;
  }
  return gzip !== null ? gzip : star === true;
}

function send(res, code, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 1);
  const headers = { 'content-type': type + '; charset=utf-8', 'access-control-allow-origin': '*',
    'access-control-allow-headers': 'X-Nano-Payment, PAYMENT-SIGNATURE, X-PAYMENT, X-Nano-Represent, Content-Type',
    'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-Nano-Credit-Remaining-Raw, X-Nano-Payment-Hash, X-Nano-Represent, X-Nano-Replay' };
  // A reply served for a payment is remembered for a re-presentation of the same payment (replayIfServed).
  // Handed-back errors (400 redirect refusal or 502 noAnswer/work failure after charge) restore the credit and are not
  // served replies: caching >=200 non-2xx replayed the 400/502 (with its stale restored-credit header) and overwrote any
  // earlier 200 replay on a multi-call bearer hash.
  if (res.paidHash) {
    if (code >= 200 && code < 300) {
      const kept = {};
      for (const k of ['payment-response', 'x-nano-credit-remaining-raw']) { const v = res.getHeader(k); if (v !== undefined) kept[k] = v; }
      rememberServed(res.paidHash, res.replayKey, code, data, type, kept, res.replayBind);
    }
    res.paidHash = null;
  }
  // Declared length since 2026-09-26: a body cut by any proxy or sandbox between here and the reader is then an
  // HTTP error at the client, not a 200 with unparseable JSON (a reporter saw 16 KiB bodies on their own egress).
  // Compressed here, not by the proxy, since 2026-09-27: the proxy's encoder answered HEAD with Content-Length: 20
  // (the length of an empty gzip stream) on every route, so a HEAD then GET pair disagreed (pyfile-toolkit). With the
  // encoding done in-process the proxy passes the response through and HEAD and GET carry the same true length.
  let out = data, status = code;
  // Byte ranges since 2026-09-28: one reader's path (pyfile-toolkit; capture in research/fetch-stall) drops every
  // flow past about 20 KB, so /log.json (about 1 MB) never arrived whole there and "Range: bytes=500000-" answered
  // 200 with the start of the document. A single bytes range over the identity body now answers 206, never
  // compressed, so a big document can be fetched in pieces from behind such a path. Range on gzip is not offered.
  if (code === 200 && res.byteRange) {
    const total = Buffer.byteLength(data);
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(res.byteRange).trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start, end;
      if (m[1] === '') { start = Math.max(0, total - Number(m[2])); end = total - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
      if (start >= total || start > end) {
        headers['content-range'] = 'bytes */' + total; headers['content-length'] = 0;
        res.writeHead(416, headers); return res.end();
      }
      out = Buffer.from(data).subarray(start, end + 1); status = 206;
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + total;
    }
  }
  if (code === 200) headers['accept-ranges'] = 'bytes';
  if (status === 200 && res.acceptsGzip && Buffer.byteLength(data) >= 1024) {
    out = zlib.gzipSync(data); headers['content-encoding'] = 'gzip'; headers['vary'] = 'Accept-Encoding';
  }
  if (code !== 204 && code !== 304) headers['content-length'] = Buffer.byteLength(out);
  res.writeHead(status, headers);
  res.end(out);
}

const DESCRIPTIONS = { '/v1/echo': 'returns what you sent', '/v1/fetch': 'fetches a URL and returns the page as plain text', '/v1/hash': 'sha256 of the request body, with server time' };
function hostOf(req) { return String(req.headers['x-forwarded-host'] || req.headers.host || 'pursekeeper.dev').split(',')[0].trim(); }

// x402 v2 PaymentRequired for this request: header value plus the same object for the JSON body.
function x402Required(req, hint) {
  const u = new URL(req.url, 'http://x');
  // Every 402 carries a fresh extra.session in its accepts entry. A v2 client copies the entry it accepted into the
  // payload (`accepted`), so the value comes back with the payment over the same connection and never touches the chain:
  // it is the one thing a reader of the public block cannot rebuild, and the replay cache is bound to it (replayIfServed;
  // PlatinumVera, 2026-10-03, from the source). Neither stored nor checked for origin: any echoed value binds the replay
  // to the client that sent it; a payload that echoes none is replayed on method, URL and body alone (pyfile-toolkit,
  // 2026-10-03: extra is optional in the v2 schema, so a conforming client may have nothing to echo).
  const requirements = { ...X402_REQ, extra: { ...X402_REQ.extra, session: crypto.randomBytes(16).toString('hex') } };
  return x402.paymentRequired({ requirements, url: 'https://' + hostOf(req) + req.url,
    description: DESCRIPTIONS[u.pathname] || 'pursekeeper.dev paid call', error: hint || 'payment required' });
}

function paymentRequired(res, hint, req, extra) {
  stats.calls_402++;
  saveStatsSoon();
  // Count the refused side as well as the paid side: distinct callers of the payment door,
  // as IP hashes only (adopted 2026-09-20 after a Guild Hall cross-reading; see checkStats).
  if (req) {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const key = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
      checks.challenges_402 = (checks.challenges_402 || 0) + 1;
      checks.ips402 = checks.ips402 || {}; checks.ips402[key] = (checks.ips402[key] || 0) + 1;
      checks.since_402 = checks.since_402 || new Date().toISOString();
      writeJsonAtomic(CHECKS_FILE, checks);
    } catch {}
  }
  const pr = req ? x402Required(req, hint) : null;
  if (pr) res.setHeader(x402.REQUIRED_HEADER, pr.header);
  send(res, 402, {
    error: hint || 'payment required',
    pay_to: ADDRESS,
    price_nano: nano(PRICE_RAW),
    price_raw: PRICE_RAW.toString(),
    how: 'Send at least price_raw to pay_to, then retry with header X-Nano-Payment: <send block hash>. ' +
         'Anything above the price stays as credit on that hash for later calls (max 1 NANO per hash).',
    how_x402: 'Or pay per call with x402: decode the PAYMENT-REQUIRED header (base64 JSON, same as the x402 field below), ' +
              'sign a send block for exactly amount raw to payTo from your current frontier, and retry with header ' +
              'PAYMENT-SIGNATURE: base64({x402Version:2, accepted, payload:{block}}). See /v1/x402 and /examples/client-x402.js.',
    x402: pr ? pr.body : undefined,
    docs: '/',
    ...(extra || {})
  });
}

// x402 path: verify the signed send block locally, broadcast it, then serve. The settled
// hash is written to credits.json with zero credit so it can never be presented again
// through the X-Nano-Payment path (a settled x402 block is a confirmed send to us).
// The whole charge runs under the block's hash lock, keyed before verify: two concurrent requests carrying the same
// PAYMENT-SIGNATURE both passed verify's seen() check (the alreadyLanded branch never entered `settling`, and the normal
// branch entered it only after verify returned), and since b438d56 the second one's "Old block" rejection was turned into
// a settled success by the landed() fallback, so one block paid for two calls. Serialised, the second request sees the
// first's credits write and is refused as already used. A block that does not hash (malformed) runs unlocked so verify
// reports what is wrong with it (Ops Control HQ, 2026-09-28 22:34 UTC; llmrt, 2026-09-29 00:17 UTC).
async function chargeX402(req, res, headerValue) {
  const d = x402.decodePayment(headerValue);
  if (d.error) return paymentRequired(res, 'x402: ' + d.error, req), false;
  let key = null;
  try { key = x402.blockHash(d.payload.payload.block).toUpperCase(); } catch { /* verify names the fault */ }
  // The replay check (the same payment for the same call, served within ten minutes: the same reply again) runs under
  // the per-hash lock, so a duplicate that arrives while the first presentation is still being served waits for it
  // instead of racing it to "already used" (PlatinumVera, 2026-10-03).
  const run = async () => (key && replayIfServed(req, res, key, { secret: replaySecret(d.payload) })) ? false : chargeX402Locked(req, res, d.payload, key);
  return key ? withHashLock(key, run) : run();
}
// The session the client echoes from the 402 it paid (accepted.extra.session, see x402Required); null when it echoes none.
function replaySecret(payload) {
  try { const v = payload.accepted && payload.accepted.extra && payload.accepted.extra.session; return typeof v === 'string' && v.length >= 16 && v.length <= 128 ? v : null; } catch { return null; }
}
// After the broadcast the call is served only once the node reports the block confirmed: block_info is polled every
// X402_CONFIRM.intervalMs up to X402_CONFIRM.boundMs (250 ms, 8 s; both injectable for tests). Until 2026-09-29 the call was
// served the moment process accepted the block, the landed() branch included, so a block the node held unconfirmed had paid
// for a served call (uknwplayer; Ops Control HQ on the landed branch, 2026-09-28). Not confirmed within the bound: nothing is
// marked spent and the 402 names the hash and asks for the same payment again; the resend is served through verify's
// alreadyLanded branch, which requires confirmation.
const X402_CONFIRM = { intervalMs: 250, boundMs: 8_000 };
// A block this server broadcast and answered 402 for (not confirmed within the bound) is public on the chain from the
// broadcast, and until 2026-09-29 16:xx UTC the hash was not marked spent until served, so anyone reading the ledger could
// wrap the block in their own PAYMENT-SIGNATURE and be served through verify's alreadyLanded branch before the payer
// re-presented (trollhunters, 2026-09-29 16:29 UTC). The 402 now carries a single-use token (x-nano-represent header,
// represent_token in the body, named in the note) that binds the re-presentation to the payer: the resend must carry
// X-Nano-Represent: <token>. The token is the only binding: until 2026-09-29 20:5x UTC a resend from the same client
// address was accepted too, and an address is not a payer (agents behind one platform egress share it; a forwarded-for
// header can be shaped by the caller) (Ops Control HQ, 17:38 UTC). The record also closes the bearer path: a hash with a
// record here is refused as X-Nano-Payment credit (creditForUnlocked), because the block is a confirmed send to this
// address and the bearer path would otherwise credit whoever read it off the chain first (pyfile-toolkit, 18:42 UTC).
// Kept on disk; a record the payer never used is closed after 30 days (the hash is marked spent, so nobody can take it
// later either, and the reason names the mail address for a refund). A landed block with no record here (broadcast
// elsewhere, or before the record existed) is served as before, since this server never handed anyone a 402 for it.
const REPRESENT = path.join(__dirname, 'data', 'represent.json');
const REPRESENT_TTL_MS = 30 * 86_400_000;
const REPRESENT_EXPIRED = 'this block was broadcast through this server and answered 402 for, and its payer did not re-present it within 30 days; it is not spendable as credit; write to agent@pursekeeper.dev with the hash';
let represent = {};
// The X-Nano-Represent tokens bind a broadcast-but-unconfirmed block to the payer who was handed the 402. A damaged file
// read as {} turns every live token into "no record": the payer's own re-presentation is then served as before, which is the
// takeover the tokens exist to prevent. Read through the store and report damage instead (llmrt, item 5, 2026-10-20).
{ const r = readJsonStore(REPRESENT); if (r.damaged) console.error('represent: ' + REPRESENT + ' is damaged (' + r.error + ')' + (r.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on')); if (r.value && typeof r.value === 'object') represent = r.value; }
function saveRepresent() {
  const now = Date.now(); let spent = false;
  for (const [h, r] of Object.entries(represent)) if (now - r.at > REPRESENT_TTL_MS) { delete represent[h]; credits[h] = '0'; noCredit.set(h, REPRESENT_EXPIRED); spent = true; }
  if (spent) save();
  try { writeJsonAtomic(REPRESENT, represent); } catch {}
}
async function confirmedWithin(hash) {
  const deadline = Date.now() + X402_CONFIRM.boundMs;
  for (;;) {
    try { const b = await rpc({ action: 'block_info', json_block: 'true', hash }); if (b && b.confirmed === 'true') return true; } catch { /* node hiccup: poll again */ }
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, X402_CONFIRM.intervalMs));
  }
}
async function chargeX402Locked(req, res, payload, key) {
  const v = await x402.verify(payload, X402_REQ, {
    accountInfo: account => rpc({ action: 'account_info', account, representative: 'true', include_confirmed: 'true' }),
    seen: async h => (h in credits) || settling.has(h),
    reference: x402Reference,
    blockInfo: h => rpc({ action: 'block_info', json_block: 'true', hash: h }),   // amount and confirmation of a block that already landed (alreadyLanded)
    workGenerate: async hash => (await workFor(hash, { paid: true })).work   // a paying block earns its work
  });
  if (!v.ok) {
    // A re-presentation that arrives while the broadcast block is still unconfirmed fails verify's alreadyLanded gate
    // ("on the node but not confirmed yet"), and until 2026-10-03 that 402 carried neither the note nor the token, so the
    // skill's loop stopped on it and the payer was left with a landed block and no token to re-present it with
    // (PlatinumVera, 2026-10-03 00:29 UTC, from the source and a mock). The holder of the token gets the note and the same
    // token again, so its loop goes on; anyone else gets a 402 that names the wait and not the token, since the block is
    // public from the broadcast and the token is the only binding.
    const rep = key && represent[key];
    if (rep && /on the node but not confirmed yet/.test(v.reason)) {
      const given = String(req.headers['x-nano-represent'] || '').trim();
      if (given === rep.token) {
        res.setHeader('x-nano-represent', rep.token);
        const note = 'block ' + key + ' was broadcast but not yet confirmed (' + Math.round((Date.now() - rep.at) / 1000) + ' s since the broadcast); nothing was charged for this call; re-present the same PAYMENT-SIGNATURE with the same header X-Nano-Represent: ' + rep.token + ' (this reply carries it again as the x-nano-represent header and as represent_token) and it is served once the block is confirmed; do not sign a new block, that would pay twice';
        return paymentRequired(res, 'x402: block ' + key + ' was broadcast but not yet confirmed; re-present the same PAYMENT-SIGNATURE with X-Nano-Represent', req, { note, represent_token: rep.token }), false;
      }
      return paymentRequired(res, 'x402: block ' + key + ' was broadcast through this server, is not confirmed yet and is waiting for its payer to re-present it with the X-Nano-Represent token from the 402 that announced the broadcast; nothing served, nothing marked spent', req), false;
    }
    // A used block whose reply is still in the replay cache but was refused there: say what the replay needs.
    const hint = key && served.has(key) && /already used/.test(v.reason) ? '; the reply it bought is replayed within ten minutes for the same method, URL and body only, and when the payment echoed the extra.session of the 402 it paid (a v2 client copies the accepted entry, so this is automatic) only to a payload echoing the same session; a payment that echoed no session is replayed on method, URL and body alone' : '';
    // A refusal that carries a defined code (error_work_unavailable, the scheme draft's name since 2026-10-20) keeps the
    // code as the first token of `error`.
    return paymentRequired(res, (/^error_work_unavailable\b/.test(v.reason) ? '' : 'x402: ') + v.reason + hint, req), false;
  }
  // In `settling` for the whole serve, the alreadyLanded branch included: the facilitator shares the set, so its /verify
  // refuses the hash meanwhile (Ops Control HQ, 2026-09-28 22:34 UTC); its /settle queues on the same per-hash lock
  // (hashlock.js) and runs after this serve, when block_info finds the block (2026-09-29).
  settling.add(v.hash);
  try {
    // A landed block this server broadcast and answered 402 for is served only to its payer: the token from that 402 (see
    // REPRESENT). Refused here nothing is marked spent, so the payer's own re-presentation still works.
    const rep = v.alreadyLanded ? represent[v.hash] : null;
    if (rep) {
      const given = String(req.headers['x-nano-represent'] || '').trim();
      if (given !== rep.token)
        return paymentRequired(res, 'x402: block ' + v.hash + ' was broadcast through this server and is waiting for its payer to re-present it; send X-Nano-Represent with the token from that 402 (its x-nano-represent header and represent_token field); nothing served, nothing marked spent', req), false;
    }
    let s;
    // A block that is already the payer's frontier landed on an earlier attempt whose settle reply was lost: no second
    // broadcast, served as settled. A lost or failed process reply is likewise settled from the node's view of the hash
    // (deps.landed), not reported as a failed payment (Ops Control HQ, 2026-09-28).
    if (v.alreadyLanded) s = { success: true, network: x402.NETWORK, transaction: v.hash, payer: v.payer };
    else s = await x402.settle(v.block, v.payer, { hash: v.hash, process: block => rpc({ action: 'process', json_block: 'true', subtype: 'send', block }),
      landed: async h => { try { const b = await rpc({ action: 'block_info', json_block: 'true', hash: h }); if (b && b.error) return /not found/i.test(b.error) ? false : null; return b && b.contents ? true : null; } catch { return null; } } });
    if (!s.success) return paymentRequired(res, 'x402: ' + s.errorReason, req), false;
    if (!v.alreadyLanded && !await confirmedWithin(s.transaction)) {
      const token = crypto.randomBytes(16).toString('hex');
      represent[s.transaction] = { token, at: Date.now() }; saveRepresent();
      const note = 'block ' + s.transaction + ' was broadcast but not yet confirmed within ' + X402_CONFIRM.boundMs / 1000 + ' s; nothing was charged for this call; re-present the same payment (the unchanged PAYMENT-SIGNATURE) with the header X-Nano-Represent: ' + token + ' (this reply carries it as the x-nano-represent header and as represent_token) and it is served once the block is confirmed; the token binds the re-presentation to you, because the block is public on the chain from the broadcast; do not sign a new block, that would pay twice';
      res.setHeader('x-nano-represent', token);
      return paymentRequired(res, 'x402: block ' + s.transaction + ' was broadcast but not yet confirmed; re-present the same PAYMENT-SIGNATURE with X-Nano-Represent', req, { note, represent_token: token }), false;
    }
    credits[s.transaction] = '0';
    creditAccounts[s.transaction] = v.payer;
    if (v.hash !== s.transaction) { credits[v.hash] = '0'; creditAccounts[v.hash] = v.payer; }
    save(); saveCreditAccounts();
    if (represent[s.transaction] || represent[v.hash]) { delete represent[s.transaction]; delete represent[v.hash]; saveRepresent(); }
    x402Log.push({ hash: s.transaction, payer: v.payer, amount_raw: PRICE_RAW.toString(), resource: req.url, at: new Date().toISOString(), work_by: v.workBy || 'client' });
    rememberPayer(v.payer);
    try { saveX402Log(); } catch {}
    stats.calls_paid++; stats.calls_x402++;
    saveStatsSoon();
    res.setHeader(x402.RESPONSE_HEADER, x402.settleHeader(s));
    res.setHeader('x-nano-payment-hash', s.transaction);
    res.chargeRail = 'x402';   // read by unpay() when the call is handed back
    res.paidHash = s.transaction; res.replayKey = replayKey(req); res.replayBind = { secret: replaySecret(payload) };
    return true;
  } finally { settling.delete(v.hash); }
}

// Rate-limited proxy to the node's work_generate, for clients without a work server.
const workHits = new Map();   // ip -> [timestamps]
let workInFlight = 0;
// Free: FREE_WORK_PER_MIN per minute per IP (default 6), GPU while the shared budget lasts.
// Paid (X-Nano-Payment credit hash or an x402 PAYMENT-SIGNATURE at the standard price): no
// per-IP limit, GPU always. A paying x402 block gets its own work computed here too, so an
// agent with Nano but no PoW can buy its first work without doing any.
const FREE_WORK_PER_MIN = Number(process.env.FREE_WORK_PER_MIN || 6);
async function workGenerate(req, res) {
  const paid = !!(req.headers['x-nano-payment'] || x402.paymentHeader(req.headers));
  // Body and the busy cap before the charge: a paid call used to be debited and then answered 400 or 503 with no
  // hand-back, so a payer following the 503's "retry" paid again (PlatinumVera, 2026-09-28; same class as /v1/hash).
  let body;
  try { body = JSON.parse((await readBody(req, 10_000)).toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'body must be JSON {hash}; nothing charged' }); }
  const hash = String(body.hash || '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) return send(res, 400, { error: 'hash must be 64 hex characters (your account frontier); nothing charged' });
  if (workInFlight >= 4) return send(res, 503, { error: 'work server busy; retry in a few seconds; nothing charged' });
  // The slot is taken here, synchronously, before the charge awaits: taken only after charge() returned, five
  // concurrent paid calls all passed the check above and ran at once (tao wang, 2026-09-28). Every return below,
  // charge failed or free limit 402 included, releases it in the finally.
  workInFlight++;
  try {
    if (paid) {
      if (!await charge(req, res)) return;
    } else {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      const hits = (workHits.get(ip) || []).filter(t => now - t < 60_000);
      // Over the free limit the answer is a normal 402 with PAYMENT-REQUIRED, so an x402 client just pays.
      if (hits.length >= FREE_WORK_PER_MIN) return paymentRequired(res, 'free limit is ' + FREE_WORK_PER_MIN + ' work_generate calls per minute per IP; pay ' + nano(PRICE_RAW) + ' NANO per work (X-Nano-Payment credit or x402 PAYMENT-SIGNATURE) to continue without limit', req);
      hits.push(now); workHits.set(ip, hits);
      if (workHits.size > 10_000) workHits.clear();
    }
    try {
      const knownPayer = !paid && await isKnownPayerFrontier(hash);
      const r = await workFor(hash, { paid, knownPayer });
      if (paid) workStats.paid = (workStats.paid || 0) + 1;
      logReq(req, { kind: 'work', hash, ok: true, paid, tier: r.tier, source: r.source, ms: r.ms });
      return send(res, 200, { hash, work: r.work, threshold: x402.WORK_THRESHOLD, source: r.source, ms: r.ms, paid, tier: r.tier });
    } catch (e) {
      logReq(req, { kind: 'work', hash, ok: false, paid, error: e.message });
      // No work, no price: the call is handed back as credit on the hash that paid (an x402 block's hash is
      // reusable through X-Nano-Payment), under the same per-hash lock as charge(). The note carries the full
      // hash: an 8-character abbreviation cannot be retried with (PlatinumVera, 2026-09-28).
      let note = '';
      const h = String(req.headers['x-nano-payment'] || res.getHeader('x-nano-payment-hash') || '').toUpperCase();
      if (paid && h && h in credits) {
        const left = await withHashLock(h, async () => { credits[h] = (BigInt(credits[h] || '0') + PRICE_RAW).toString(); save(); unpay(res.chargeRail); return credits[h]; });
        res.setHeader('x-nano-credit-remaining-raw', left); note = '; the ' + nano(PRICE_RAW) + ' NANO for this call was handed back as credit on ' + h + ', retry with X-Nano-Payment: ' + h;
      }
      return send(res, 502, { error: 'work_generate: ' + e.message + note });
    }
  } finally { workInFlight--; }
}


// Free payment checks for sellers without a Nano node: is block H a confirmed send of at least
// N raw to address A (/v1/verify), and which confirmed sends to A are still unpocketed
// (/v1/receivable). Read-only against this node; 60 per minute per IP.
// One counter per route, because README gives each of the five free routes its own
// 60 per minute per IP (llmrt, 2026-10-22, api#103). A single shared map made the
// real allowance 60 in total across verify + receivable + account_info + process +
// requests, so a caller that polled /v1/verify could not read /v1/receivable in the
// same minute, and scripts/no-node.js receive died at the 30th pending send.
// /v1/credit is the sixth free route and carries the same allowance: it is the only one whose every miss reaches the
// node (creditForUnlocked answers a hash it has not stored with a block_info RPC), and until 2026-10-23 it had no counter
// at all, so a caller could ask it about fresh hashes without limit and every call was a node lookup (llmrt, 2026-10-23).
const checkHits = { verify: new Map(), receivable: new Map(), account_info: new Map(), process: new Map(), requests: new Map(), credit: new Map() };
// Persisted counters for the free checks, so third-party use of /v1/verify and
// /v1/receivable survives restarts and can be cited at review. IPs are stored only as
// short hashes, to count distinct callers without keeping addresses.
const CHECKS_FILE = path.join(__dirname, 'data', 'checks.json');
let checks = { verify: 0, receivable: 0, ips: {}, since: new Date().toISOString() };
// Durable since 2026-10-23 (llmrt on api#95, 2026-10-21; credited): this file holds no Nano, but it is the only record of
// third-party use of the free routes and of the 402 challenges, and it is what the reviews cite, so it is written through
// writeJsonAtomic and loaded through readJsonStore like the money files. A truncated file is named here at boot and the
// last complete copy is loaded from .bak, instead of every counter silently starting again from zero.
{ const r = readJsonStore(CHECKS_FILE); if (r.damaged) console.error('checks: ' + CHECKS_FILE + ' is damaged (' + r.error + ')' + (r.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on')); if (r.value && typeof r.value === 'object' && !Array.isArray(r.value)) checks = { ...checks, ...r.value }; }
// Request log for /v1/work and /v1/process: one JSON line per call, no raw IPs (sha256 prefix
// like checks.json). Exists so a report that says "I did not use pursekeeper.dev for work or
// broadcast" can be checked from here, and so a hosted-runtime run can point at its own line.
const REQ_LOG = path.join(__dirname, 'data', 'requests.jsonl');
function ipKey(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
}
function logReq(req, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ip_key: ipKey(req), ...entry });
  try { fs.appendFileSync(REQ_LOG, line + '\n'); } catch {}
}
// Entries whose `hash` or `previous` equals H, newest first, at most `limit`. Reads the whole
// file; fine at the sizes this log sees. Returns [] if the log does not exist yet.
// At most REQUESTS_MAX entries (default 20, env override), newest first. The answer says when it hit the bound: until
// 2026-10-23 it was a silent 20, and the route's promise is that a reader can tell whether a hash was used here at all
// (llmrt, 2026-10-23: 25 /v1/process calls on one previous answered `entries: 20` with no word that five were dropped).
const REQUESTS_MAX = Number(process.env.REQUESTS_MAX || 20);
// The most one answer will list even when asked: a log line is small, but the answer is served per request and 20 000
// entries of one hash is already a 2 MB reply from a file read on the request path.
const REQUESTS_HARD_MAX = 5000;
function reqLogFor(hash, limit = REQUESTS_MAX) {
  let lines = [];
  try { lines = fs.readFileSync(REQ_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.hash === hash || e.previous === hash) out.push(e);
  }
  return out;
}
// How many entries the log holds for this hash in total: the same scan without the cap, so the answer can say whether
// `entries` is everything. Counted rather than collected, so a hash used thousands of times costs no array.
function reqLogCount(hash) {
  let lines = [];
  try { lines = fs.readFileSync(REQ_LOG, 'utf8').split('\n').filter(Boolean); } catch { return 0; }
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.hash === hash || e.previous === hash) n++;
  }
  return n;
}
function countCheck(kind, req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
  checks[kind] = (checks[kind] || 0) + 1;
  checks.ips[key] = (checks.ips[key] || 0) + 1;
  try { writeJsonAtomic(CHECKS_FILE, checks); } catch {}
}
function checkStats() {
  // Every free route with a counter appears here. /v1/requests and /v1/credit carry the same 60/min allowance as the other
  // four and were never counted, so /v1/stats reported use of four routes out of six while its README row is the only public
  // record of third-party use and the reviews cite it (llmrt, 2026-10-23: 15 calls each answered 200 and 400 against the
  // live service and every counter in this object stayed at zero).
  return { verify: checks.verify, receivable: checks.receivable, account_info: checks.account_info || 0, process: checks.process || 0,
    requests: checks.requests || 0, credit: checks.credit || 0, distinct_ips: Object.keys(checks.ips).length, since: checks.since,
    challenges_402: checks.challenges_402 || 0, challenges_402_distinct_callers: Object.keys(checks.ips402 || {}).length, since_402: checks.since_402 || null };
}
function overFreeLimit(req, map, limit, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (map.get(ip) || []).filter(t => now - t < 60_000);
  if (hits.length >= limit) {
    // Retry-After in whole seconds: when the oldest hit in the window ages out, one call is allowed again. A client that
    // reads it (scripts/no-node.js receive since 2026-10-23) waits that long instead of a fixed guess (llmrt on api#103,
    // 2026-10-22, the line that asked for the header; credited, Ӿ0).
    if (res) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((hits[0] + 60_000 - now) / 1000))));
    return true;
  }
  hits.push(now); map.set(ip, hits);
  if (map.size > 10_000) map.clear();
  return false;
}
const MAX_RAW = 2n ** 128n - 1n;   // a Nano balance is a u128; the node answers "Bad threshold number" above it
// How many receivable hashes one /v1/receivable call asks the node for. A node answers at most this many per call; the answer
// says so when it hits the bound (llmrt, 2026-10-23).
const RECEIVABLE_MAX = Number(process.env.RECEIVABLE_MAX || 100);
function minRawOf(u) {
  const raw = u.searchParams.get('min_raw'), n = u.searchParams.get('min_nano');
  // Above 2^128-1 the node refused the threshold and the refusal was served as 502 (pyfile-toolkit, item 5, 2026-09-30);
  // since 2026-10-01 the parser refuses it with 400 on both routes, min_nano included.
  if (raw != null) {
    if (!/^\d{1,40}$/.test(raw)) throw new Error('min_raw must be an integer in raw');
    const v = BigInt(raw); if (v > MAX_RAW) throw new Error('min_raw must be at most ' + MAX_RAW + ' raw (2^128-1)'); return v;
  }
  if (n != null) {
    const m = /^(\d+)(?:\.(\d{1,30}))?$/.exec(n); if (!m) throw new Error('min_nano must be a decimal NANO amount');
    const v = BigInt(m[1]) * RAW_PER_NANO + BigInt((m[2] || '').padEnd(30, '0'));
    if (v > MAX_RAW) throw new Error('min_nano must be at most ' + nano(MAX_RAW) + ' NANO (' + MAX_RAW + ' raw, 2^128-1)'); return v;
  }
  return null;   // neither given: /v1/verify requires one (or any=1), /v1/receivable lists everything
}
async function verifyBlock(req, res, u) {
  if (overFreeLimit(req, checkHits.verify, 60, res)) return send(res, 429, { error: 'limit is 60 checks per minute per IP' });
  countCheck('verify', req);
  const hash = String(u.searchParams.get('hash') || '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hash)) return send(res, 400, { error: 'hash must be 64 hex characters (a block hash)' });
  // A Nano address has two spellings of the same account: nano_ and the pre-rename xrb_. checkAddress accepts both, and the
  // chain reports every destination as nano_, so an xrb_ spelling used to compare unequal to the block's own link and answer
  // ok:false "sent to nano_..., not to xrb_..." for the very account the block paid (llmrt, 2026-10-23). The facilitator
  // normalises payTo the same way (facilitator.js nanoPrefix); this route now does too, and the answer echoes the address in
  // its canonical nano_ spelling.
  const toRaw = u.searchParams.get('to');
  const to = toRaw ? toRaw.replace(/^xrb_/, 'nano_') : toRaw;
  if (to && !nanocurrency.checkAddress(to)) return send(res, 400, { error: 'to must be a nano_ address (or the same address in its xrb_ spelling)' });
  let minRaw; try { minRaw = minRawOf(u); } catch (e) { return send(res, 400, { error: e.message }); }
  // Without a minimum the amount was never checked and ok:true read as "paid" to a seller that forgot the parameter
  // (pyfile-toolkit, item 5, 2026-09-29). Since then ok is false with the reason when neither min_raw nor min_nano is given;
  // not a 400, so a caller that reads only `found` (the skill's no-node.js landed() check before 0.1.11) keeps working and
  // one that reads `ok` fails closed. any=1 asks only whether H is a confirmed send to A, and the answer says so.
  const anyAmount = u.searchParams.get('any') === '1' && minRaw === null;
  // Without `to` the destination was never checked either, and ok:true read as "paid to me" to a seller that passed only a
  // minimum (uknwplayer, 2026-09-29): since 2026-09-30 ok is false with the reason unless `to` is given or any_to=1 asks
  // only whether H is a confirmed send to anyone. Same shape as the amount rule: never a 400, `found` unchanged.
  const anyTo = u.searchParams.get('any_to') === '1' && !to;
  const b = await rpc({ action: 'block_info', json_block: 'true', hash });
  if (b.error) return send(res, 404, { hash, found: false, ok: false, error: 'block not found on this node (not broadcast yet, or wrong hash); retry in a second' });
  const amount = BigInt(b.amount || '0');
  const confirmed = b.confirmed === 'true';
  const dest = b.subtype === 'send' ? b.contents.link_as_account : null;
  const reasons = [];
  if (!confirmed) reasons.push('not confirmed yet; retry shortly');
  if (b.subtype !== 'send') reasons.push('not a send block (subtype ' + b.subtype + ')');
  if (to && dest && dest !== to) reasons.push('sent to ' + dest + ', not to ' + to);
  if (minRaw !== null && amount < minRaw) reasons.push('amount ' + amount + ' raw is below min ' + minRaw + ' raw');
  if (minRaw === null && !anyAmount) reasons.push('no minimum given, so the amount was not checked: pass min_raw or min_nano, or any=1 to ask only whether the block is a confirmed send to the address (ok needs both an amount side, min_raw, min_nano or any=1, and a recipient side, to= or any_to=1; e.g. ?any=1&to=A or ?any=1&any_to=1)');
  if (!to && !anyTo) reasons.push('no recipient given, so the destination was not checked: pass to=<your nano_ address>, or any_to=1 to ask only whether the block is a confirmed send to anyone (ok needs both a recipient side, to= or any_to=1, and an amount side, min_raw, min_nano or any=1; e.g. ?min_raw=N&to=A or ?any=1&any_to=1)');
  return send(res, 200, { hash, found: true, ok: reasons.length === 0, reason: reasons.join('; ') || undefined,
    confirmed, subtype: b.subtype, from: b.block_account, to: dest, amount_raw: amount.toString(), amount_nano: nano(amount),
    min_raw: minRaw === null ? null : minRaw.toString(), any_amount: anyAmount, expected_to: to || null, any_to: anyTo,
    height: Number(b.height), local_timestamp: Number(b.local_timestamp), checked_at: new Date().toISOString(), node: 'pursekeeper.dev' });
}
async function receivable(req, res, u) {
  if (overFreeLimit(req, checkHits.receivable, 60, res)) return send(res, 429, { error: 'limit is 60 checks per minute per IP' });
  countCheck('receivable', req);
  const account = u.searchParams.get('account') || '';
  if (!nanocurrency.checkAddress(account)) return send(res, 400, { error: 'account must be a nano_ address' });
  let minRaw; try { minRaw = minRawOf(u); } catch (e) { return send(res, 400, { error: e.message }); }
  const r = await rpc({ action: 'receivable', account, count: String(RECEIVABLE_MAX), source: 'true', include_only_confirmed: 'true', threshold: (minRaw !== null && minRaw > 0n ? minRaw : 1n).toString() });
  if (r.error) return send(res, 502, { error: 'node: ' + r.error });
  const blocks = Object.entries(r.blocks && typeof r.blocks === 'object' ? r.blocks : {}).map(([hash, v]) => ({ hash, amount_raw: String(v.amount), amount_nano: nano(v.amount), from: v.source }));
  const total = blocks.reduce((a, b) => a + BigInt(b.amount_raw), 0n);
  return send(res, 200, { account, count: blocks.length, total_raw: total.toString(), total_nano: nano(total), blocks, confirmed_only: true,
    // A node answers at most `count` receivable hashes per call, and until 2026-10-23 the count was fixed at 100 with no
    // word in the answer or the README: a seller with more than 100 unpocketed sends read 100 of them as if that were all, and
    // the rest were invisible to the poll that is meant to find every payment (llmrt, 2026-10-23). `truncated` is the node's own
    // signal for that, and `next` says how to read the rest.
    truncated: blocks.length >= RECEIVABLE_MAX,
    ...(blocks.length >= RECEIVABLE_MAX ? { next: 'the node answered its maximum of ' + RECEIVABLE_MAX + ' receivable hashes; pocket these, then poll again for the rest' } : {}),
    note: 'confirmed sends to this account that have not been pocketed with a receive block; each is final and spendable once received. Pocketing needs a signed receive block and work (POST /v1/work).', checked_at: new Date().toISOString(), node: 'pursekeeper.dev' });
}

// Free node proxies so an agent with a seed and no node can pocket and spend: account_info
// (frontier, balance, representative, confirmation height) and process (broadcast a signed
// state block). Both read/forward to this node only; 60 per minute per IP, counted like the checks.
async function accountInfo(req, res, u) {
  if (overFreeLimit(req, checkHits.account_info, 60, res)) return send(res, 429, { error: 'limit is 60 checks per minute per IP' });
  countCheck('account_info', req);
  const account = u.searchParams.get('account') || '';
  if (!nanocurrency.checkAddress(account)) return send(res, 400, { error: 'account must be a nano_ address' });
  const r = await rpc({ action: 'account_info', account, representative: 'true', include_confirmed: 'true' });
  if (r.error === 'Account not found') return send(res, 200, { account, found: false, frontier: null, balance_raw: '0', balance_nano: '0',
    representative: null, open: false, note: 'no blocks yet: the first block is an open (previous = 0 * 64, work on the account public key); see /v1/receivable for what it can pocket', node: 'pursekeeper.dev' });
  if (r.error) return send(res, 502, { error: 'node: ' + r.error });
  return send(res, 200, { account, found: true, open: true, ...shapeAccountInfo(r), checked_at: new Date().toISOString(), node: 'pursekeeper.dev' });
}
// Modern nodes (V24+) answer include_confirmed with confirmed_frontier / confirmed_height; older ones with
// confirmation_height_frontier / confirmation_height. Accept both, never invent a value: when neither is
// present, confirmed_frontier is null, confirmation_height is null and confirmed is false.
// (Dalton's item-5 report, 2026-09-11: the old mapping read only the legacy names and returned null on my own node.)
function shapeAccountInfo(r) {
  const pick = (...vals) => { for (const v of vals) if (v !== undefined && v !== null && v !== '') return String(v); return null; };
  const confirmedFrontier = pick(r.confirmed_frontier, r.confirmation_height_frontier);
  const height = pick(r.confirmed_height, r.confirmation_height);
  return { frontier: r.frontier, confirmed_frontier: confirmedFrontier, confirmed: confirmedFrontier !== null && confirmedFrontier === r.frontier,
    balance_raw: String(r.balance), balance_nano: nano(r.balance), confirmed_balance_raw: r.confirmed_balance != null ? String(r.confirmed_balance) : undefined,
    receivable_raw: String(r.receivable ?? r.pending ?? '0'), representative: r.representative, block_count: Number(r.block_count),
    confirmation_height: height !== null && /^\d+$/.test(height) ? Number(height) : null };
}
async function processBlock(req, res) {
  if (overFreeLimit(req, checkHits.process, 60, res)) return send(res, 429, { error: 'limit is 60 checks per minute per IP' });
  countCheck('process', req);
  let body;
  try { body = JSON.parse((await readBody(req, 20_000)).toString('utf8') || '{}'); } catch { return send(res, 400, { error: 'body must be JSON {block, subtype?}' }); }
  const block = body.block && typeof body.block === 'object' ? body.block : body;
  const need = ['type', 'account', 'previous', 'representative', 'balance', 'link', 'signature', 'work'];
  const missing = need.filter(k => block[k] == null || block[k] === '');
  if (missing.length) {
    // Logged too (hash null), so an egress probe from a hosted platform that POSTs an empty or
    // partial block leaves a dated line a claimant's report can be checked against.
    logReq(req, { kind: 'process', hash: null, previous: String(block.previous || '').toUpperCase() || null, account: block.account || null, subtype: null, ok: false, error: 'missing ' + missing.join(',') });
    return send(res, 400, { error: 'block is missing ' + missing.join(', ') + ' (a signed state block with work)' });
  }
  if (block.type !== 'state') return send(res, 400, { error: 'only state blocks' });
  const sub = ['send', 'receive', 'open', 'change', 'epoch'].includes(body.subtype) ? body.subtype : undefined;
  const r = await rpc({ action: 'process', json_block: 'true', ...(sub ? { subtype: sub } : {}), block });
  logReq(req, { kind: 'process', hash: r.hash || null, previous: String(block.previous || '').toUpperCase(), account: block.account, subtype: sub || null, ok: !r.error, error: r.error || null });
  if (r.error) return send(res, 400, { ok: false, error: 'node: ' + r.error, hint: 'common causes: wrong previous (use /v1/account_info frontier), balance not exact, work below threshold ' + x402.WORK_THRESHOLD + ' for previous (or the account public key for an open), signature over the wrong fields' });
  return send(res, 200, { ok: true, hash: r.hash, subtype: sub, note: 'broadcast; check confirmation with /v1/verify?hash=' + r.hash + '&any=1&any_to=1', node: 'pursekeeper.dev' });
}

async function charge(req, res) {
  const hash = req.headers['x-nano-payment'];
  if (!hash) {
    const ph = x402.paymentHeader(req.headers);
    return ph ? chargeX402(req, res, ph) : (paymentRequired(res, undefined, req), false);
  }
  // Check and debit run under a per-hash lock: creditFor() awaits the node for a hash it has not seen, and without
  // the lock several simultaneous first requests on one hash each read the full amount and each wrote the same
  // post-debit balance, so N requests could be served for one price (uknwplayer, 2026-09-27, from the source).
  return withHashLock(String(hash).toUpperCase(), async () => {
    const c = await creditForUnlocked(hash);
    if (c.error) return paymentRequired(res, c.error, req), false;
    if (c.remaining < PRICE_RAW) {
      if (replayIfServed(req, res, hash, { bearer: true })) return false;   // nothing left on the hash and the same call again: the reply it bought
      return paymentRequired(res, 'credit on this hash is used up', req), false;
    }
    const left = c.remaining - PRICE_RAW;
    credits[hash.toUpperCase()] = left.toString();
    save();
    stats.calls_paid++;
    saveStatsSoon();
    res.setHeader('x-nano-credit-remaining-raw', left.toString());
    res.chargeRail = 'bearer';
    res.paidHash = String(hash).toUpperCase(); res.replayKey = replayKey(req); res.replayBind = { bearer: true };
    return true;
  });
}

// --- endpoints ---------------------------------------------------------------

// Addresses a paid fetch must not reach, classified from parsed octets and hextets rather than a textual prefix: the
// regex missed fe80::/10 beyond the literal "fe80", the unspecified "::" and IPv4-mapped 169.254/16 (Ops Control HQ,
// 2026-09-28). Anything that does not parse is refused.
function parseV4(s) {   // four dotted decimal octets 0-255 -> [a, b, c, d], else null
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every(n => n <= 255) ? o : null;
}
// Every IPv4 range the IANA special-purpose registry marks not globally reachable: 0/8, 10/8, 100.64/10, 127/8,
// 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 and 240/4
// (multicast, reserved; 240/4 includes 255.255.255.255). The IPv6 branch below carries the same registry's ranges since
// 2026-09-29 (Ops Control HQ, 2026-09-28 22:26 and 22:32 UTC; ranges from the IANA special-purpose registries).
function ipv4Private(a, b, c, d) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    (a === 255 && b === 255 && c === 255 && d === 255);
}
// Eight numeric hextets for an IPv6 literal: a %zone is dropped, :: is expanded, a dotted IPv4 tail (dns.lookup
// returns forms like ::ffff:169.254.169.254) is folded into the last two hextets. null if it does not parse.
function expand6(ip) {
  let s = String(ip).replace(/%.*$/, '').toLowerCase();
  const v4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (v4) { const o = parseV4(v4[2]); if (!o) return null; s = v4[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = h => h === '' ? [] : h.split(':');
  const head = part(halves[0]), tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const hex = [...head, ...new Array(fill).fill('0'), ...tail];
  if (hex.length !== 8 || !hex.every(h => /^[0-9a-f]{1,4}$/.test(h))) return null;
  return hex.map(h => parseInt(h, 16));
}
function isPrivate(ip) {
  const v4 = parseV4(ip);
  if (v4) return ipv4Private(...v4);
  if (!net.isIPv6(ip)) return true;   // unparseable is refused
  const h = expand6(ip);
  if (!h) return true;
  const zero = n => h.slice(0, n).every(x => x === 0);
  const emb = i => ipv4Private(h[i] >> 8, h[i] & 255, h[i + 1] >> 8, h[i + 1] & 255);   // IPv4 embedded in hextets i, i+1
  if (zero(7) && h[7] <= 1) return true;                          // :: and ::1
  if (zero(5) && h[5] === 0xffff) return emb(6);                  // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(6)) return emb(6);                                     // ::a.b.c.d (IPv4-compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every(x => x === 0)) return emb(6);   // 64:ff9b::/96 (NAT64)
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true;   // 64:ff9b:1::/48 (RFC 8215 local-use translation)
  if (h[0] === 0x2002) return emb(1);                             // 2002::/16 (6to4)
  if ((h[0] & 0xfe00) === 0xfc00) return true;                    // fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true;                    // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true;                    // fec0::/10
  if ((h[0] & 0xff00) === 0xff00) return true;                    // ff00::/8
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;            // 2001:db8::/32
  if (h[0] === 0x2001 && h[1] === 2 && h[2] === 0) return true;     // 2001:2::/48 (benchmarking)
  if (h[0] === 0x2001 && (h[1] & 0xfff0) === 0x0010) return true;  // 2001:10::/28 (ORCHID)
  // 2001:20::/28 (ORCHIDv2, RFC 7343) is not refused: the IANA registry marks it globally reachable (jcemus, 2026-09-29).
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return true;       // 3fff::/20 (documentation, RFC 9637)
  if (h[0] === 0x5f00) return true;                                // 5f00::/16 (SRv6 SIDs, RFC 9602)
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true;   // 100::/64
  return false;
}

// Everything that can refuse a fetch target is checked here, and the /v1/fetch handler runs it before charge(),
// so a missing, malformed, non-http or private-address url answers 400 with nothing paid (uknwplayer, 2026-09-27).
// Returns { u, addrs }: the addresses the check classified, which fetchText pins the connection to. An IP literal
// host is classified as written, without DNS; a name is refused if any answer is private or there is none.
async function checkFetchUrl(urlStr) {
  let u; try { u = new URL(urlStr); } catch { throw new Error('bad url'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) only');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const lit = net.isIP(host);
  const addrs = lit ? [{ address: host, family: lit }] : await dns.lookup(host, { all: true });
  if (!addrs || !addrs.length) throw new Error('host has no address');
  if (addrs.some(a => isPrivate(a.address))) throw new Error('private address refused');
  return { u, addrs };
}
// `checked` is the { u, addrs } the /v1/fetch handler got from checkFetchUrl before the charge: the first hop connects
// to those pins and the name is not resolved a second time. Without it fetchText re-ran the lookup after the charge, and
// a transient DNS failure there threw an error carrying neither noAnswer nor unpaid, so the handler kept the payment and
// answered 400 with no hash to retry with (uknwplayer, 2026-09-29). Any failure before the target is contacted is flagged
// like a target that never answered, so the handler restores the price.
// Bounds: bounds.headersMs (FETCH_TIMEOUT_MS, default 15 s) from the first connection to the headers of the final hop,
// redirects included; then bounds.bodyMs (FETCH_BODY_TIMEOUT_MS, default 15 s) re-armed for the body read. Until
// 2026-09-29 the abort was cleared before r.text(), so a target that sent headers and then cut or stalled the body held
// the call open, or failed it, with the price kept and no hash named (trollhunters, item 5). A body cut or stalled is now
// handed back like a target that never answered (e.noAnswer). `bounds` is injectable for tests.
// maxBytes caps what is read off the socket, maxChars what is returned: a page past the second bound used to come back cut
// at 200,000 characters with no field saying so, so a buyer paid for a page and got a prefix that read as the whole document
// (the same silent-truncation class as /v1/receivable's 100-hash bound, llmrt, 2026-10-23).
const FETCH_BOUNDS = { headersMs: Number(process.env.FETCH_TIMEOUT_MS || 15_000), bodyMs: Number(process.env.FETCH_BODY_TIMEOUT_MS || 15_000),
  maxBytes: Number(process.env.FETCH_MAX_BYTES || 2_000_000), maxChars: Number(process.env.FETCH_MAX_CHARS || 200_000) };
async function fetchText(urlStr, checked, bounds = FETCH_BOUNDS) {
  // The connection goes only to the addresses the check saw: the global fetch resolved the name again on its own, so
  // a rebinding name could pass checkFetchUrl and then connect somewhere private (Ops Control HQ, 2026-09-28). Every
  // hop is pinned after its check and the dispatcher's lookup answers from the pins alone, never from DNS.
  let u, dispatcher, ufetch;
  const pins = new Map();   // lowercased hostname without brackets -> [{ address, family }]
  const pin = ({ u, addrs }) => { pins.set(u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), addrs); return u; };
  try {
    const undici = require('undici'); ufetch = undici.fetch;
    u = pin(checked || await checkFetchUrl(urlStr));
    dispatcher = new undici.Agent({ connect: { lookup: (host, opts, cb) => {
      const a = pins.get(String(host).toLowerCase());
      if (!a || !a.length) return cb(new Error('host not pinned: ' + host));
      if (a.some(x => isPrivate(x.address))) return cb(new Error('private address refused'));
      if (opts && opts.all) return cb(null, a.map(x => ({ address: x.address, family: x.family })));
      return cb(null, a[0].address, a[0].family);
    } } });
  } catch (e) { e.noAnswer = true; e.message = 'target was not contacted (' + e.message + ')'; throw e; }
  const ctl = new AbortController(); let t = setTimeout(() => ctl.abort(new Error('no answer within ' + bounds.headersMs / 1000 + ' s')), bounds.headersMs);
  let r;
  try {
    // Redirects are followed by hand and every hop goes through checkFetchUrl, so a public URL cannot bounce the
    // paid fetch to a private or link-local address (uknwplayer, 2026-09-27; redirect: 'follow' skipped the check).
    for (let hop = 0; ; hop++) {
      // No response at all from this hop (timeout, connection refused or reset, TLS failure; names were resolved before): nothing
      // was fetched and the call is handed back. Anything that arrives as an HTTP response, whatever its status, is
      // billable (Ops Control HQ, 2026-09-28 22:23 UTC).
      try { r = await ufetch(u, { dispatcher, signal: ctl.signal, redirect: 'manual', headers: { 'user-agent': 'nano-paid-api/0.1 (+pay-per-call fetch)' } }); }
      catch (e) { e.noAnswer = true; e.message = 'target did not answer (' + e.message + (e.cause && e.cause.message ? ': ' + e.cause.message : '') + ')'; throw e; }
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const loc = r.headers.get('location');
      let next;
      try {
        if (!loc) throw new Error('redirect without a location');
        if (hop >= 5) throw new Error('too many redirects');
        next = pin(await checkFetchUrl(new URL(loc, u).href));
      } catch (e) { e.unpaid = true; throw e; }   // refused before anything was fetched from the new host: the call is handed back
      u = next;
    }
    clearTimeout(t); t = setTimeout(() => ctl.abort(new Error('body not finished within ' + bounds.bodyMs / 1000 + ' s')), bounds.bodyMs);   // hops done: the body gets its own bound
    const ct = r.headers.get('content-type') || '';
    let body;
    // Headers arrived but the body did not: the socket was cut (e.g. content-length 100 and ten bytes), or the bound above
    // fired. Nothing usable was fetched, so the handler hands the call back with the hash, as for a target that never answered.
    try { body = await r.text(); }
    catch (e) {
      const m = 'target stopped answering mid-body (' + (e && e.message || String(e)) + (e && e.cause && e.cause.message ? ': ' + e.cause.message : '') + ')';
      const err = e instanceof Error ? e : new Error(m);
      err.message = m; err.noAnswer = true; throw err;
    }
    // The read is capped at maxBytes: remember that the target had more, so the answer can say it was cut rather than
    // presenting a prefix as the page.
    const readCut = body.length > bounds.maxBytes;
    if (readCut) body = body.slice(0, bounds.maxBytes);
    if (/html/i.test(ct)) {
      body = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
        .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    }
    const chars = body.length;
    const text = body.slice(0, bounds.maxChars);
    const cut = readCut || chars > bounds.maxChars;
    return { status: r.status, content_type: ct, url: u.href, text,
      text_chars: text.length, truncated: cut,
      // A buyer that got a prefix must not read it as the whole page. The bound is this seller's, so the answer names it and
      // how much was left out (llmrt, 2026-10-23).
      ...(cut ? { chars_before_cut: chars,
        next: 'this page is longer than the ' + bounds.maxChars + ' characters this seller returns in one call: text holds the first ' +
          text.length + (readCut ? ' of the ' + chars + ' characters read (the body was itself cut at ' + bounds.maxBytes + ' bytes)' : ' of ' + chars) +
          '; the remainder was dropped, not summarised, so fetch the target directly if you need all of it' } : {}) };
  } finally { clearTimeout(t); dispatcher.close().catch(() => {}); }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) reject(new Error('body too large')); else chunks.push(c); });
    req.on('end', () => { req.bodyBuffer = Buffer.concat(chunks); resolve(req.bodyBuffer); });   // kept for the replay key (charge runs after the body on POST routes)
    req.on('error', reject);
  });
}

// Served replies, keyed by the payment hash and kept ten minutes: a client whose reply was lost in transit re-presents the
// same payment (the unchanged PAYMENT-SIGNATURE, or X-Nano-Payment on a hash with nothing left on it) for the same method,
// URL and body and gets the same reply back, marked x-nano-replay: true, instead of "already used" and no way to get what it
// paid for (uknwplayer, 2026-09-29). A re-presentation for another route or body is not a lost reply and is refused as before;
// a hash with credit left buys a new call as before. The facilitator's /settle answers its own replays with the settled hash
// and time (facilitator.js) and is not cached here. Kept in memory only: a restart forgets, and the refusal stands.
// Binding (PlatinumVera, 2026-10-03, from the source): the hash above is public data, since the block is on the chain from
// the broadcast and a payload wrapping it can be rebuilt by anyone, so an x402 reply bought by a payload that echoed the
// extra.session of the 402 it paid (x402Required) is replayed only to a payload echoing the same session. A payment that
// echoed no session is replayed on method, URL and body alone: extra is optional in the x402 v2 schema this server parses
// with and the verifier never reads it, so a conforming client can pay with nothing to echo, and until 2026-10-04 its lost
// reply was refused as "already used" while the sentence on the front page promised the replay (pyfile-toolkit, 2026-10-03,
// from the source). The weaker binding is stated where it applies: whoever presents the same block for the same method, URL
// and body inside the ten minutes gets that reply. A bearer hash (X-Nano-Payment) is replayed to whoever presents it for
// the same call, as the credit itself goes to whoever presents the hash first; that path is bearer by design and documented
// as such. An x402 reply is never handed to a bearer presentation, nor a bearer reply to an x402 one.
const REPLAY_TTL_MS = 10 * 60_000;
const served = new Map();   // hash -> { key, code, body, type, headers, at, bind: { secret } | { bearer: true } }
function replayKey(req) { return req.method + ' ' + req.url + ' ' + crypto.createHash('sha256').update(req.bodyBuffer || '').digest('hex'); }
function rememberServed(hash, key, code, body, type, headers, bind) {
  const now = Date.now();
  for (const [h, s] of served) if (now - s.at > REPLAY_TTL_MS) served.delete(h);
  if (served.size > 5_000) served.clear();
  served.set(hash, { key, code, body, type, headers, at: now, bind: bind || {} });
}
function replayIfServed(req, res, hash, bind) {
  const s = served.get(String(hash || '').toUpperCase());
  if (!s || Date.now() - s.at > REPLAY_TTL_MS || s.key !== replayKey(req)) return false;
  if (!bind) return false;
  if (s.bind.bearer || bind.bearer) { if (!s.bind.bearer || !bind.bearer) return false; }
  else if (s.bind.secret && bind.secret !== s.bind.secret) return false;   // echoed a session: only that session; none: key alone
  for (const [k, v] of Object.entries(s.headers)) res.setHeader(k, v);
  res.setHeader('x-nano-replay', 'true');
  res.setHeader('x-nano-payment-hash', String(hash).toUpperCase());
  send(res, s.code, s.body, s.type);
  return true;
}

const DOCS = `Pay-per-call HTTP API, paid in Nano.
(x402 facilitator for exact on nano:mainnet: https://facilitator.pursekeeper.dev  Agent summary: /llms.txt   Public log: /log.json   Other Nano 402 sellers, verified by payment: /sellers.json   Human page: send Accept: text/html)

No account, no API key. Each call costs ${nano(PRICE_RAW)} NANO (${PRICE_RAW} raw).
Run by an AI agent as a public experiment: does software pay software with Nano?

Flow
  1. Call an endpoint. You get HTTP 402 with pay_to and price_raw.
  2. Send at least price_raw NANO to pay_to.
  3. Retry with header  X-Nano-Payment: <hash of your send block>.
     Overpayment stays as credit on that hash (max 1 NANO per hash), so one
     send can cover many calls. Whoever presents the hash first spends the credit.

x402
  The same endpoints also take standard x402 (v2) payments with the Nano scheme
  from @x402nano/exact: scheme "exact", network "nano:mainnet", asset "XNO",
  amount ${PRICE_RAW} raw. The 402 carries a PAYMENT-REQUIRED header (base64
  JSON; the same object is in the body under "x402"). Sign a send block from your
  current frontier for exactly that amount to payTo, and retry with PAYMENT-SIGNATURE: base64 JSON {x402Version: 2,
  accepted, payload: {block}}. This server verifies the block against its own node
  and broadcasts it, then waits up to 8 s for the node to confirm it before serving; the
  reply carries PAYMENT-RESPONSE with the block hash. A block not confirmed within 8 s
  answers 402 naming the hash with nothing charged: re-present the same PAYMENT-SIGNATURE
  (the same block, not a new one, which would pay twice) with the single-use X-Nano-Represent
  token that 402 carries, and it is served once confirmed. The block is public on the chain from
  the broadcast; the token is what binds the re-presentation to the payer, so nobody else can be
  served on it, and a block waiting for its token is not X-Nano-Payment credit for anyone either;
  a re-presentation that arrives while the block is still unconfirmed gets the same 402 and the
  same token again. A reply served for a payment is kept for ten minutes: re-present the same
  PAYMENT-SIGNATURE for the same method, URL and body and the same reply comes back with
  X-Nano-Replay: true (a reply given again, never a refusal, to the payer). The block is public
  and anyone could wrap it, so when the payment echoed the extra.session of the 402 it paid
  (every 402 here carries one; a v2 client echoes it by copying the accepted entry) the replay
  goes only to a payload echoing the same session; a payment that echoed no session (extra is
  optional in x402 v2) is replayed to whoever presents the same block for the same method, URL
  and body within the ten minutes, which is the only binding there is in that case. No external facilitator, no account. The block pays for one call and is not otherwise
  usable as X-Nano-Payment credit; the three exceptions are /v1/work answering 502
  because work generation failed, /v1/fetch answering 400 because a redirect could not
  be followed (the next target failed the same address check as the first URL, the
  redirect had no Location header, or there were more than five hops), and /v1/fetch
  answering 502 because the target never answered (timeout, refused or reset connection,
  TLS failure) or stopped answering mid-body (the body cut short or not finished within its
  own 15 s bound, after 15 s for the headers of the last hop; a name that does not resolve
  is not a 502: the first URL is refused with 400 before the charge, a later hop is handed
  back as a redirect that could not be followed; any complete HTTP response from the
  target, whatever its status, is billable), when the price
  goes on the block's hash as X-Nano-Payment credit and the
  400 or 502 body names the full hash to retry with. Work is optional here: the requirements carry
  extra.work = "optional", so send work "0" (the advertised form; omitting the field
  is accepted too) and this server computes it before broadcasting; if you include
  real work it must be valid at the send threshold. Other
  sellers may require it: check their extra.work before generating. Requirements:
  GET /v1/x402. Work, if you want your own: POST /v1/work.

Endpoints
  GET  /api                   this text (also / for non-browser clients)
  GET  /v1/price              price and address (free)
  GET  /v1/stats              paid calls so far (free)
  GET  /v1/credit?hash=H      remaining credit on a hash (free)
  GET  /v1/echo?msg=hi        returns what you sent (paid; for testing your client)
  GET  /v1/fetch?url=U        fetches U and returns the page as plain text (paid)
  POST /v1/hash               sha256 of the request body, with server time (paid)
  GET  /v1/x402               x402 payment requirements for the paid endpoints (free)
  GET  /v1/verify?hash=H&to=A&min_raw=N
                              is block H a confirmed send of at least N raw to nano_ address A?
                              ok:true needs BOTH an amount side and a recipient side, every call:
                                amount side:    min_raw=N, min_nano=X, or any=1 (amount not checked;
                                                the answer then carries min_raw: null, any_amount: true)
                                recipient side: to=A, or any_to=1 (any recipient; the answer then
                                                carries expected_to: null, any_to: true)
                              a call with only one side answers ok:false and the reason names the
                              missing side (since 2026-09-29 for the amount, 2026-09-30 for the
                              recipient; never a 400, found still answers). a seller that passes
                              only any_to=1 gets ok:false, which is the safe answer. combined calls:
                                ?hash=H&min_raw=N&to=A      paid at least N raw to A (the normal check)
                                ?hash=H&any=1&to=A          any confirmed send to A
                                ?hash=H&any=1&any_to=1      any confirmed send to anyone
                              min_raw is at most 2^128-1 (340282366920938463463374607431768211455),
                              min_nano likewise; above that the answer is 400 (since 2026-10-01)
                              (free, 60/min per IP; for sellers who take Nano and have no node).
                              Stateless: it answers ok for the same hash forever, and a block hash
                              is public on the chain, so keep your own list of hashes already
                              delivered for and refuse a repeat. Every free route's 429 carries
                              Retry-After in seconds.
  GET  /v1/receivable?account=A&min_raw=N
                              confirmed, unpocketed sends to A with amounts and senders (free, 60/min);
                              min_raw (or min_nano) is at most 2^128-1, else 400 (since 2026-10-01)
  GET  /v1/account_info?account=A
                              frontier, confirmed_frontier, confirmed (bool), balance, representative,
                              confirmation_height (null if the node gives none) (free, 60/min);
                              found:false with the open-block rule if the account has no blocks
  POST /v1/process {"block":{...state block...},"subtype":"send|receive|open|change"}
                              broadcast a signed state block through this node (free, 60/min).
                              With /v1/work, /v1/receivable and /v1/verify this is enough to
                              pocket and spend from a seed with no node: /examples/no-node.md
  GET  /v1/requests?hash=H   was H (or a block with previous H) worked or broadcast through here? {found, entries}. Free, 60/min
  POST /v1/work  {"hash":H}   work_generate at the send threshold for any hash; for a payment
                              block H is your account frontier (the block's previous), never the
                              new block's own hash (pyfile-toolkit, 2026-10-05). Free: 6 per
                              minute per IP, from a GPU (about a second) while a shared budget
                              of 30 free proofs a minute lasts, then CPU sources (10 s or more);
                              the reply's "source", "ms" and "tier" say which. Accounts that have
                              paid this server before skip the shared GPU budget on free calls (the
                              per-IP limit still applies). With X-Nano-Payment credit or an x402
                              payment header, ${nano(PRICE_RAW)} NANO per work, no per-minute limit.
                              GPU first for paid calls and for known payers, falling back to the
                              hosted work sources or this node when the GPU path returns no work
                              (this text said "always" until 2026-09-29); at most four proofs are
                              generated at once and a fifth call answers 503 with nothing charged; a workless x402 block arriving while four are in flight is refused with a 402 that asks for work attached, nothing broadcast

Example
  curl -s 'https://pursekeeper.dev/v1/fetch?url=https://example.com' \\
       -H 'X-Nano-Payment: YOUR_SEND_BLOCK_HASH'

Client examples: /examples/client.py  /examples/client.js  /examples/client-x402.js
Source: https://github.com/pursekeeper/api   Address: ${ADDRESS}
`;

// Renamed from paynano to pursekeeper on 2026-09-07 (PayNano is an existing tool by alecrios).
// Every *.paynano.dev host redirects to the same path on the matching pursekeeper.dev host.
const OLD_HOST = /(^|\.)paynano\.dev$/i;
function redirectOldHost(req, res) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().split(':')[0];
  if (!OLD_HOST.test(host)) return false;
  const code = (req.method === 'GET' || req.method === 'HEAD') ? 301 : 308;
  res.writeHead(code, { Location: 'https://' + host.replace(OLD_HOST, '$1pursekeeper.dev') + req.url, 'Cache-Control': 'public, max-age=86400' });
  res.end(); return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    res.acceptsGzip = acceptsGzip(req.headers['accept-encoding']);
    if (req.method === 'GET' || req.method === 'HEAD') res.byteRange = req.headers.range;
    if (redirectOldHost(req, res)) return;
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (await site.handle(req, res, u, send)) return;
    if (await cohorts.handle(req, res, u, send)) return;
    if (await facilitator.handle(req, res, u, send, { rpc, settling })) return;
    if (u.pathname === '/' || u.pathname === '/api') return send(res, 200, DOCS, 'text/plain');
    if (u.pathname.startsWith('/examples/')) {
      const root = path.join(__dirname, 'examples');
      let f = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(u.pathname.slice('/examples/'.length))));
      if (f !== root && !f.startsWith(root + path.sep)) return send(res, 404, { error: 'no such example' });
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
        const readme = path.join(f, 'README.md');
        if (fs.existsSync(readme)) f = readme;
        else {
          // No README: answer with a plain-text index instead of 404, so a report's link to its evidence
          // directory works (Luke Finigan's item 5 report, 2026-09-26).
          const rel = path.relative(root, f).split(path.sep).join('/');
          const names = fs.readdirSync(f).filter(n => !n.startsWith('.')).sort();
          const lines = names.map(n => { const st = fs.statSync(path.join(f, n)); return st.isDirectory() ? n + '/' : n + '  (' + st.size + ' bytes)'; });
          return send(res, 200, '/examples/' + (rel ? rel + '/' : '') + '\n\n' + lines.join('\n') + '\n', 'text/plain');
        }
      }
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'no such example' });
      return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain');
    }
    if (u.pathname === '/v1/price') return send(res, 200, { pay_to: ADDRESS, price_raw: PRICE_RAW.toString(), price_nano: nano(PRICE_RAW) });
    if (u.pathname === '/v1/stats') {
      // The paid counters and the two figures beside them come from different files: x402_settled is the durable settled list and
      // credited_hashes the durable credit store, while calls_paid used to reset on every restart (see STATS_FILE). The answer now
      // carries both clocks and says when they disagree, so a reader never has to guess whether "0 paid calls" means none ever or
      // none since the last boot.
      const inconsistent = stats.calls_paid < x402Log.length || stats.calls_paid < 0;
      return send(res, 200, { ...stats, checks: checkStats(), credited_hashes: Object.keys(credits).length, x402_settled: x402Log.length,
        ...(inconsistent ? { counters_note: 'calls_paid is below x402_settled, so this counter lost history before it was written to disk on 2026-10-23; x402_settled and credited_hashes are the durable figures, calls_paid counts from started' } : {}),
        x402_work_by_seller: x402Log.filter(e => e.work_by === 'seller').length, work: { ...workStats, free_gpu_budget_per_min: FREE_GPU_PER_MIN, free_gpu_tokens_now: Math.floor(freeGpu.tokens), known_payers: knownPayers.size }, work_sources: workSources() });
    }
    if (u.pathname === '/.well-known/x402') {
      // Discovery manifest read by seller directories (agent402.tools, agent-tools.cloud, nohumans.directory). Same shape as the
      // x402 v2 PaymentRequired object per resource, plus the fields pyfile's and Vend's manifests carry, so any of their readers works.
      const base = 'https://' + hostOf(req);
      const pay = { protocol: 'x402', scheme: X402_REQ.scheme, network: X402_REQ.network, asset: X402_REQ.asset, currency: 'XNO', payTo: ADDRESS, facilitator: 'https://facilitator.pursekeeper.dev' };
      const r = (url, method, description) => ({ url: base + url, method, description, accepts: [X402_REQ] });
      return send(res, 200, {
        x402Version: x402.X402_VERSION, kind: 'resource-server', spec: 'x402-discovery/1', seller: 'pursekeeper', name: 'pursekeeper',
        description: 'Pay-per-call API paid in Nano (XNO) on nano:mainnet, ' + nano(PRICE_RAW) + ' XNO per call, no account, no key: x402 v2 scheme exact (PAYMENT-SIGNATURE with a signed state block) or X-Nano-Payment: <send block hash>. Run by an autonomous agent; every payment is public at ' + base + '/log',
        homepage: base, docs: base + '/', llms: base + '/llms.txt', contact: 'agent@pursekeeper.dev', log: base + '/log.json', sellers: base + '/sellers.json',
        payment: pay, payments: [pay],
        resources: [
          r('/v1/fetch?url=', 'GET', 'fetches the absolute http(s) URL given in the required url query parameter and returns the page as plain text; a request whose url is missing, malformed, non-http or on a private host is refused with 400 before any payment is taken'),
          r('/v1/echo?msg=', 'GET', 'returns what you sent (test your payment client)'),
          r('/v1/hash', 'POST', 'sha256 of the request body, with server time'),
          r('/v1/work', 'POST', 'Nano proof of work for {"hash": H} at the send threshold, from a GPU in about a second; 6 per minute per IP free; paid calls have no per-minute limit, at most four proofs are generated at once and a fifth call answers 503 with nothing charged; a workless x402 block arriving while four are in flight is refused with a 402 that asks for work attached, nothing broadcast'),
        ],
        free: [base + '/v1/verify', base + '/v1/receivable', base + '/v1/account_info', base + '/v1/process', base + '/v1/requests', base + '/v1/price', base + '/v1/stats', base + '/v1/x402'],
        payment_requirements: base + '/v1/x402',
      });
    }
    if (u.pathname === '/v1/x402') return send(res, 200, {
      x402Version: x402.X402_VERSION, accepts: [X402_REQ],
      // resource.url is this document (a URL, not a template; pyfile-toolkit 2026-09-28); each paid route's own 402 carries its concrete URL.
      resource: { url: 'https://' + hostOf(req) + '/v1/x402', description: 'pursekeeper.dev pay-per-call API: the payment requirements shared by every paid route; a paid call answers 402 with the same accepts entry and its own concrete resource.url', mimeType: 'application/json' },
      // method and input per route, as /.well-known/x402 states them: the bare list read as GET-able URLs, but /v1/hash
      // and /v1/work are POST-only and a bare /v1/fetch answers 400 (PlatinumVera, 2026-09-28).
      paid_routes: [
        { url: 'https://' + hostOf(req) + '/v1/echo?msg=', method: 'GET', input: 'msg query parameter, returned as sent' },
        { url: 'https://' + hostOf(req) + '/v1/fetch?url=', method: 'GET', input: 'url query parameter, required: an absolute http(s) URL to a public host; missing, malformed, non-http or private-host answers 400 before any payment is taken' },
        { url: 'https://' + hostOf(req) + '/v1/hash', method: 'POST', input: 'request body, any bytes up to 1 MB: the reply is its sha256' },
        { url: 'https://' + hostOf(req) + '/v1/work', method: 'POST', input: 'JSON body {"hash": H}, H 64 hex characters (your account frontier): the reply is work for H at the send threshold' },
      ],
      request_header: 'PAYMENT-SIGNATURE (X-PAYMENT also accepted): base64 JSON {x402Version:2, accepted, payload:{block}}',
      response_header: 'PAYMENT-RESPONSE: base64 JSON {success, transaction, network, payer}',
      block_rules: 'state block from your current confirmed frontier; balance = current balance - amount exactly; link = payTo; work optional (extra.workOptional = true, also written extra.work = "optional", refers to the work field of the payment block itself, on every route including /v1/work, whose product is work for the hash you name in the body): send work "0" (the advertised form; omitting the field is accepted too) and this seller computes it before broadcasting; if you send real work it must be valid at ' + x402.WORK_THRESHOLD + ' against previous; extra.workThreshold names that threshold',
      work: 'POST /v1/work {"hash": "<frontier>"}: 6 per minute per IP free (GPU, about a second, within a shared budget of ' + FREE_GPU_PER_MIN + ' a minute; CPU after that), or pay ' + nano(PRICE_RAW) + ' NANO per work (same headers) with no per-minute limit, at most four proofs generated at once and a fifth call answering 503 with nothing charged, a workless x402 block arriving while four are in flight refused with a 402 that asks for work attached, nothing broadcast; for sends to anyone else', example: '/examples/client-x402.js', spec: 'https://github.com/x402nano/schemes',
      work_sources: workSources() });
    if (u.pathname === '/v1/work' && req.method === 'POST') return workGenerate(req, res);
    if (u.pathname === '/v1/verify') return verifyBlock(req, res, u);
    if (u.pathname === '/v1/receivable') return receivable(req, res, u);
    if (u.pathname === '/v1/account_info') return accountInfo(req, res, u);
    if (u.pathname === '/v1/process' && req.method === 'POST') return processBlock(req, res);
    if (u.pathname === '/v1/requests' && req.method === 'GET') {
      if (overFreeLimit(req, checkHits.requests, 60, res)) return send(res, 429, { error: 'limit is 60 checks per minute per IP' });
      countCheck('requests', req);
      const h = String(u.searchParams.get('hash') || '').toUpperCase();
      if (!/^[0-9A-F]{64}$/.test(h)) return send(res, 400, { error: 'hash must be 64 hex characters (a block hash, or the frontier work was asked for)' });
      // limit: how many entries to list, default REQUESTS_MAX and never more than REQUESTS_HARD_MAX. Until 2026-10-23 the
      // 20 was a constant with no parameter and no word in the answer, so a caller checking its own history saw 20 of 25
      // and read that as all (llmrt, 2026-10-23, reproduced against the live service).
      const want = u.searchParams.get('limit');
      let limit = REQUESTS_MAX;
      if (want !== null) {
        if (!/^\d{1,6}$/.test(want) || Number(want) < 1) return send(res, 400, { error: 'limit must be a positive integer (at most ' + REQUESTS_HARD_MAX + ')' });
        limit = Math.min(Number(want), REQUESTS_HARD_MAX);
      }
      const entries = reqLogFor(h, limit), total = reqLogCount(h);
      return send(res, 200, { hash: h, found: entries.length > 0, entries, total,
        // The bound is the answer's own: a reader who needs every entry pages with `limit` (up to the total) rather than
        // reading the newest 20 as the whole log, which is what this route did until 2026-10-23 (llmrt).
        truncated: total > entries.length,
        ...(total > entries.length ? { next: 'this answer lists the newest ' + entries.length + ' of ' + total + ' entries for this hash; pass limit=' + Math.min(total, REQUESTS_HARD_MAX) + ' for all of them' } : {}),
        note: 'every /v1/work and /v1/process call since 2026-09-16 is logged here by hash; absence means pursekeeper.dev was not used for that block' });
    }
    if (u.pathname === '/v1/credit') {
      if (overFreeLimit(req, checkHits.credit, 60, res)) return send(res, 429, { error: 'limit is 60 checks per minute per IP' });
      countCheck('credit', req);
      const c = await creditFor(u.searchParams.get('hash') || '');
      if (c.error) return send(res, 400, { error: c.error });
      const body = { remaining_raw: c.remaining.toString(), remaining_nano: nano(c.remaining) };
      // A send past the cap is credited at the cap, and the reply names what was not applied (pursekeeper, 2026-10-22).
      if (c.capped) { body.capped = true; body.amount_raw = c.amount_raw; body.excess_raw = c.excess_raw; }
      return send(res, 200, body);
    }
    if (u.pathname === '/v1/echo') {
      if (!await charge(req, res)) return;
      return send(res, 200, { echo: u.searchParams.get('msg') || '', at: new Date().toISOString(),
        notice: 'This endpoint is run by an AI agent (pursekeeper). Paying it regularly? Say who you are at agent@pursekeeper.dev or github.com/pursekeeper/api/issues/1; every payment is public at /log.' });
    }
    if (u.pathname === '/v1/fetch') {
      const target = u.searchParams.get('url') || '';
      let checked;   // the resolved, classified target; fetchText pins the first hop to it and does not resolve again after the charge
      try { checked = await checkFetchUrl(target); }
      catch (e) { return send(res, 400, { error: e.message, note: 'url must be an absolute http(s) URL to a public host; this check runs before any payment is taken' }); }
      if (!await charge(req, res)) return;
      try { return send(res, 200, await fetchText(target, checked)); }
      catch (e) {
        // A redirect to a refused host is the target's doing, not the buyer's, and nothing was fetched: hand the call back.
        // For X-Nano-Payment the price goes back on the hash. For x402 the payment block is already on the chain and cannot
        // be undone, so the price goes on the settled block's hash as X-Nano-Payment credit instead; the first version of
        // this hand-back (12:25 UTC) restored only the header path and still said "not charged" (Ops Control HQ, Pururin-ux).
        // A target that never answered (e.noAnswer: timeout, refused or reset connection, TLS failure, or anything that failed
        // before the target was contacted) is handed back the same way, with 502; a target that answered anything is billable
        // (Ops Control HQ, 2026-09-28 22:23 UTC). A name that does not resolve never gets here: the first URL is refused with 400
        // before the charge, and a redirect hop's lookup failure is e.unpaid (uknwplayer, 2026-09-29).
        const h = String(req.headers['x-nano-payment'] || res.getHeader('x-nano-payment-hash') || '').toUpperCase();
        const why = e.unpaid ? 'the redirect could not be followed (' + e.message + ') before any fetch from the new host' : e.message;
        let note;
        if ((e.unpaid || e.noAnswer) && h && h in credits) {
          // The hand-back runs under the same per-hash lock as charge(): written outside it, the restored credit could land
          // between another request's balance read and its debit write on the same hash and be overwritten, losing the
          // handed-back call (Ops Control HQ, 2026-09-27 17:28 UTC, from the source of the 16:41 UTC version).
          const left = await withHashLock(h, async () => {
            credits[h] = (BigInt(credits[h] || '0') + PRICE_RAW).toString(); save(); unpay(res.chargeRail);
            return credits[h];
          });
          res.setHeader('x-nano-credit-remaining-raw', left);
          note = why + '; the call was handed back: the price is back on hash ' + h + ' as X-Nano-Payment credit (' + nano(left) + ' NANO remaining), so retry with X-Nano-Payment: ' + h + (req.headers['x-nano-payment'] ? '' : '; the x402 payment block itself is on the chain and is not reversed');
        } else if (e.unpaid || e.noAnswer) note = why + '; nothing was charged';
        return send(res, e.noAnswer ? 502 : 400, { error: e.message, ...(note ? { note } : {}) });
      }
    }
    if (u.pathname === '/v1/hash' && req.method === 'POST') {
      // Body before charge (uknwplayer, 2026-09-27): a body over the limit used to be charged and then answered 500.
      if (Number(req.headers['content-length'] || 0) > 1_000_000) return send(res, 413, { error: 'body too large (1 MB max); nothing charged' });
      let body; try { body = await readBody(req); } catch (e) { return send(res, 413, { error: e.message + ' (1 MB max); nothing charged' }); }
      if (!await charge(req, res)) return;
      return send(res, 200, { sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, at: new Date().toISOString() });
    }
    send(res, 404, { error: 'no such endpoint', docs: '/' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});
if (require.main === module) {
  // The purpose registry and the credit revalidation finish before the first request is accepted.
  loadPurposes().then(() => {
    server.listen(PORT, '127.0.0.1', () => console.log('listening on', PORT));
    markFeePassthroughs(); setInterval(() => { loadPurposes().then(markFeePassthroughs); }, 600_000).unref();
    cohorts.warm();
  });
}
module.exports = { shapeAccountInfo, logReq, reqLogFor, REQ_LOG, feePassthrough, FEE_COLLECTORS, checkoutWallet, workFor, send, acceptsGzip, isPrivate, expand6, checkFetchUrl, fetchText, chargeX402, creditFor, loadPurposes,
  server, credits, X402_CONFIRM, FETCH_BOUNDS };   // server (the http.Server, not listening), credits, X402_CONFIRM and FETCH_BOUNDS for tests
