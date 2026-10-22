// node --test  (run from api/). chargeX402 waits for the node to confirm the broadcast block before serving (2026-09-29;
// uknwplayer; Ops Control HQ on the landed branch, 2026-09-28). Confirmed within the bound: served and marked spent.
// Not confirmed: 402 naming the hash, nothing marked spent, and the same payment re-presented once confirmed is served
// through verify's alreadyLanded branch. Mocked node, every write under data/ dropped.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');

process.env.NANO_RPC = 'http://node.test/rpc';
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'charge-x402-confirm-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { chargeX402, credits, X402_CONFIRM, creditFor, send } = require('../server');
const x402 = require('../x402');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const AMOUNT = 10n ** 27n;                                                              // PRICE_RAW in server.js
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';   // valid at the send threshold over FRONTIER (precomputed; work depends on previous only)
const BALANCE = 5n * 10n ** 27n;

// The node: one account at FRONTIER; process records a block; block_info answers confirmed per `confirm` (a function of the
// hash and how many times it was asked); after `moved`, account_info shows the block as the confirmed frontier.
let payer, sk;
const chain = new Map(), asked = new Map(), calls = [];
let confirm = () => 'false', moved = null;
before(async () => {
  Object.assign(X402_CONFIRM, { intervalMs: 1, boundMs: 100 });
  sk = N.deriveSecretKey(await N.generateSeed(), 0);
  payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); calls.push(b.action); let a;
    if (b.action === 'account_info') a = moved ? { frontier: moved, confirmed_frontier: moved, balance: (BALANCE - AMOUNT).toString(), representative: payer, block_count: '2' }
      : { frontier: FRONTIER, confirmed_frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, block_count: '1' };
    else if (b.action === 'process') { const h = x402.blockHash(b.block); chain.set(h, b.block); a = { hash: h }; }
    else if (b.action === 'block_info') { const n = (asked.get(b.hash) || 0) + 1; asked.set(b.hash, n);
      a = chain.has(b.hash) ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: confirm(b.hash, n), contents: chain.get(b.hash) } : { error: 'Block not found' }; }
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
});
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

function payment(representative) {
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  return { hash: x402.blockHash(block), header: encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } }) };
}
const request = header => ({ url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

test('process returns the hash, block_info confirms on the third poll -> served, marked spent', async () => {
  assert.ok(N.validateWork({ blockHash: FRONTIER, work: WORK, threshold: x402.WORK_THRESHOLD }), 'precomputed work is valid');
  const { hash, header } = payment(payer);
  confirm = (h, n) => (h === hash && n >= 3) ? 'true' : 'false';
  const res = response();
  assert.equal(await chargeX402(request(header), res, header), true, JSON.stringify(res.body));
  assert.equal(res.getHeader('x-nano-payment-hash'), hash);
  assert.equal(credits[hash], '0');
  assert.ok(asked.get(hash) >= 3, 'polled until confirmed');
});

test('never confirmed within the bound -> 402 naming the hash, not marked spent; the same payment re-presented once confirmed is served', async () => {
  const { hash, header } = payment(PAY_TO);   // another representative: another block, another hash
  confirm = () => 'false';
  const processesBefore = calls.filter(a => a === 'process').length;
  const res = response();
  assert.equal(await chargeX402(request(header), res, header), false);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  assert.ok(res.body.error.includes(hash), res.body.error);
  assert.match(res.body.note, /broadcast but not yet confirmed/);
  assert.ok(res.body.note.includes(hash), res.body.note);
  assert.match(res.body.note, /re-present the same payment/);
  assert.equal(credits[hash], undefined, 'nothing marked spent');
  assert.equal(calls.filter(a => a === 'process').length, processesBefore + 1);
  // The node now holds the block as the confirmed frontier: the unchanged payment, re-presented with the token from that
  // 402, is served, nothing broadcast again.
  moved = hash; confirm = h => h === hash ? 'true' : 'false';
  const q2 = request(header); q2.headers['x-nano-represent'] = res.getHeader('x-nano-represent');
  const res2 = response();
  assert.equal(await chargeX402(q2, res2, header), true, JSON.stringify(res2.body));
  assert.equal(res2.getHeader('x-nano-payment-hash'), hash);
  assert.equal(credits[hash], '0');
  assert.equal(calls.filter(a => a === 'process').length, processesBefore + 1, 'one broadcast in total');
});

test('re-presented with the token while the block is still unconfirmed -> 402 with the note and the same token, so the loop goes on; without the token -> 402 naming the wait and no token; confirmed later -> served once (PlatinumVera, 2026-10-03)', async () => {
  const rep = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(await N.generateSeed(), 0)), { useNanoPrefix: true });
  const { hash, header } = payment(rep);   // another representative: another block
  moved = null; confirm = () => 'false';
  const res = response();
  assert.equal(await chargeX402(request(header), res, header), false);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  const token = res.getHeader('x-nano-represent'); assert.ok(token);
  // The block is now on the node (the frontier moved) but still unconfirmed: verify takes the alreadyLanded gate. Until
  // 2026-10-03 this 402 carried neither note nor token and the client loop stopped on it.
  moved = hash;
  const q2 = request(header); q2.headers['x-nano-represent'] = token;
  const res2 = response();
  assert.equal(await chargeX402(q2, res2, header), false);
  assert.equal(res2.status, 402, JSON.stringify(res2.body));
  assert.match(res2.body.note, /broadcast but not yet confirmed/); assert.ok(res2.body.note.includes(hash));
  assert.equal(res2.body.represent_token, token); assert.equal(res2.getHeader('x-nano-represent'), token);
  assert.equal(credits[hash], undefined, 'nothing marked spent');
  // Without the token (anyone who read the block off the chain): the wait is named, the token is not.
  const res3 = response();
  assert.equal(await chargeX402(request(header), res3, header), false);
  assert.equal(res3.status, 402, JSON.stringify(res3.body));
  assert.match(res3.body.error, /waiting for its payer/); assert.equal(res3.body.represent_token, undefined); assert.equal(res3.getHeader('x-nano-represent'), undefined);
  // Confirmed: the same re-presentation with the token is served once.
  confirm = h => h === hash ? 'true' : 'false';
  const q4 = request(header); q4.headers['x-nano-represent'] = token;
  const res4 = response();
  assert.equal(await chargeX402(q4, res4, header), true, JSON.stringify(res4.body));
  assert.equal(res4.getHeader('x-nano-payment-hash'), hash); assert.equal(credits[hash], '0');
});

test('a broadcast block is public: re-presented from another address without the token -> refused, not marked spent; with the token -> served once', async () => {
  const { hash, header } = payment('nano_3arg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4');   // another representative: another block
  moved = null; confirm = () => 'false';   // the account is back at FRONTIER for this block
  const res = response();
  assert.equal(await chargeX402(request(header), res, header), false);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  const token = res.getHeader('x-nano-represent');
  assert.match(String(token), /^[0-9a-f]{32}$/);
  assert.equal(res.body.represent_token, token);
  assert.ok(res.body.note.includes('X-Nano-Represent: ' + token), res.body.note);
  assert.equal(credits[hash], undefined);
  moved = hash; confirm = h => h === hash ? 'true' : 'false';
  const stranger = () => { const q = request(header); q.socket = { remoteAddress: '203.0.113.9' }; return q; };
  const res2 = response();
  assert.equal(await chargeX402(stranger(), res2, header), false, JSON.stringify(res2.body));
  assert.equal(res2.status, 402);
  assert.match(res2.body.error, /waiting for its payer/);
  assert.equal(credits[hash], undefined, 'not marked spent by the stranger');
  const q3 = stranger(); q3.headers['x-nano-represent'] = token;
  const res3 = response();
  assert.equal(await chargeX402(q3, res3, header), true, JSON.stringify(res3.body));
  assert.equal(res3.getHeader('x-nano-payment-hash'), hash);
  assert.equal(credits[hash], '0');
  const res4 = response();
  assert.equal(await chargeX402(q3, res4, header), false);
  assert.match(res4.body.error, /already used/);
});

test('the token is the only binding: same client address without it -> 402; the bearer path refuses the hash while the record exists; served once with the token, then spent', async () => {
  const other = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(await N.generateSeed(), 0)), { useNanoPrefix: true });
  const { hash, header } = payment(other);   // another representative: another block
  moved = null; confirm = () => 'false';
  const res = response();
  assert.equal(await chargeX402(request(header), res, header), false);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  const token = res.getHeader('x-nano-represent');
  assert.match(String(token), /^[0-9a-f]{32}$/);
  moved = hash; confirm = h => h === hash ? 'true' : 'false';
  // Same client address as the broadcast request, no token: refused (an address is not a payer; Ops Control HQ, 2026-09-29 17:38 UTC).
  const res2 = response();
  assert.equal(await chargeX402(request(header), res2, header), false, JSON.stringify(res2.body));
  assert.equal(res2.status, 402);
  assert.match(res2.body.error, /waiting for its payer/);
  assert.equal(credits[hash], undefined, 'not marked spent');
  // The same block presented as X-Nano-Payment credit by anyone who read it off the chain: refused (pyfile-toolkit, 18:42 UTC).
  const bearer = await creditFor(hash);
  assert.match(String(bearer.error), /waiting for its payer/, JSON.stringify(bearer));
  assert.equal(credits[hash], undefined, 'the bearer attempt credited nothing');
  // The payer, with the token, from any address: served once; afterwards the hash is spent on both paths.
  const q3 = request(header); q3.socket = { remoteAddress: '198.51.100.7' }; q3.headers['x-nano-represent'] = token;
  const res3 = response();
  assert.equal(await chargeX402(q3, res3, header), true, JSON.stringify(res3.body));
  assert.equal(res3.getHeader('x-nano-payment-hash'), hash);
  assert.equal(credits[hash], '0');
  const spent = await creditFor(hash);   // the purpose registry is not loaded under test, so a refusal for that reason is fine; never credit
  assert.ok(!spent.remaining, JSON.stringify(spent));
  assert.equal(credits[hash], '0');
});

test('every reply lists X-Nano-Represent in both CORS lists, so a browser client can read the token from the 402 and send it back (pyfile-toolkit, 2026-09-29 16:50 UTC)', () => {
  const res = response();
  res.writeHead = function (s, h) { this.status = s; for (const [k, v] of Object.entries(h || {})) this.headers[k.toLowerCase()] = v; };
  res.end = function () {};
  send(res, 200, { ok: true }, 'application/json');
  assert.equal(res.status, 200);
  assert.match(String(res.getHeader('access-control-allow-headers')), /\bX-Nano-Represent\b/);
  assert.match(String(res.getHeader('access-control-expose-headers')), /\bX-Nano-Represent\b/);
});
