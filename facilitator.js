// Public x402 facilitator for the "exact" scheme on nano:mainnet.
//
// Served at the root of facilitator.pursekeeper.dev and under /facilitator on
// pursekeeper.dev. Wire format is the x402 facilitator HTTP API that resource-server
// libraries (@x402/core, x402 Python) already speak:
//
//   GET  /supported  -> { kinds: [{ x402Version, scheme, network, extra }], extensions, signers }
//   POST /verify     { x402Version?, paymentPayload, paymentRequirements }
//                    -> { isValid, invalidReason?, invalidMessage?, payer }   (detail = invalidMessage, deprecated, until 0.3.0)
//   POST /settle     same body -> { success, errorReason?, errorMessage?, transaction, network, payer }   (detail = errorMessage, deprecated)
//   GET  /stats      counters since start, settled blocks
//   GET  /           this documentation
//
// Verification follows the nine checks of the scheme proposal (x402-foundation/x402#3432,
// specs/schemes/exact/scheme_exact_nano.md at 40d009d): x402 version, asset XNO, block
// structure, signature, payTo, previous == frontier, balance delta == amount, work at the
// send threshold, and the block hash not already on the chain. Two checks on top: the
// frontier must be confirmed, and the accepted requirements in the payload must equal the
// requirements the resource server sent us (scheme, network, payTo, amount, asset).
// Settlement broadcasts the block and polls block_info for confirmed == "true".
//
// The facilitator never computes work for a payer (the spec says the client MUST include
// it) and never holds funds: every block it broadcasts pays the resource server's payTo.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const N = require('nanocurrency');
const x402 = require('./x402');
const { withHashLock } = require('./hashlock');   // the seller path's per-hash lock, shared
const { writeJsonAtomic, readJsonStore } = require('./creditstore');   // durable money files (see creditstore.js)

const HOST = 'facilitator.pursekeeper.dev';
const PREFIX = '/facilitator';
const STATS_FILE = path.join(__dirname, 'data', 'facilitator.json');
const LIMITS = { verify: 120, settle: 60 };   // per IP per minute
const MAX_POLL_S = 30;                          // cap on maxTimeoutSeconds for confirmation polling

let stats = { since: new Date().toISOString(), verify: 0, verify_ok: 0, settle: 0, settle_ok: 0, ips: {}, settled: [], pay_to: {}, pay_to_since: null };
// The settlement list is the public record of every block this facilitator settled, and it is what /stats, the payTo rows and
// a seller's own check read. It was written in place, so a crash mid-write left truncated JSON and this catch answered the
// defaults: the whole settled history silently became empty, with no line saying so (llmrt, item 5, 2026-10-20).
const statsStore = readJsonStore(STATS_FILE);
if (statsStore.damaged) console.error('facilitator: ' + STATS_FILE + ' is damaged (' + statsStore.error + ')' + (statsStore.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on'));
if (statsStore.value && typeof statsStore.value === 'object') stats = { ...stats, ...statsStore.value };
if (!stats.pay_to) stats.pay_to = {};
if (!stats.pay_to_since) stats.pay_to_since = new Date().toISOString();   // per-payTo counters exist since 2026-09-22
function saveStats() { try { fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true }); writeJsonAtomic(STATS_FILE, stats); } catch {} }

// Map the descriptive reasons of x402.verify() to short codes a client can branch on.
// The text itself is returned as `invalidMessage` (verify) / `errorMessage` (settle), the names the x402 reference types and
// the SDK's facilitator client parse (typescript/packages/core/src/types/facilitator.ts, httpFacilitatorClient.ts; upstream
// #1030), and as `detail` until 0.3.0 for callers that read that name. Codes are the contract; the text is free and may change.
const CODES = [
  [/awaiting confirmation/i, 'block_awaiting_confirmation'],   // a block the chain holds, matching payTo and amount, not yet confirmed (x402#3432 check 10, 2026-10-16)
  [/already|already used|block_already/i, 'block_already_exists'],
  [/not the account frontier/i, 'frontier_moved'],
  [/not confirmed yet/i, 'frontier_unconfirmed'],
  [/not opened|no frontier/i, 'account_not_found'],
  [/sends .* raw|does not send anything|bad balance/i, 'amount_mismatch'],
  [/signature/i, 'invalid_signature'],
  [/\bwork\b/i, 'invalid_work'], // word-bounded: 'network must be nano:mainnet' coded invalid_work until 2026-10-01 (found generating spec test vectors)
  [/link|payTo/i, 'invalid_payto'],
  [/x402Version/i, 'unsupported_x402_version'],
  [/scheme|network|asset|amount must be/i, 'requirements_mismatch'],
  [/schema|state block|nano_ address|hex characters/i, 'invalid_block'],
  [/node rpc|account_info failed/i, 'node_unavailable'],
];
function codeFor(reason) { for (const [re, c] of CODES) if (re.test(reason)) return c; return 'invalid_payment'; }

const up = s => String(s || '').toUpperCase();
const nanoPrefix = a => String(a || '').replace(/^xrb_/, 'nano_');

// Blocks this facilitator broadcast, hash -> { payer, payTo, amount, at, answered, answeredAt }, kept 24 h (pruned on
// insert). A resource server that got confirmation_timeout, or lost the reply, retries /settle with the same block; by then
// the block is on the chain, so check 9 answered block_already_exists and the seller could never learn that the payment went
// through (uknwplayer, item 5, 2026-09-29). A retry whose payTo and amount equal the stored ones is answered from the chain
// instead, no second process, straight to the confirmation poll, until this facilitator has answered success for the block
// once (answered). After that a further /settle is a replay and is refused as before, so a seller that serves on success
// without its own per-hash check is not served twice; the refusal then carries the hash and the settle time, so a seller
// whose success reply was lost still learns that the payment went through. A block this facilitator did not broadcast
// answers block_already_exists with no hash: only its own broadcasts are known to have paid these requirements.
const BROADCAST_TTL_MS = 24 * 3600 * 1000;
const broadcast = new Map();
// On disk since 2026-09-30: the memory lived only in the process, so a restart between the block landing and the success
// reply turned the payer's retry into a refused replay with no hash (Jay44333 / Ops Control HQ, api#80, 2026-09-28).
// Written whole (temp file, then rename) on every remember and every answered mark, reloaded on start, entries past the TTL dropped.
const BROADCAST_FILE = process.env.BROADCAST_FILE || path.join(__dirname, 'data', 'broadcast.json');
function loadBroadcast(file = BROADCAST_FILE) {
  broadcast.clear();
  // A damaged broadcast file must not read as "nothing was ever broadcast": every block in it was paid, and losing the
  // entries turns a payer's retry after a lost success reply into a refused replay with no hash. Read it through the same
  // store as the other money files, so the .bak is used and the damage is reported (llmrt, item 5, 2026-10-20).
  const r = readJsonStore(file);
  if (r.damaged) console.error('facilitator: ' + file + ' is damaged (' + r.error + ')' + (r.recovered ? '; recovered the last complete copy from .bak' : '; no complete copy to fall back on'));
  const stored = r.value && typeof r.value === 'object' ? r.value : {};
  const now = Date.now();
  for (const [h, b] of Object.entries(stored)) if (b && typeof b === 'object' && now - b.at <= BROADCAST_TTL_MS) broadcast.set(h, b);
  return broadcast.size;
}
function saveBroadcast(file = BROADCAST_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // temp + fsync + .bak + rename, the same path credits.json takes: a rename without the fsync can leave a zero-length
    // file after a power loss on some filesystems, and this file is the record that a paid block was this facilitator's.
    writeJsonAtomic(file, Object.fromEntries(broadcast));
  } catch (e) { console.error('facilitator: broadcast memory not saved: ' + e.message); }
}
loadBroadcast();
function ownBroadcast(hash, req) { const b = broadcast.get(up(hash)); return b && b.payTo === req.payTo && b.amount === req.amount ? b : null; }
function rememberBroadcast(hash, payer, req) {
  const now = Date.now();
  for (const [h, b] of broadcast) if (now - b.at > BROADCAST_TTL_MS) broadcast.delete(h);
  broadcast.set(up(hash), { payer, payTo: req.payTo, amount: req.amount, at: now, answered: false, answeredAt: null });
  saveBroadcast();
}

// Requirements the resource server sent us: only what this facilitator can serve.
function checkRequirements(r) {
  if (!r || typeof r !== 'object') return 'paymentRequirements is required';
  if (r.scheme !== x402.SCHEME) return 'scheme must be ' + x402.SCHEME;
  if (r.network !== x402.NETWORK) return 'network must be ' + x402.NETWORK;
  if (String(r.asset || '').toUpperCase() !== x402.ASSET) return 'asset must be ' + x402.ASSET;
  if (!N.checkAddress(nanoPrefix(r.payTo))) return 'payTo is not a valid nano_ address';
  if (!/^[1-9]\d*$/.test(String(r.amount || ''))) return 'amount must be a positive integer string in raw';
  return null;
}

// deps: rpc(body) -> node JSON; workThreshold? (tests); sleep? (tests); settling? (Set shared with the seller path)

// Human-readable text beside the code, under the names the x402 reference types and SDK client parse: VerifyResponse.invalidMessage,
// SettleResponse.errorMessage (kilkelly, x402-nano-exact-scheme-proposal PR #1, 2026-10-15). `detail` carried the same text since
// 2026-09 and is kept as a duplicate until 0.3.0. The SDK's zod schemas strip unknown keys, so `detail` alone never reached SDK users.
function withMessage(r) {
  if (r && typeof r === 'object' && typeof r.detail === 'string') {
    if ('isValid' in r && r.invalidMessage === undefined) r.invalidMessage = r.detail;
    if ('success' in r && r.errorMessage === undefined) r.errorMessage = r.detail;
  }
  return r;
}

async function verifyRequest(body, deps) { return withMessage(await verifyRequestInner(body, deps)); }
async function verifyRequestInner(body, deps) {
  const { paymentPayload, paymentRequirements } = body || {};
  if (!paymentPayload) return { isValid: false, invalidReason: 'invalid_request', detail: 'paymentPayload is required', payer: '' };
  const bad = checkRequirements(paymentRequirements);
  if (bad) return { isValid: false, invalidReason: 'requirements_unsupported', detail: bad, payer: '' };
  const req = { ...paymentRequirements, payTo: nanoPrefix(paymentRequirements.payTo), asset: x402.ASSET, amount: String(paymentRequirements.amount) };
  const settling = deps.settling || new Set();
  const v = await x402.verify(paymentPayload, req, {
    accountInfo: account => deps.rpc({ action: 'account_info', account, representative: 'true', include_confirmed: 'true' }),
    workThreshold: deps.workThreshold,
    // check 9: the computed hash must not already be on the chain, nor in flight here; this facilitator's own broadcast
    // for the same payTo and amount passes until success has been answered for it once (a retry after
    // confirmation_timeout; /settle answers it from the chain), and is a replay after that
    seen: async h => {
      if (settling.has(h)) return true;
      const own = ownBroadcast(h, req);
      if (own) return !!own.answered;
      const b = await deps.rpc({ action: 'block_info', json_block: 'true', hash: h });
      if (!(b && !b.error && b.block_account)) return false;
      // Check 10 of the scheme document (kilkelly's draft of 2026-10-13, x402#3432): a block the chain already holds is
      // compared on subtype and amount before it is called a replay, so a confirmed 1-raw send presented at the full
      // price is amount_mismatch (transaction stays empty), not block_already_exists.
      if (b.subtype && b.subtype !== 'send') return 'the block on the chain does not send anything (subtype ' + b.subtype + ')';
      if (b.amount !== undefined && String(b.amount) !== String(req.amount)) return 'the block on the chain sends ' + b.amount + ' raw; exactly ' + req.amount + ' raw required';
      // A matching block (send, this amount, this payTo: the link was checked before seen() ran) is a payment to these
      // requirements whoever broadcast it, so the chain's view is named: confirmed, or awaiting confirmation. settle fills
      // transaction with the hash for both (scheme document head 2c5607a2, 2026-10-16: Scenarios 2 and 3).
      return String(b.confirmed) === 'true' ? 'block already on the chain and confirmed' : 'block already on the chain, awaiting confirmation';
    },
    // A retried block is by now the payer's frontier: verify reads its amount and confirmation from the chain (alreadyLanded)
    blockInfo: h => deps.rpc({ action: 'block_info', json_block: 'true', hash: h }),
  });
  const timeout = Number(paymentRequirements.maxTimeoutSeconds) || 60;
  if (!v.ok) {
    // Own broadcast, on the node but not confirmed yet: verify refuses a resend until confirmation, but that is what the
    // /settle poll waits for, so it is passed on with its hash and no block to process.
    let own = null;
    try { const h = up(x402.blockHash(paymentPayload.payload.block)); const b = /on the node but not confirmed/.test(v.reason) && ownBroadcast(h, req); if (b && !b.answered) own = { isValid: true, payer: b.payer, _hash: h, _block: null, _timeout: timeout }; } catch { /* verify said what is wrong */ }
    if (own) return own;
    return { isValid: false, invalidReason: codeFor(v.reason), detail: v.reason, payer: v.payer || '' };
  }
  return { isValid: true, payer: v.payer, _hash: v.hash, _block: v.block, _timeout: timeout };
}

// Verify, reservation and settle run under the block's hash lock, keyed before verify and shared with chargeX402 in
// server.js (hashlock.js). Before this, `settling` was entered only after verify's node reads returned, so two concurrent
// /settle calls carrying the same block both passed seen() and both broadcast, and a /settle racing the seller path for
// one block was not excluded at all. Serialised, the second call runs after the first and its seen() finds the block on
// the chain (block_already_exists) or still reserved. A block that does not hash runs unlocked so verify names the fault.
async function settleRequest(body, deps) {
  let key = null;
  try { key = x402.blockHash(body.paymentPayload.payload.block).toUpperCase(); } catch { /* verify reports what is wrong */ }
  const run = () => settleLocked(body, deps);
  return withMessage(await (key ? withHashLock(key, run) : run()));
}
async function settleLocked(body, deps) {
  const v = await verifyRequest(body, deps);
  const network = x402.NETWORK;
  const req = { payTo: nanoPrefix(body.paymentRequirements.payTo), amount: String(body.paymentRequirements.amount) };
  if (!v.isValid) {
    // A replay of a block this facilitator settled and answered success for: refused as before, but the reply names the
    // hash and when it was settled, so a seller whose success reply was lost can learn that the payment went through
    // without being handed a second success to serve on.
    let done = null;
    if (v.invalidReason === 'block_already_exists') {
      try { const h = up(x402.blockHash(body.paymentPayload.payload.block)); const b = ownBroadcast(h, req); if (b && b.answered) done = { hash: h, at: b.answeredAt }; } catch { /* verify said what is wrong */ }
    }
    if (done) return { success: false, errorReason: 'block_already_exists', detail: 'block ' + done.hash + ' was settled through this facilitator for the same payTo and amount and answered success at ' + done.at + '; a second success is not given for the same block', transaction: done.hash, network, payer: v.payer };
    // A block the chain already holds that sends exactly this amount to this payTo, broadcast by someone else (the payer's
    // own node, another facilitator): the hash is filled so the seller can tell a paid replay from a bad block and apply its
    // own served record (Scenario 2 of the scheme document, head 2c5607a2), and block_awaiting_confirmation with the hash
    // while it is unconfirmed (Scenario 3: do not serve yet, resettle). Until 2026-10-16 both answered block_already_exists
    // with transaction "", on the ground that only own broadcasts were known to have paid; the subtype, amount and link
    // checks in seen() now establish that from the chain.
    if (/already on the chain/.test(v.detail || '')) {
      try { const h = up(x402.blockHash(body.paymentPayload.payload.block)); return { success: false, errorReason: v.invalidReason, detail: v.detail + ' (hash ' + h + ', not broadcast through this facilitator)', transaction: h, network, payer: v.payer }; } catch { /* verify said what is wrong */ }
    }
    return { success: false, errorReason: v.invalidReason, detail: v.detail, transaction: '', network, payer: v.payer };
  }
  const settling = deps.settling || new Set();
  settling.add(v._hash);
  try {
    const blockInfo = h => deps.rpc({ action: 'block_info', json_block: 'true', hash: h });
    let s;
    const own = ownBroadcast(v._hash, req);
    // A block this facilitator broadcast within 24 h for the same payTo and amount, and the node holds it: no second
    // process; the answer is the confirmation poll below (uknwplayer, item 5, 2026-09-29). Remembered but not on the node
    // (verify then saw the payer's frontier unmoved, so the earlier process did not take), it is processed like a new block.
    let onNode = false;
    if (own) {
      if (v._block === null) onNode = true;   // verify saw it on the node, unconfirmed
      else { try { const b = await blockInfo(v._hash); onNode = !!(b && !b.error && b.contents); } catch { onNode = false; } }
    }
    if (onNode) s = { success: true, transaction: up(v._hash), payer: v.payer };
    else {
      // A process reply lost after the node accepted the block (deps.landed, as the seller path in server.js does): the
      // outcome is read from the node's view of the hash, not reported as a failed payment. true: on the node; false: not
      // found; null: cannot tell (Enrico / Practical Automation Lab, item 5, 2026-09-29).
      s = await x402.settle(v._block, v.payer, { hash: v._hash, process: block => deps.rpc({ action: 'process', json_block: 'true', subtype: 'send', block }),
        landed: async h => { try { const b = await blockInfo(h); if (b && b.error) return /not found/i.test(b.error) ? false : null; return b && b.contents ? true : null; } catch { return null; } } });
      if (!s.success) return { success: false, errorReason: codeFor(s.errorReason) === 'invalid_payment' ? 'process_failed' : codeFor(s.errorReason), detail: s.errorReason, transaction: '', network, payer: v.payer };
      rememberBroadcast(s.transaction, v.payer, req);
    }
    // Confirmed step: half a second, then one-second polls up to maxTimeoutSeconds (capped).
    const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    const deadline = Date.now() + Math.min(v._timeout, MAX_POLL_S) * 1000;
    let confirmed = false, polls = 0;
    await sleep(500);
    for (;;) {
      polls++;
      try { const b = await blockInfo(s.transaction); if (b && b.confirmed === 'true') { confirmed = true; break; } } catch {}
      if (Date.now() >= deadline) break;
      await sleep(1000);
    }
    if (!confirmed) return { success: false, errorReason: 'confirmation_timeout', detail: 'block ' + s.transaction + ' was processed but not confirmed within the timeout; it may still confirm: retry the same /settle (answered from the chain by this facilitator for 24 hours) or check block_info', transaction: s.transaction, network, payer: v.payer };
    const b = broadcast.get(up(s.transaction)); if (b) { b.answered = true; b.answeredAt = new Date().toISOString(); saveBroadcast(); }
    return { success: true, transaction: s.transaction, network, payer: v.payer, _polls: polls, _retry: onNode };
  } finally { settling.delete(v._hash); }
}

const SUPPORTED = { kinds: [{ x402Version: x402.X402_VERSION, scheme: x402.SCHEME, network: x402.NETWORK, extra: { asset: x402.ASSET, work: 'required', workThreshold: x402.WORK_THRESHOLD } }], extensions: [], signers: {} };

// --- HTTP ---------------------------------------------------------------------

const hits = new Map();
function overLimit(req, kind) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), key = kind + ':' + ip;
  const arr = (hits.get(key) || []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > LIMITS[kind];
}
function countIp(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
  stats.ips[key] = (stats.ips[key] || 0) + 1;
}
// Per-payTo counters, so a resource server that points its clients here is visible even
// before a settlement succeeds. Keyed by the requirements' payTo; anything that is not a
// Nano address is dropped, and the map stops growing at 500 keys.
const ADDR_RE = /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
function countPayTo(payTo, kind, ok) {
  if (!ADDR_RE.test(payTo)) return;
  const m = stats.pay_to;
  if (!m[payTo] && Object.keys(m).length >= 500) return;
  const now = new Date().toISOString();
  const e = m[payTo] || (m[payTo] = { verify: 0, verify_ok: 0, settle: 0, settle_ok: 0, first: now, last: now });
  e[kind]++; if (ok) e[kind + '_ok']++; e.last = now;
}
// The public view of the counters (GET /stats and pursekeeper.dev/facilitator): totals,
// one row per payTo address, the last settlements. Pure over a stats object so it can be
// tested. Client IPs are only ever stored as truncated hashes and only their count leaves.
function rollup(s) {
  const settled = s.settled || [], counters = s.pay_to || {}, rows = new Map();
  for (const e of settled) {
    const r = rows.get(e.pay_to) || { pay_to: e.pay_to, settled: 0, amount_raw: 0n, payers: new Set(), first: e.at, last: e.at };
    r.settled++; r.amount_raw += BigInt(e.amount_raw || 0); r.payers.add(e.payer);
    if (e.at < r.first) r.first = e.at; if (e.at > r.last) r.last = e.at;
    rows.set(e.pay_to, r);
  }
  for (const [a, c] of Object.entries(counters)) if (!rows.has(a)) rows.set(a, { pay_to: a, settled: 0, amount_raw: 0n, payers: new Set(), first: c.first, last: c.last });
  const sellers = [...rows.values()].map(r => { const c = counters[r.pay_to] || {}; return {
    pay_to: r.pay_to, settled: r.settled, amount_raw: r.amount_raw.toString(), payers: r.payers.size, payer_list: [...r.payers],
    verify: c.verify || 0, verify_ok: c.verify_ok || 0, settle: c.settle || 0, settle_ok: c.settle_ok || 0, first: r.first, last: r.last }; })
    .sort((a, b) => b.settled - a.settled || String(b.last || '').localeCompare(String(a.last || '')));
  const byPayer = new Map();
  for (const e of settled) { const r = byPayer.get(e.payer) || { payer: e.payer, settled: 0, amount_raw: 0n }; r.settled++; r.amount_raw += BigInt(e.amount_raw || 0); byPayer.set(e.payer, r); }
  const payers = [...byPayer.values()].map(r => ({ ...r, amount_raw: r.amount_raw.toString() })).sort((a, b) => b.settled - a.settled);
  const total = settled.reduce((a, e) => a + BigInt(e.amount_raw || 0), 0n);
  return { since: s.since, verify: s.verify || 0, verify_ok: s.verify_ok || 0, settle: s.settle || 0, settle_ok: s.settle_ok || 0,
    distinct_ips: Object.keys(s.ips || {}).length, settled_count: settled.length, settled_amount_raw: total.toString(),
    distinct_pay_to: sellers.length, distinct_pay_to_settled: sellers.filter(x => x.settled > 0).length,
    distinct_payers: payers.length, pay_to_counters_since: s.pay_to_since || null,
    sellers, payers, settled_last_20: settled.slice(-20) };
}
function publicStats() { return rollup(stats); }
// The payTo of a settlement this facilitator made, by block hash; lets the site name a payTo from a seller
// listing's verified block instead of a hand-kept file (uknwplayer's item 5 report, 2026-09-27).
function settledPayTo(hash) { const h = String(hash || '').toUpperCase(); const e = (stats.settled || []).find(x => String(x.hash || '').toUpperCase() === h); return e ? e.pay_to : null; }

// Over the limit: reject at once (the caller answers 400 with Connection: close) and keep draining
// the rest of the request so the answer can be written; only a body ten times over the limit
// gets the socket destroyed. Destroying it at the limit (until 2026-09-11) meant the 400 never
// left the box: the client saw a dropped connection or, through the proxy, a 502 (pyfile-toolkit).
function readBody(req, limit = 32_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on('data', c => {
      n += c.length;
      if (over) { if (n > limit * 10) req.destroy(); return; }
      if (n > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error('body too large: over ' + limit.toLocaleString('en-US') + ' bytes'), { tooLarge: true })); } else chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', e => { if (!over) reject(e); });
  });
}

// Returns true when the request was for the facilitator (whichever host) and was answered.
async function handle(req, res, u, send, deps) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().split(':')[0];
  let p;
  if (host === HOST) p = u.pathname;
  else if (u.pathname === PREFIX || u.pathname.startsWith(PREFIX + '/')) p = u.pathname.slice(PREFIX.length) || '/';
  else return false;
  if (p === '/' || p === '') return send(res, 200, DOCS, 'text/plain'), true;
  if (p === '/supported') return send(res, 200, SUPPORTED), true;
  if (p === '/stats') return send(res, 200, publicStats()), true;
  if (p === '/verify' || p === '/settle') {
    const kind = p.slice(1);
    if (req.method !== 'POST') return send(res, 405, { error: 'POST a JSON body {x402Version, paymentPayload, paymentRequirements}' }), true;
    if (overLimit(req, kind)) return send(res, 429, { error: LIMITS[kind] + ' ' + kind + ' calls per minute per IP' }), true;
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch (e) { if (e.tooLarge) res.setHeader('Connection', 'close'); return send(res, 400, { error: e.tooLarge ? e.message : 'body must be JSON: ' + e.message }), true; }
    if (!body.paymentPayload || !body.paymentRequirements) return send(res, 400, { error: 'paymentPayload and paymentRequirements are required' }), true;
    countIp(req); stats[kind]++;
    const strip = o => { const r = {}; for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = o[k]; return r; };
    if (kind === 'verify') {
      const r = await verifyRequest(body, deps);
      if (r.isValid) stats.verify_ok++;
      countPayTo(nanoPrefix(body.paymentRequirements.payTo), 'verify', !!r.isValid);
      saveStats();
      return send(res, 200, strip(r)), true;
    }
    const r = await settleRequest(body, deps);
    // A retry answered from the chain is the same settlement, not a second one: counted and listed once.
    const fresh = !!r.success && !stats.settled.some(e => up(e.hash) === up(r.transaction));
    countPayTo(nanoPrefix(body.paymentRequirements.payTo), 'settle', fresh);
    if (fresh) {
      stats.settle_ok++;
      stats.settled.push({ hash: r.transaction, payer: r.payer, pay_to: nanoPrefix(body.paymentRequirements.payTo), amount_raw: String(body.paymentRequirements.amount), at: new Date().toISOString(), polls: r._polls });
      if (stats.settled.length > 5000) stats.settled = stats.settled.slice(-5000);
    }
    saveStats();
    return send(res, 200, strip(r)), true;
  }
  return send(res, 404, { error: 'no such endpoint', docs: 'https://' + HOST + '/' }), true;
}

const DOCS = `facilitator.pursekeeper.dev: a public x402 facilitator for scheme "exact" on nano:mainnet
=====================================================================================

Run by pursekeeper, an autonomous agent (https://pursekeeper.dev), on its own synced Nano
node. No account, no API key, no fee. Every block it broadcasts pays the resource server's
own payTo; the facilitator holds nothing. Source: https://github.com/pursekeeper/api
(facilitator.js). Everything settled here is listed at /stats.

Endpoints (the x402 facilitator HTTP API; @x402/core and the x402 Python package speak it)

  GET  /supported
       -> {"kinds":[{"x402Version":2,"scheme":"exact","network":"nano:mainnet",
            "extra":{"asset":"XNO","work":"required","workThreshold":"fffffff800000000"}}],
           "extensions":[],"signers":{}}

  POST /verify   body {"x402Version":2,"paymentPayload":{...},"paymentRequirements":{...}}
       -> {"isValid":true,"payer":"nano_..."}
       -> {"isValid":false,"invalidReason":"<code>","invalidMessage":"<why>","detail":"<why>","payer":"nano_..."}

  POST /settle   same body
       -> {"success":true,"transaction":"<block hash>","network":"nano:mainnet","payer":"nano_..."}
       -> {"success":false,"errorReason":"<code>","errorMessage":"<why>","detail":"<why>","transaction":"","network":"nano:mainnet","payer":"..."}
          transaction is "" on every failure except confirmation_timeout, where it is the hash of the block that
          was processed but not confirmed within the poll budget (retry the same /settle: it is answered from the
          chain for 24 hours, success once confirmed; or check block_info), block_already_exists for a block the
          chain already holds that sends exactly the required amount to payTo (the hash; errorMessage names the
          settle time when this facilitator settled it, else says it was not broadcast here), and
          block_awaiting_confirmation for such a block that is on the chain but not yet confirmed (the hash;
          resettle until it is block_already_exists, do not serve before)

  GET  /stats    counters, one row per payTo address, the last settled blocks (human page: https://pursekeeper.dev/facilitator)

paymentRequirements must be {"scheme":"exact","network":"nano:mainnet","asset":"XNO",
"payTo":"nano_...","amount":"<raw, integer string>","maxTimeoutSeconds":60}. The
paymentPayload is the x402 v2 PaymentPayload with payload.block = the payer's signed send
state block (work included), as in the scheme text below.

What /verify checks. The first failing check names the code; the list is the order the
implementation runs them (the nine checks of the scheme proposal x402-foundation/x402#3432,
specs/schemes/exact/scheme_exact_nano.md, plus two). Anything that stops before a block is
parsed answers with payer "".

  0. paymentRequirements are ones this facilitator serves:
     scheme exact, network nano:mainnet, asset XNO,
     a valid nano_ payTo, amount a positive raw integer      requirements_unsupported
  1. paymentPayload.x402Version is 2 (checked before the
     schema, so a v1 envelope gets this code)               unsupported_x402_version
  2. paymentPayload matches the x402 v2 PaymentPayload
     schema                                                  invalid_block
  3. accepted.{scheme,network,amount,asset} equal the
     requirements you sent                                   requirements_mismatch
     accepted.payTo equals requirements.payTo                invalid_payto
  4. payload.block is a Nano state block                     invalid_block
     block.work is present and 16 hex characters; a missing,
     "0" or all-zero work field fails here, before the
     account is looked up (pyfile-toolkit's suite, 2026-09-11) invalid_work
  5. block.link is the public key of payTo                   invalid_payto
  6. signature verifies against the block hash               invalid_signature
  7. the block hash has not been presented before, unless
     this facilitator broadcast it in the last 24 h for the
     same payTo and amount and has not yet answered success
     for it (a /settle retry; see below). A block the chain
     already holds is compared on subtype and amount first:
     one that sends another amount than required is refused
     as amount_mismatch, not as a replay (check 10 of the
     scheme document, 2026-10-14); one that matches is named
     confirmed or awaiting confirmation (since 2026-10-16)      block_already_exists / block_awaiting_confirmation / amount_mismatch
  8. block.previous is the payer's confirmed frontier        frontier_moved / frontier_unconfirmed / account_not_found
  9. account balance - block.balance == amount, exactly      amount_mismatch
 10. work is above the send threshold fffffff800000000 over
     previous (presence and format were checked at 4)        invalid_work
 11. the block hash is not on the chain already              block_already_exists / block_awaiting_confirmation
  node unreachable                                           node_unavailable

Envelope errors, outside the isValid/invalidReason shape:
  405 {"error":...}   anything but POST on /verify or /settle
  400 {"error":...}   body is not JSON, is over 32,000 bytes ("body too large", connection then closed), or lacks paymentPayload or paymentRequirements
  429 {"error":...}   over the per-IP limit below

/settle runs the same checks, broadcasts the block (process, subtype send), waits 0.5 s and
polls block_info once a second until confirmed == "true" or the poll budget runs out.
maxTimeoutSeconds (default 60, capped at ${MAX_POLL_S}) is that budget, best effort, counted from
the moment process returns; it is not an HTTP deadline. A poll may start up to a second
after the budget ends and is allowed to finish, and a confirmation seen on it is answered
success, so the response can arrive about 1.5 s plus one node round trip after the budget,
on top of the time process itself took. Set the HTTP timeout above that. A
processed-but-unconfirmed block answers confirmation_timeout with the hash. A retry of the
same block through this facilitator after confirmation_timeout (or after a lost reply) is
answered from the chain for 24 hours: no second broadcast, the confirmation poll runs again,
success once the block is confirmed, confirmation_timeout until then. Once this facilitator
has answered success for a block, a further /settle of it is a replay: block_already_exists as
before, with transaction set to the hash and errorMessage naming when it was settled, so a seller
whose success reply was lost still learns that the payment went through, and a seller that
serves on success alone is not served twice. A block this facilitator did not broadcast but the
chain holds, sending exactly the required amount to payTo, answers block_already_exists with the
hash once confirmed and block_awaiting_confirmation with the hash before that (since 2026-10-16;
until then both were block_already_exists with transaction ""): a seller keeps its own record of
hashes served and serves once per hash (Scenarios 2 and 3 of the scheme document). When process itself fails
or its reply is lost, the node's view of the hash decides: a block that landed is settled and
polled as above; one that did not is reported with whether a rebuilt payment is safe.

Clients: on frontier_moved, refetch account_info, re-sign with the new previous and
balance, and re-present. A signed send block has no expiry; to withdraw an unsettled one,
publish any block on your own account.

Limits: ${LIMITS.verify} /verify and ${LIMITS.settle} /settle calls per minute per IP, 32,000-byte bodies. No
uptime promise beyond "an agent restarts it when it notices". If you rely on it, say so at
agent@pursekeeper.dev or on github.com/pursekeeper/api and it gets a review date.

Scheme text: https://github.com/x402-foundation/x402/pull/3432
Reference client/server code for the same block shape: https://github.com/x402nano
A seller recipe with no node at all: https://pursekeeper.dev/examples/no-node.md
`;

module.exports = { handle, verifyRequest, settleRequest, checkRequirements, codeFor, rollup, publicStats, settledPayTo, broadcast, loadBroadcast, saveBroadcast, BROADCAST_FILE, SUPPORTED, HOST, PREFIX, LIMITS, MAX_POLL_S, BROADCAST_TTL_MS };
