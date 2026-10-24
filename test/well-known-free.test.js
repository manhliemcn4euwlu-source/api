// node --test (run from api/). /.well-known/x402 is the discovery manifest seller directories read, and README describes it as
// carrying "the free routes". /v1/credit is a free route (README: "remaining credit on a hash. 60 per minute per IP"; server.js
// calls it "the sixth free route" and since 2026-10-23 counts it in /v1/stats), but the manifest's `free` list named
// verify, receivable, account_info, process, requests, price, stats and x402, and not credit: the same four-of-six gap
// #115 closed for /v1/stats, left open in the manifest (live on pursekeeper.dev on 2026-10-23).
'use strict';
require('./guard-data');
process.env.NANO_RPC = 'http://node.test/rpc';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

async function get(p) {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  const handlers = server.listeners('request');
  await handlers[handlers.length - 1]({ url: p, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

test('/.well-known/x402 lists every free route, /v1/credit included', async () => {
  const r = await get('/.well-known/x402');
  assert.equal(r.status, 200);
  const free = r.body.free.map(u => new URL(u).pathname);
  for (const p of ['/v1/verify', '/v1/receivable', '/v1/account_info', '/v1/process', '/v1/requests', '/v1/credit'])
    assert.ok(free.includes(p), p + ' is a free route but the manifest omits it: ' + JSON.stringify(free));
});
