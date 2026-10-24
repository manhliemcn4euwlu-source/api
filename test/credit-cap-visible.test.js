// node --test (run from api/). README: "A send past the cap is credited at 1 NANO and the reply names the excess."
// test/credit-cap.test.js covers the one order in which that holds: the hash is first presented to GET /v1/credit. A buyer
// following the documented flow presents it first as X-Nano-Payment on a paid route, and that reply said nothing about
// the cap; every later /v1/credit read then took the stored-credit branch, which never carried `capped` either. The
// excess was named to nobody.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.NANO_RPC = 'http://node.test/rpc';
require('./guard-data');
const { server, credits, loadPurposes } = require('../server');
const ready = loadPurposes();

const TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FROM = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
const BIG = 'CE'.repeat(32);
const CAP = 10n ** 30n;
const OVERPAY = 3n * CAP;   // 3 NANO sent, 1 NANO credited: 2 NANO not applied
const PRICE = 10n ** 27n;

globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  let a;
  if (b.action === 'block_info' && b.hash === BIG) {
    a = { block_account: FROM, subtype: 'send', amount: OVERPAY.toString(), confirmed: 'true', height: '3',
      local_timestamp: '1758000000', contents: { link_as_account: TO } };
  } else if (b.action === 'account_history') {
    a = { history: [{ hash: BIG, type: 'send', account: TO, local_timestamp: '1758000000' }] };
  } else a = { error: 'unexpected rpc ' + b.action };
  return { ok: true, json: async () => a };
};

async function get(pathqs, headers = {}) {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s, h) { this.status = s; for (const [k, v] of Object.entries(h || {})) this.headers[k.toLowerCase()] = v; },
    end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  const handlers = server.listeners('request');
  await handlers[handlers.length - 1]({ url: pathqs, method: 'GET', headers: { host: 'pursekeeper.dev', ...headers },
    socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

test('an over-cap send first presented on a paid route names the excess, there and on every later /v1/credit read', async () => {
  await ready;
  const paid = await get('/v1/echo?msg=hi', { 'x-nano-payment': BIG });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(credits[BIG], (CAP - PRICE).toString(), 'credited at the cap, one call spent');
  // And the status route still says it later: the buyer who checks /v1/credit after the call is told what was not applied.
  const c = await get('/v1/credit?hash=' + BIG);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.remaining_raw, (CAP - PRICE).toString());
  // Both places are checked before either assertion, so the failure names every one that is silent.
  const silent = [];
  if (paid.headers['x-nano-credit-excess-raw'] !== (OVERPAY - CAP).toString()) silent.push('the paid reply that applied the cap has no x-nano-credit-excess-raw');
  if (c.body.capped !== true || c.body.amount_raw !== OVERPAY.toString() || c.body.excess_raw !== (OVERPAY - CAP).toString())
    silent.push('/v1/credit after the first paid call answers ' + JSON.stringify(c.body) + ' with no capped/amount_raw/excess_raw');
  assert.deepEqual(silent, [], 'the excess of an over-cap send must be named to its payer');
});
