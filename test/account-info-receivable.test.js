// node --test  (run from api/). /v1/account_info published `receivable_raw: "0"` for accounts that were holding unpocketed sends.
// The route asked the node without `receivable: 'true'`, so the node never sent the field, and `?? '0'` turned the absence into a
// zero; the branch for an account with no blocks did not carry the field at all, and that branch is exactly where unpocketed sends
// live (llmrt, 2026-10-23: a 1-raw send to an account with one block answered receivable_raw "0" while /v1/receivable listed the
// send, and a 1-raw send to an unopened account was not mentioned in the account_info answer at all).
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
require('./guard-data');   // no write under data/ while the server boots
process.env.NANO_RPC = 'http://node.test/rpc';
const { shapeAccountInfo, server } = require('../server');

const F = 'A'.repeat(64);
const OPEN = 'nano_165q65ujhsmsmnn5ejapbem1iieuq4fxzwnshmz7z7zrn9gm3gy8umx998cf';
const UNOPENED = 'nano_1fhxswg75u3gtq4t5f3ikhx7sbbm5z8ugyf6rmks3cttbyrhk6ptsfonj9sg';
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const res = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });
async function get(path) {
  const r = res();
  await server.listeners('request')[0]({ url: path, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '198.51.100.44' } }, r);
  return r;
}

test('the route asks the node for the receivable figure', async () => {
  const asked = [];
  globalThis.fetch = async (url, opts) => { const b = JSON.parse(opts.body); asked.push(b); return { ok: true, json: async () => ({ frontier: F, confirmed_frontier: F, balance: '5', confirmed_balance: '5', block_count: '2', representative: OPEN, receivable: '7' }) }; };
  const r = await get('/v1/account_info?account=' + OPEN);
  assert.equal(asked[0].receivable, 'true', 'without this flag the node omits the field entirely');
  assert.equal(r.body.receivable_raw, '7');
});

test('an unopened account reports what it can pocket instead of leaving the field out', async () => {
  const HASH = 'C'.repeat(64);
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.action === 'account_info') return { ok: true, json: async () => ({ error: 'Account not found', balance: '0' }) };
    if (b.action === 'receivable') return { ok: true, json: async () => ({ blocks: { [HASH]: { amount: '1', source: OPEN } } }) };
    return { ok: true, json: async () => ({ error: 'unexpected rpc ' + b.action }) };
  };
  const r = await get('/v1/account_info?account=' + UNOPENED);
  assert.equal(r.status, 200);
  assert.equal(r.body.found, false);
  assert.equal(r.body.receivable_raw, '1', 'a send is waiting; the answer must say so');
  assert.equal(r.body.receivable_count, 1);
});

test('a node that cannot be asked is a 502 that says the figures are unknown, not zero', async () => {
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await get('/v1/account_info?account=' + UNOPENED);
  assert.equal(r.status, 502);
  assert.equal(r.body.receivable_raw, null);
  assert.match(r.body.note, /not zero/);
});

test('shapeAccountInfo invents no receivable figure when the node answered none', () => {
  assert.equal(shapeAccountInfo({ frontier: F, balance: '5', block_count: '2', representative: OPEN }).receivable_raw, null);
  assert.equal(shapeAccountInfo({ frontier: F, balance: '5', block_count: '2', representative: OPEN, pending: '9' }).receivable_raw, '9');
});
