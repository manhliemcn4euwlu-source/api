// node --test  (run from api/). chargeX402 with a mocked node and no data writes. Two concurrent requests carrying the
// same PAYMENT-SIGNATURE for a block that is already the payer's frontier (a resend after a lost settle reply) must
// yield one served call and one "already used" refusal: before the per-hash lock both passed verify's seen() check
// (the alreadyLanded branch never entered `settling`, the normal branch only after verify returned), and the second
// one's "Old block" rejection became a settled success through the landed() fallback (Ops Control HQ, 2026-09-28
// 22:34 UTC; llmrt, 2026-09-29 00:17 UTC). There is no server-level harness in test/: the handler is exported and
// driven with fake req/res objects, global fetch is a node that knows one account, and every write under data/ is
// dropped so the live credits, x402 log, payers and checks files are untouched.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader, decodePaymentResponseHeader } = require('@x402/core/http');

process.env.NANO_RPC = 'http://node.test/rpc';
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'charge-x402-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { chargeX402, send } = require('../server');
const x402 = require('../x402');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const AMOUNT = 10n ** 27n;                                                              // PRICE_RAW in server.js
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const BALANCE = 5n * 10n ** 27n;

let payer, block, hash, header, headerOtherSession, headerNoSession;
const calls = [];
before(async () => {
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  block = N.createBlock(sk, { work: '0', previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO }).block;
  block.account = block.account.replace(/^xrb_/, 'nano_');
  hash = x402.blockHash(block);
  // The payload echoes the 402's extra.session (a v2 client copies the accepted entry); the replay cache is bound to it
  // (PlatinumVera, 2026-10-03). The two other headers wrap the same public block with another session and with none.
  header = encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...REQ, extra: { ...REQ.extra, session: 'a'.repeat(32) } }, payload: { block } });
  headerOtherSession = encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...REQ, extra: { ...REQ.extra, session: 'b'.repeat(32) } }, payload: { block } });
  headerNoSession = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } });
  // The node: the block is already the payer's confirmed frontier, so verify takes the alreadyLanded branch and process
  // must never be called; anything else the handler asks for is an error.
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); calls.push(b.action);
    let answer;
    if (b.action === 'account_info') answer = { frontier: hash, confirmed_frontier: hash, balance: (BALANCE - AMOUNT).toString(), representative: payer, block_count: '2' };
    else if (b.action === 'block_info') answer = b.hash === hash ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: block } : { error: 'Block not found' };
    else answer = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => answer };
  };
});
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

const request = () => ({ method: 'GET', url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

test('two concurrent charges with the same landed payment: one served, one refused as already used, nothing broadcast', async () => {
  const r1 = response(), r2 = response();
  const [ok1, ok2] = await Promise.all([chargeX402(request(), r1, header), chargeX402(request(), r2, header)]);
  assert.deepEqual([ok1, ok2].filter(Boolean).length, 1, JSON.stringify([ok1, ok2, r1.body, r2.body]));
  const served = ok1 ? r1 : r2, refused = ok1 ? r2 : r1;
  assert.equal(served.getHeader('x-nano-payment-hash'), hash);
  assert.equal(decodePaymentResponseHeader(served.getHeader(x402.RESPONSE_HEADER)).transaction, hash);
  assert.equal(refused.status, 402);
  assert.match(refused.body.error, /already used/);
  assert.equal(calls.includes('process'), false, 'a block that already landed is never broadcast again');
  // A later presentation of the same block for the same call is a replay: the reply the block bought, marked as such, no
  // second charge (uknwplayer, 2026-09-29; since 2026-09-30). For another call it is refused as already used.
  send(served, 200, { echo: 'hi' });   // the route's reply, as the handler would send it after the charge
  const r3 = response();
  assert.equal(await chargeX402(request(), r3, header), false);
  assert.equal(r3.status, 200, JSON.stringify(r3.body)); assert.deepEqual(r3.body, { echo: 'hi' });
  assert.equal(r3.getHeader('x-nano-replay'), 'true'); assert.equal(r3.getHeader('x-nano-payment-hash'), hash);
  assert.equal(decodePaymentResponseHeader(r3.getHeader(x402.RESPONSE_HEADER)).transaction, hash);
  const r4 = response();
  assert.equal(await chargeX402({ ...request(), url: '/v1/echo?msg=other' }, r4, header), false);
  assert.equal(r4.status, 402); assert.match(r4.body.error, /already used/);
  // The block is public: the payment echoed a session, so the same call with the same block wrapped by someone who does not
  // hold it (another session, or none) is not replayed but refused as already used, and the refusal says what a replay
  // needs (PlatinumVera, 2026-10-03). Only a payment that echoed no session falls back to the key alone (next test).
  for (const h of [headerOtherSession, headerNoSession]) {
    const r5 = response();
    assert.equal(await chargeX402({ ...request(), headers: { host: 'pursekeeper.dev', 'payment-signature': h } }, r5, h), false);
    assert.equal(r5.status, 402, JSON.stringify(r5.body)); assert.match(r5.body.error, /already used/); assert.match(r5.body.error, /extra\.session/);
    assert.equal(r5.getHeader('x-nano-replay'), undefined);
  }
});

test('a payment whose payload echoed no session is replayed on method, URL and body alone, to anyone, and refused for another call', async () => {
  // A fresh block from the same account at the same frontier: another representative, another hash, already landed.
  const sk2 = N.deriveSecretKey(await N.generateSeed(), 0);
  const payer2 = N.deriveAddress(N.derivePublicKey(sk2), { useNanoPrefix: true });
  const b2 = N.createBlock(sk2, { work: '0', previous: FRONTIER, representative: payer2, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO }).block;
  b2.account = b2.account.replace(/^xrb_/, 'nano_');
  const h2 = x402.blockHash(b2);
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.action === 'account_info' && b.account === payer2) return { ok: true, json: async () => ({ frontier: h2, confirmed_frontier: h2, balance: (BALANCE - AMOUNT).toString(), representative: payer2, block_count: '2' }) };
    if (b.action === 'block_info' && b.hash === h2) return { ok: true, json: async () => ({ block_account: payer2, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: b2 }) };
    return prev(url, opts);
  };
  try {
    const hdr = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: b2 } });
    const req = () => ({ method: 'GET', url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': hdr }, socket: { remoteAddress: '127.0.0.1' } });
    const r1 = response();
    assert.equal(await chargeX402(req(), r1, hdr), true, JSON.stringify(r1.body));
    send(r1, 200, { echo: 'hi' });
    // extra is optional in the x402 v2 schema and the verifier never reads it, so a conforming client can have nothing to
    // echo; until 2026-10-04 its lost reply was refused as already used while the front page promised the replay
    // (pyfile-toolkit, 2026-10-03). Now the key (method, URL, body) is the only binding, and anyone wrapping the public
    // block for the same call inside the ten minutes gets the reply: a stranger's payload echoing some session included.
    const r2 = response();
    assert.equal(await chargeX402(req(), r2, hdr), false);
    assert.equal(r2.status, 200, JSON.stringify(r2.body)); assert.deepEqual(r2.body, { echo: 'hi' });
    assert.equal(r2.getHeader('x-nano-replay'), 'true'); assert.equal(r2.getHeader('x-nano-payment-hash'), h2);
    const hdrSomeSession = encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...REQ, extra: { ...REQ.extra, session: 'c'.repeat(32) } }, payload: { block: b2 } });
    const r3 = response();
    assert.equal(await chargeX402({ ...req(), headers: { host: 'pursekeeper.dev', 'payment-signature': hdrSomeSession } }, r3, hdrSomeSession), false);
    assert.equal(r3.status, 200, JSON.stringify(r3.body)); assert.equal(r3.getHeader('x-nano-replay'), 'true');
    // Another call on the same block is not a lost reply: refused, and the refusal says what the replay covers.
    const r4 = response();
    assert.equal(await chargeX402({ ...req(), url: '/v1/echo?msg=other' }, r4, hdr), false);
    assert.equal(r4.status, 402, JSON.stringify(r4.body)); assert.match(r4.body.error, /already used/);
    assert.match(r4.body.error, /echoed no session is replayed on method, URL and body alone/);
    assert.equal(r4.getHeader('x-nano-replay'), undefined);
  } finally { globalThis.fetch = prev; }
});

test('a block that does not hash runs unlocked and is refused by verify with its reason', async () => {
  const r = response();
  const bad = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: { type: 'state' } } });
  assert.equal(await chargeX402(request(), r, bad), false);
  assert.equal(r.status, 402); assert.match(r.body.error, /x402: /);
});
