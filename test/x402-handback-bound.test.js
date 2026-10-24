// node --test (run from api/). A call paid over x402 and then handed back (/v1/work 502 when no work source answers; /v1/fetch
// 400/502 when the target never answered) puts the price back on the settled block's hash as X-Nano-Payment credit. The block
// is public on the chain from the broadcast, and GET /v1/credit answers remaining_raw for any hash, so a hand-back is visible
// to anyone who reads the payer's block off the chain. Restored as plain bearer credit, a stranger spent it with
// X-Nano-Payment: <the payer's hash> before the payer retried, and the payer's own retry was refused as used up: the takeover
// that the X-Nano-Represent token closed for a broadcast-but-unconfirmed block (api#81). The credit is now bound to a token
// that only the reply handing it back carries.
'use strict';
require('./guard-data');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
process.env.NANO_RPC = 'http://node.test/rpc';
process.env.WORK_URLS = ''; process.env.PAID_WORK_URLS = '';
const { server, credits, loadPurposes, X402_CONFIRM } = require('../server');
const x402 = require('../x402');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const AMOUNT = 10n ** 27n;                                                              // PRICE_RAW in server.js
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';   // valid at the send threshold over FRONTIER (test/fetch-handback.test.js)
const BALANCE = 5n * 10n ** 27n;
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s, h) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });
const call = async (r) => { const res = response(); await server.listeners('request')[0](r, res); return res; };

test('x402 hand-back credit on the public block hash is not spendable by a stranger with X-Nano-Payment', async () => {
  Object.assign(X402_CONFIRM, { intervalMs: 1, boundMs: 200 });
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  const payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const H = x402.blockHash(block);
  const chain = new Map();
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); let a;
    if (b.action === 'account_info') a = { frontier: FRONTIER, confirmed_frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, block_count: '1' };
    else if (b.action === 'process') { chain.set(H, b.block); a = { hash: H }; }
    else if (b.action === 'block_info') a = chain.has(b.hash) ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: chain.get(b.hash) } : { error: 'Block not found' };
    else if (b.action === 'work_generate') a = { error: 'work generation is disabled on this node' };   // every work source fails
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
  await loadPurposes();

  // The payer buys one /v1/work over x402; no source can produce work, so the call is handed back with the price on H.
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } });
  const workReq = Object.assign(Readable.from([Buffer.from(JSON.stringify({ hash: 'AB'.repeat(32) }))]),
    { url: '/v1/work', method: 'POST', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } });
  const paid = await call(workReq);
  assert.equal(paid.status, 502, JSON.stringify(paid.body));
  assert.ok(paid.body.error.includes(H), paid.body.error);
  assert.equal(credits[H], AMOUNT.toString(), 'the price is back on the settled block hash');

  // A stranger who read H off the chain (and saw remaining_raw on GET /v1/credit) presents it as bearer credit.
  const seen = await call({ url: '/v1/credit?hash=' + H, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '198.51.100.7' } });
  assert.equal(seen.body.remaining_raw, AMOUNT.toString());
  const stranger = await call({ url: '/v1/echo?msg=stolen', method: 'GET', headers: { host: 'pursekeeper.dev', 'x-nano-payment': H }, socket: { remoteAddress: '198.51.100.7' } });
  assert.equal(stranger.status, 402, 'a stranger was served on the x402 payer\'s handed-back credit: ' + JSON.stringify(stranger.body));
  assert.equal(credits[H], AMOUNT.toString(), 'the payer\'s credit is still there');

  // The payer, holding the token from the 502, is served.
  const token = paid.headers['x-nano-represent'];
  assert.match(String(token), /^[0-9a-f]{32}$/);
  assert.ok(paid.body.error.includes(token), 'the 502 names the token');
  const own = await call({ url: '/v1/echo?msg=mine', method: 'GET', headers: { host: 'pursekeeper.dev', 'x-nano-payment': H, 'x-nano-represent': token }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.echo, 'mine');
  assert.equal(credits[H], '0');
});
