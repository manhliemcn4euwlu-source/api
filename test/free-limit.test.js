'use strict';
// Offline: the five free checks each carry their own 60 per minute per IP, as README
// lines 41-46 say. llmrt, 2026-10-22, api#103: one shared map made the real
// allowance 60 in total, so a caller that spent them on /v1/verify could not read
// /v1/receivable in the same minute, and scripts/no-node.js receive died at the
// 30th pending send (2 calls per send + 2 at startup = 60).
// Driven through the exported request listener with a mocked node; data/ writes dropped.
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
// Every write under data/ is dropped, the atomic store's openSync/rename path included: data/checks.json is written on
// every counted call since 2026-10-23 and this file makes 60 of them (see test/guard-data.js).
const guard = require('./guard-data');
const {server} = require('../server');
after(() => guard.restore());

const A = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const H = 'AB'.repeat(32);
let rpcCalls = 0;
globalThis.fetch = async () => { rpcCalls++; return { ok: true, json: async () => ({ blocks: {}, balance: '0', frontier: H, block_count: '0' }) }; };

function req(ip) {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  return { res, fire: (url) => server.listeners('request')[0]({ url, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: ip } }, res) };
}
async function get(url, ip = '198.51.100.7') {
  const r = req(ip);
  await r.fire(url);
  return r.res;
}

test('60 verify calls from one IP do not block receivable for that IP', async () => {
  const ip = '198.51.100.11';
  for (let i = 0; i < 60; i++) {
    const r = await get('/v1/verify?hash=' + H + '&any=1', ip);
    assert.equal(r.status, 200, 'verify call ' + (i + 1) + ' answered ' + r.status);
  }
  const after60 = await get('/v1/verify?hash=' + H + '&any=1', ip);
  assert.equal(after60.status, 429, 'the 61st verify call must still be refused');
  assert.match(after60.body.error, /60 checks per minute/);
  // Since 2026-10-23 the refusal says when to come back: whole seconds until the oldest hit leaves the window, so a client
  // (scripts/no-node.js receive) waits exactly that long (llmrt on api#103 asked for the header; credited).
  const ra = Number(after60.headers['retry-after']);
  assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, 'Retry-After must be 1..60 whole seconds, got ' + JSON.stringify(after60.headers['retry-after']));
  const recv = await get('/v1/receivable?account=' + A, ip);
  assert.equal(recv.status, 200, 'receivable must keep its own allowance: ' + JSON.stringify(recv.body));
  const info = await get('/v1/account_info?account=' + A, ip);
  assert.equal(info.status, 200, 'account_info must keep its own allowance: ' + JSON.stringify(info.body));
  const rq = await get('/v1/requests?hash=' + H, ip);
  assert.equal(rq.status, 200, 'requests must keep its own allowance: ' + JSON.stringify(rq.body));
});

test('the allowance is per IP, not global', async () => {
  const busy = '198.51.100.12', fresh = '198.51.100.13';
  for (let i = 0; i < 60; i++) assert.equal((await get('/v1/receivable?account=' + A, busy)).status, 200);
  assert.equal((await get('/v1/receivable?account=' + A, busy)).status, 429);
  assert.equal((await get('/v1/receivable?account=' + A, fresh)).status, 200);
});

test('each route stops at its own 60, and the neighbour is unaffected', async () => {
  const ip = '198.51.100.14';
  for (let i = 0; i < 60; i++) assert.equal((await get('/v1/receivable?account=' + A, ip)).status, 200);
  assert.equal((await get('/v1/receivable?account=' + A, ip)).status, 429);
  assert.equal((await get('/v1/account_info?account=' + A, ip)).status, 200);
  assert.equal((await get('/v1/verify?hash=' + H + '&any=1', ip)).status, 200);
  assert.ok(rpcCalls > 0, 'the mocked node was reached, so the 200s are real answers');
});
