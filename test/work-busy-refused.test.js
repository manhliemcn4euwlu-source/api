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
const realFetch = globalThis.fetch;
let release;
const holdNode = () => {
  globalThis.fetch = (url, ...a) => String(url) === process.env.NANO_RPC
    ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ work: '00'.repeat(8) }) }); })
    : realFetch(url, ...a);
};
after(() => { if (release) release(); globalThis.fetch = realFetch; });

// A real HTTP request, so the mock above cannot swallow it.
const http = require('node:http');
const post = (port, path, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
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
    // Four calls hold the four slots; the fifth is refused by the cap.
    const held = [1, 2, 3, 4].map(() => post(port, '/v1/work', { hash: HASH }));
    await new Promise(r => setTimeout(r, 150));
    const refused = await post(port, '/v1/work', { hash: HASH });
    assert.equal(refused.status, 503, 'the fifth call is over the cap');
    assert.match(refused.body.error, /work server busy/);

    const mine = lines().filter(e => e.hash === HASH && e.kind === 'work' && e.ok === false);
    assert.equal(mine.length, 1, 'the refused call left exactly one line: ' + JSON.stringify(mine));
    assert.match(mine[0].refused, /work server busy/);
    assert.equal(mine[0].paid, false);
    if (release) release();
    held.forEach(p => p.catch(() => {}));
  } finally {
    await new Promise(r => server.close(r));
  }
});
