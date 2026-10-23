// node --test  (run from api/). /v1/fetch hands a call back when nothing was fetched. fetchText used to run checkFetchUrl
// a second time after the charge, and a transient DNS failure there threw an error carrying neither noAnswer nor unpaid,
// so the handler kept the payment and answered 400 with no hash to retry with (uknwplayer, 2026-09-29). Now the handler
// passes its pre-charge check result in, fetchText resolves nothing on the first hop, and any failure before the target
// is contacted carries the noAnswer flag the handler hands back on.
// Body phase (2026-09-29, trollhunters): the 15 s abort used to be cleared before r.text(), so a target that sent headers
// and then cut or stalled the body kept the price with no hash named. The body read now has its own bound and a cut or
// stalled body is handed back like a target that never answered.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dnsp = require('node:dns').promises;
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const N = require('nanocurrency');
const undici = require('undici');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
process.env.NANO_RPC = 'http://node.test/rpc';
// Every write under data/ is dropped (including writeJsonAtomic's openSync + renameSync): the live credits, x402 log,
// payers and checks files are untouched.
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'fetch-handback-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { fetchText, checkFetchUrl, server, credits, loadPurposes, X402_CONFIRM } = require('../server');
const x402 = require('../x402');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

test('a lookup failure inside fetchText is flagged for hand-back, and a pre-checked url is not looked up again', async () => {
  const real = dnsp.lookup; let lookups = 0;
  dnsp.lookup = async () => { lookups++; const e = new Error('getaddrinfo EAI_AGAIN example.com'); e.code = 'EAI_AGAIN'; throw e; };
  try {
    await assert.rejects(fetchText('http://example.com/'), e => e.noAnswer === true && /EAI_AGAIN/.test(e.message));
    assert.equal(lookups, 1);
    await assert.rejects(checkFetchUrl('http://example.com/'), /EAI_AGAIN/);   // the handler's pre-charge check: 400, nothing charged
    assert.equal(lookups, 2);
    // Pre-checked: the pins are used and dns.lookup is not consulted; a pin the connector refuses is still a hand-back.
    const checked = { u: new URL('http://pinned.invalid/'), addrs: [{ address: '192.0.2.1', family: 4 }] };
    await assert.rejects(fetchText('http://pinned.invalid/', checked), e => e.noAnswer === true);
    assert.equal(lookups, 2);
  } finally { dnsp.lookup = real; }
});

// A local target that misbehaves after its headers. fetchText refuses loopback pins, so target.test resolves to a public
// address for checkFetchUrl and undici.fetch is wrapped to carry the request to the local server with the same signal:
// the transport behaviour (a destroyed socket, an abort mid-body) is the real one.
const target = http.createServer((req, res) => {
  if (req.url === '/cut') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' }); res.write('0123456789'); setTimeout(() => res.destroy(), 20); return; }
  if (req.url === '/stall') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' }); res.write('01234'); return; }   // never finishes
  if (req.url === '/long') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(300)); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('whole body');
});
before(() => new Promise(r => target.listen(0, '127.0.0.1', r)));
after(() => { target.closeAllConnections(); target.close(); });
const PUBLIC = '93.184.216.34';
function viaLocal(fn) {
  return async () => {
    const realLookup = dnsp.lookup, realFetch = undici.fetch;
    dnsp.lookup = async (host, opts) => host === 'target.test' ? [{ address: PUBLIC, family: 4 }] : realLookup(host, opts);
    Object.defineProperty(undici, 'fetch', { value: (u, opts) => realFetch('http://127.0.0.1:' + target.address().port + new URL(u).pathname, { ...opts, dispatcher: undefined }), configurable: true, writable: true });
    try { await fn(); } finally { dnsp.lookup = realLookup; Object.defineProperty(undici, 'fetch', { value: realFetch, configurable: true, writable: true }); }
  };
}

test('a whole body still comes back through the wrapper', viaLocal(async () => {
  const r = await fetchText('http://target.test/ok');
  assert.equal(r.text, 'whole body'); assert.equal(r.status, 200);
}));

// A page past the seller's per-call character bound used to come back cut with no field saying so: a buyer paid for a page and
// read a prefix as the whole document (the /v1/receivable 100-hash class, llmrt, 2026-10-23). The answer now carries the cut.
test('a body past the character bound says it was cut and how much came back', viaLocal(async () => {
  const r = await fetchText('http://target.test/long', undefined, { headersMs: 5000, bodyMs: 5000, maxBytes: 1_000_000, maxChars: 100 });
  assert.equal(r.text.length, 100);
  assert.equal(r.truncated, true);
  assert.equal(r.text_chars, 100);
  assert.equal(r.chars_before_cut, 300);
  assert.match(r.next, /first 100 of 300/);
  // A page inside the bound is not marked, so `truncated: false` is a positive statement that text is the whole body.
  const ok = await fetchText('http://target.test/ok', undefined, { headersMs: 5000, bodyMs: 5000, maxBytes: 1_000_000, maxChars: 100 });
  assert.equal(ok.truncated, false);
  assert.equal(ok.text, 'whole body');
}));

test('a body cut after the headers (content-length 100, ten bytes, socket destroyed) is flagged for hand-back and named', viaLocal(async () => {
  await assert.rejects(fetchText('http://target.test/cut'), e => e.noAnswer === true && /^target stopped answering mid-body \(/.test(e.message));
}));

test('a body that stalls is handed back within the body bound', viaLocal(async () => {
  const t0 = Date.now();
  await assert.rejects(fetchText('http://target.test/stall', undefined, { headersMs: 5000, bodyMs: 200 }),
    e => e.noAnswer === true && /target stopped answering mid-body \(.*body not finished within 0\.2 s/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, 'bounded by bodyMs, not by the target');
}));

// The handler, paid over x402 (the bearer path needs the purpose registry, which tests do not load): the block is settled and
// confirmed, the target cuts the body, and the 502 hands the price back as credit on the block hash and names it.
const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const AMOUNT = 10n ** 27n;                                                              // PRICE_RAW in server.js
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';   // valid at the send threshold over FRONTIER (precomputed once; work depends on previous only)
const BALANCE = 5n * 10n ** 27n;
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

test('the /v1/fetch handler hands a mid-body cut back: credit restored on the x402 block hash and the 502 names it', viaLocal(async () => {
  assert.ok(N.validateWork({ blockHash: FRONTIER, work: WORK, threshold: x402.WORK_THRESHOLD }), 'precomputed work is valid');
  Object.assign(X402_CONFIRM, { intervalMs: 1, boundMs: 200 });
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  const payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const hash = x402.blockHash(block);
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } });
  const chain = new Map(); const calls = [];
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); calls.push(b.action); let a;
    if (b.action === 'account_info') a = { frontier: FRONTIER, confirmed_frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, block_count: '1' };
    else if (b.action === 'process') { chain.set(hash, b.block); a = { hash }; }
    else if (b.action === 'block_info') a = chain.has(b.hash) ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: chain.get(b.hash) } : { error: 'Block not found' };
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
  const req = { url: '/v1/fetch?url=http://target.test/cut', method: 'GET', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } };
  const res = response();
  await server.listeners('request')[0](req, res);
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.match(res.body.error, /target stopped answering mid-body/);
  assert.ok(res.body.note.includes(hash), res.body.note);
  assert.match(res.body.note, /handed back/);
  assert.equal(res.headers['x-nano-credit-remaining-raw'], AMOUNT.toString());
  assert.equal(credits[hash], AMOUNT.toString(), 'the price is back on the settled block hash');
  assert.equal(calls.filter(a => a === 'process').length, 1);

  // The handed-back 502 must not be cached in `served` as a replayable reply, and the x402 settlement already recorded
  // the payer account so retrying with X-Nano-Payment (as the 502 note instructs) spends the restored credit without
  // needing another block_info lookup.
  await loadPurposes();
  const blockInfoBefore = calls.filter(a => a === 'block_info').length;
  const retryEcho = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=after-handback', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': hash }, socket: { remoteAddress: '127.0.0.1' } }, retryEcho);
  assert.equal(retryEcho.status, 200, JSON.stringify(retryEcho.body));
  assert.equal(retryEcho.body.echo, 'after-handback');
  assert.equal(retryEcho.headers['x-nano-credit-remaining-raw'], '0');
  assert.equal(credits[hash], '0');
  assert.equal(calls.filter(a => a === 'block_info').length, blockInfoBefore, 'payer account was recorded at x402 settlement');

  // Re-presenting the failed /v1/fetch call (over x402 or bearer) is refused as spent, never replayed as a 502 with a stale credit header.
  const againX402 = response();
  await server.listeners('request')[0](req, againX402);
  assert.equal(againX402.status, 402, JSON.stringify(againX402.body));
  assert.equal(againX402.headers['x-nano-replay'], undefined);
  const againBearer = response();
  await server.listeners('request')[0]({ url: '/v1/fetch?url=http://target.test/cut', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': hash }, socket: { remoteAddress: '127.0.0.1' } }, againBearer);
  assert.equal(againBearer.status, 402, JSON.stringify(againBearer.body));
  assert.equal(againBearer.headers['x-nano-replay'], undefined);

  // Meanwhile the 200 reply the restored credit actually bought is replayed when re-presented.
  const replayEcho = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=after-handback', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': hash }, socket: { remoteAddress: '127.0.0.1' } }, replayEcho);
  assert.equal(replayEcho.status, 200, JSON.stringify(replayEcho.body));
  assert.equal(replayEcho.headers['x-nano-replay'], 'true');
}));

test('a handed-back /v1/fetch on a multi-call bearer hash does not overwrite an earlier 200 replay', viaLocal(async () => {
  await loadPurposes();
  const h2 = 'EF'.repeat(32);
  const payer2 = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.action === 'block_info' && b.hash === h2)
      return { ok: true, json: async () => ({ block_account: payer2, subtype: 'send', amount: (2n * AMOUNT).toString(), confirmed: 'true', height: '3', local_timestamp: '1758000000', contents: { link_as_account: PAY_TO } }) };
    if (b.action === 'account_history')
      return { ok: true, json: async () => ({ history: [{ hash: h2, type: 'send', account: PAY_TO, local_timestamp: '1758000000' }] }) };
    return { ok: true, json: async () => ({ error: 'unexpected rpc ' + b.action }) };
  };
  // Call 1: 200 on /v1/echo (1 call left).
  const r1 = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=first', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h2 }, socket: { remoteAddress: '127.0.0.1' } }, r1);
  assert.equal(r1.status, 200);
  // Call 2: 502 hand-back on /v1/fetch (still 1 call left; must not overwrite Call 1 in `served`).
  const r2 = response();
  await server.listeners('request')[0]({ url: '/v1/fetch?url=http://target.test/cut', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h2 }, socket: { remoteAddress: '127.0.0.1' } }, r2);
  assert.equal(r2.status, 502);
  assert.equal(credits[h2], AMOUNT.toString());
  // Spend the remaining credit on a second 502 hand-back and then drain it to 0 so replayIfServed is consulted.
  credits[h2] = '0';
  const r3 = response();
  await server.listeners('request')[0]({ url: '/v1/fetch?url=http://target.test/cut', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h2 }, socket: { remoteAddress: '127.0.0.1' } }, r3);
  assert.equal(r3.status, 402, 'handed-back 502 is not replayed when credit is exhausted');
  const r4 = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=first', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h2 }, socket: { remoteAddress: '127.0.0.1' } }, r4);
  assert.equal(r4.status, 200, 'earlier 200 reply on the hash is still replayed');
  assert.equal(r4.headers['x-nano-replay'], 'true');
  assert.equal(r4.body.echo, 'first');
}));

// llmrt, 2026-10-23: a handed-back call is counted as a paid call nowhere, but only calls_paid was rolled back. An x402
// payment that bought nothing (the target cut the body) still left calls_x402 raised, so /v1/stats answered
// calls_x402 > calls_paid: a counter of x402 calls served that outran the count of calls paid for. The hand-back now rolls
// back the rail it was charged on, so the two agree again.
const statsRail = async () => {
  Object.assign(X402_CONFIRM, { intervalMs: 1, boundMs: 200 });
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  const payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const hash = x402.blockHash(block);
  const chain = new Map();
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); let a;
    if (b.action === 'account_info') a = { frontier: FRONTIER, confirmed_frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, block_count: '1' };
    else if (b.action === 'process') { chain.set(hash, b.block); a = { hash }; }
    else if (b.action === 'block_info') a = chain.has(b.hash) ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: chain.get(b.hash) } : { error: 'Block not found' };
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
  return { hash, header: encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } }) };
};

test('a handed-back x402 call is not counted as an x402 call either: /v1/stats keeps calls_x402 within calls_paid', viaLocal(async () => {
  await loadPurposes();
  const { header } = await statsRail();   // its own RPC mock: an earlier test replaced globalThis.fetch
  const before = response();
  await server.listeners('request')[0]({ url: '/v1/stats', method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.1' } }, before);
  const paid0 = before.body.calls_paid, x4020 = before.body.calls_x402;
  const r = response();
  await server.listeners('request')[0]({ url: '/v1/fetch?url=http://target.test/cut', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } }, r);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.match(r.body.note, /handed back/);
  const after = response();
  await server.listeners('request')[0]({ url: '/v1/stats', method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.1' } }, after);
  assert.equal(after.body.calls_paid, paid0, 'nothing was paid for: the paid count is back where it started');
  assert.equal(after.body.calls_x402, x4020, 'nothing was served over x402: that count is back too');
  assert.ok(after.body.calls_x402 <= after.body.calls_paid, 'no more x402 calls than paid calls');
}));
