// node --test (run from api/). A /v1/work call the busy cap turns away leaves a request-log line (kind work,
// ok:false, refused: the reason), and /v1/requests finds it. Until now the cap answered 503 before any logReq, so a
// caller whose valid hash was turned away was indistinguishable in the log from one that never called -- the same
// gap a refused x402 presentation had before 2026-11-01 (ccclosed, api#138). Measured on the live service
// 2026-11-01: six concurrent /v1/work calls answered four 200 and two 503, and /v1/requests?hash=0x00.. listed
// four lines. Mocked node; data/ writes dropped (guard-data); the request log is kept in memory.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.NANO_RPC = 'http://node.test/rpc';
require('./guard-data');
const { REQ_LOG, workFor } = require('../server');

let reqLog = '';
const guardedAppend = fs.appendFileSync, realRead = fs.readFileSync;
fs.appendFileSync = (p, d, ...a) => { if (String(p) === REQ_LOG) { reqLog += d; return; } return guardedAppend(p, d, ...a); };
fs.readFileSync = (p, ...a) => { if (String(p) === REQ_LOG) { if (!reqLog) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return reqLog; } return realRead(p, ...a); };

const HASH = '0'.repeat(64);
const lines = () => reqLog.split('\n').filter(Boolean).map(l => JSON.parse(l));

// The cap check reads the module-level workInFlight counter, which workFor()'s own await keeps raised. Only the node
// RPC is held open here (the server's own fetch to NANO_RPC); the test's HTTP calls use node:http directly, so holding
// the node never blocks the client. globalThis.fetch is restored before the test's own requests run.
//
// Every held call gets its own resolver: one shared `release` (the first version) answered only the last promise, so
// three of the four held /v1/work requests never settled, their client sockets stayed open, and server.close() waited
// on them forever (pursekeeper, api#139 review, 2026-11-04).
const realFetch = globalThis.fetch;
const releases = [];
const holdNode = () => {
  globalThis.fetch = (url, ...a) => String(url) === process.env.NANO_RPC
    ? new Promise(resolve => { releases.push(() => resolve({ ok: true, json: async () => ({ work: '00'.repeat(8) }) })); })
    : realFetch(url, ...a);
};
const releaseAll = () => { while (releases.length) releases.pop()(); };
after(() => { releaseAll(); globalThis.fetch = realFetch; });

// A real HTTP request, so the mock above cannot swallow it.
const http = require('node:http');
const post = (port, path, body, extra) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extra } },
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
  r.on('error', reject); r.end(data);
});

test('a call the busy cap turns away is logged with ok:false and its reason', async () => {
  const { server } = require('../server');
  const port = await new Promise(resolve => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s.address().port));
  });
  try {
    holdNode();
    // Four calls hold the four slots; the fifth and sixth are refused by the cap, one on each door.
    const held = [1, 2, 3, 4].map(() => post(port, '/v1/work', { hash: HASH }));
    await new Promise(r => setTimeout(r, 150));
    const free = await post(port, '/v1/work', { hash: HASH });
    assert.equal(free.status, 503, 'the fifth call is over the cap');
    assert.match(free.body.error, /work server busy/);
    // A payment header makes it a paid call: the cap is checked before the charge, so the line must say paid:true.
    const paidRes = await post(port, '/v1/work', { hash: HASH }, { 'x-nano-payment': 'A'.repeat(64) });
    assert.equal(paidRes.status, 503, 'the sixth call is over the cap too');
    assert.match(paidRes.body.error, /work server busy/);

    const mine = lines().filter(e => e.hash === HASH && e.kind === 'work' && e.ok === false);
    assert.equal(mine.length, 2, 'each refused call left exactly one line: ' + JSON.stringify(mine));
    for (const e of mine) assert.match(e.refused, /work server busy/);
    assert.deepEqual(mine.map(e => e.paid).sort(), [false, true], 'the line says which door the hash reached');
    releaseAll();
    held.forEach(p => p.catch(() => {}));
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});
