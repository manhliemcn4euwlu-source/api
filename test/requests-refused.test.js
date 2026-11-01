// node --test (run from api/). A PAYMENT-SIGNATURE that parses to a block and is refused with a 402 leaves a request-log
// line (kind x402, ok:false, refused: the reason) and /v1/requests finds it. Until 2026-11-01 only accepted presentations
// were logged: a valid block refused because its frontier was not yet confirmed, and never broadcast, was indistinguishable
// from a block never presented at all, and was ruled so (ccclosed, api#138, 2026-10-30). Mocked node; data/ writes dropped
// (guard-data); the request log is kept in memory.
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
process.env.NANO_RPC = 'http://node.test/rpc';
require('./guard-data');
const { chargeX402, X402_CONFIRM, REQ_LOG, server } = require('../server');
const x402 = require('../x402');

let reqLog = '';
const guardedAppend = fs.appendFileSync, realRead = fs.readFileSync;
fs.appendFileSync = (p, d, ...a) => { if (String(p) === REQ_LOG) { reqLog += d; return; } return guardedAppend(p, d, ...a); };
fs.readFileSync = (p, ...a) => { if (String(p) === REQ_LOG) { if (!reqLog) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return reqLog; } return realRead(p, ...a); };

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const AMOUNT = 10n ** 27n;
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';
const BALANCE = 5n * 10n ** 27n;
let sk, payer;
const chain = new Map();
before(async () => {
  Object.assign(X402_CONFIRM, { intervalMs: 1, boundMs: 100 });
  sk = N.deriveSecretKey(await N.generateSeed(), 0);
  payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); let a;
    if (b.action === 'account_info') a = { frontier: FRONTIER, confirmed_frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, block_count: '1' };
    else if (b.action === 'process') { const h = x402.blockHash(b.block); chain.set(h, b.block); a = { hash: h }; }
    else if (b.action === 'block_info') a = chain.has(b.hash) ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: chain.get(b.hash) } : { error: 'Block not found' };
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
});
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });
// A signed block that pays one raw too little: parses to a block, fails verify, is never broadcast.
function shortBlock() {
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT + 1n).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  return { block, hash: x402.blockHash(block), header: encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } }) };
}
const lines = () => reqLog.split('\n').filter(Boolean).map(l => JSON.parse(l));

test('a refused presentation is logged with ok:false and its reason, and /v1/requests finds it', async () => {
  const { hash, header } = shortBlock();
  const res = response();
  assert.equal(await chargeX402({ url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } }, res, header), false);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  assert.ok(!chain.has(hash), 'a refused block is not broadcast');
  const mine = lines().filter(e => e.hash === hash);
  assert.equal(mine.length, 1, JSON.stringify(lines()));
  assert.equal(mine[0].kind, 'x402'); assert.equal(mine[0].ok, false); assert.equal(mine[0].previous, FRONTIER); assert.equal(mine[0].resource, '/v1/echo');
  assert.ok(typeof mine[0].refused === 'string' && mine[0].refused.length > 0 && mine[0].refused.length <= 200, JSON.stringify(mine[0]));
  assert.ok(!('127.0.0.1' in mine[0]) && !JSON.stringify(mine[0]).includes('127.0.0.1'), 'no raw IP in the line');
  const handlers = server.listeners('request');
  const q = response();
  await handlers[handlers.length - 1]({ url: '/v1/requests?hash=' + hash, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.9' } }, q);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.found, true); assert.equal(q.body.entries[0].ok, false); assert.equal(q.body.entries[0].refused, mine[0].refused);
});

test('refused lines are capped per client address: 10 a minute, the rest refused silently', async () => {
  const { hash, header } = shortBlock();   // the same fields as the first test's block, so the same hash: count the delta
  const n0 = lines().filter(e => e.hash === hash && e.ok === false).length;
  for (let i = 0; i < 14; i++) {
    const res = response();
    assert.equal(await chargeX402({ url: '/v1/echo?msg=cap', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.2' } }, res, header), false);
    assert.equal(res.status, 402);
  }
  assert.equal(lines().filter(e => e.hash === hash && e.ok === false).length - n0, 10);
});

test('a payload that does not parse to a block leaves no line', async () => {
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: { account: 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue', nonsense: true } } });
  const n = lines().length;
  const res = response();
  assert.equal(await chargeX402({ url: '/v1/echo?msg=junk', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.3' } }, res, header), false);
  assert.equal(res.status, 402);
  assert.equal(lines().length, n, 'nothing to key a line on, nothing written');
});
