// node --test (run from api/). GET /v1/requests answers "was H worked or broadcast through this server?" and its note
// says "absence means pursekeeper.dev was not used for that block". A block this server broadcast itself, as the x402
// payment for a paid call (chargeX402 -> process RPC), was never written to the request log, so the route answered
// found:false for it. Mocked node; every data/ write is dropped (guard-data), and the request log is kept in memory.
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

// The request log in memory: appends to REQ_LOG land here, reads of REQ_LOG answer from here.
let reqLog = '';
const guardedAppend = fs.appendFileSync, realRead = fs.readFileSync;
fs.appendFileSync = (p, d, ...a) => { if (String(p) === REQ_LOG) { reqLog += d; return; } return guardedAppend(p, d, ...a); };
fs.readFileSync = (p, ...a) => { if (String(p) === REQ_LOG) { if (!reqLog) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return reqLog; } return realRead(p, ...a); };

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const AMOUNT = 10n ** 27n;
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';   // valid at the send threshold over FRONTIER (the same precomputed value charge-x402-confirm uses)
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

test('a block this server broadcast as an x402 payment is found by /v1/requests, by its hash and by its previous', async () => {
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const hash = x402.blockHash(block);
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } });
  const paid = response();
  assert.equal(await chargeX402({ url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } }, paid, header), true, JSON.stringify(paid.body));
  assert.ok(chain.has(hash), 'the block was broadcast through this server (process RPC)');
  const handlers = server.listeners('request');
  for (const h of [hash, FRONTIER]) {
    const res = response();
    await handlers[handlers.length - 1]({ url: '/v1/requests?hash=' + h, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.9' } }, res);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.found, true, '/v1/requests?hash=' + (h === hash ? 'the broadcast block' : 'its previous') + ' answered ' + JSON.stringify({ found: res.body.found, total: res.body.total, note: res.body.note }));
  }
});
