// node --test (run from api/). A send that this server has already ruled is not API credit (a marketplace checkout share, a
// stake, an own move, a donation: noCredit) must not buy a call when someone else wraps the same public block in a
// PAYMENT-SIGNATURE. The bearer path refuses it "whoever presents it (the chain is public, so anyone could)"; the x402 path
// took verify's alreadyLanded branch for the landed block, whose seen() looked only at `credits` and `settling`, and served it.
'use strict';
require('./guard-data');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
process.env.NANO_RPC = 'http://node.test/rpc';
const { chargeX402, creditFor, credits, loadPurposes, FEE_COLLECTORS } = require('../server');
const x402 = require('../x402');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const PRICE = 10n ** 27n;                                                               // PRICE_RAW in server.js
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: PRICE, maxTimeoutSeconds: 60, workOptional: true });
const PREV = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const FEE_BLOCK = 'FE'.repeat(32);
const FEE_TO = [...FEE_COLLECTORS][0];

const request = (hdr) => ({ method: 'GET', url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': hdr }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

test('a landed send already refused as not-credit (checkout share) is not served when wrapped in a PAYMENT-SIGNATURE', async () => {
  // The checkout wallet: it sent exactly the price to this address and, in its very next block, the platform fee.
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  const wallet = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  const BAL = 5n * PRICE;
  const block = N.createBlock(sk, { work: '0', previous: PREV, representative: wallet, balance: (BAL - PRICE).toString(), link: PAY_TO }).block;
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const H = x402.blockHash(block);
  const rpcs = [];
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); rpcs.push(b.action);
    let a;
    if (b.action === 'block_info' && b.hash === H) a = { block_account: wallet, subtype: 'send', amount: PRICE.toString(), confirmed: 'true', height: '2', local_timestamp: '1758000000', contents: { ...block, link_as_account: PAY_TO } };
    else if (b.action === 'account_history') a = { history: [{ hash: H, type: 'send', account: PAY_TO, local_timestamp: '1758000000' }, { hash: FEE_BLOCK, type: 'send', account: FEE_TO, local_timestamp: '1758000002' }] };
    else if (b.action === 'account_info' && b.account === wallet) a = { frontier: FEE_BLOCK, confirmed_frontier: FEE_BLOCK, balance: '0', representative: wallet, block_count: '3' };
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
  await loadPurposes();

  // The bearer path: refused with the checkout reason, nothing credited.
  const c = await creditFor(H);
  assert.match(String(c.error), /checkout wallet/, JSON.stringify(c));
  assert.equal(H in credits, false);

  // Anyone can wrap the same public block in an x402 payload (the signature is on the chain). It must be refused too.
  const hdr = encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...REQ, extra: { ...REQ.extra, session: 'd'.repeat(32) } }, payload: { block } });
  const res = response();
  const served = await chargeX402(request(hdr), res, hdr);
  assert.equal(served, false, 'a send that paid for something else bought a call through PAYMENT-SIGNATURE: ' + JSON.stringify({ status: res.status, hash: res.getHeader('x-nano-payment-hash') }));
  assert.equal(res.status, 402);
  assert.match(res.body.error, /checkout wallet/);
  assert.equal(rpcs.includes('process'), false, 'nothing is broadcast');
});
