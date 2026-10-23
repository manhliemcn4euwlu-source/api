'use strict';
// Offline: the /v1/work and /v1/process request log. From TheAliphant's courier proof, 2026-09-16:
// a report said "I did not use pursekeeper.dev for work or broadcast" and there was no log to check it against.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Not guarded with test/guard-data.js: this file tests the real append path of data/requests.jsonl and restores the
// log itself afterwards. Run the suite in a worktree against a copy of data/, as the README says, not in the live dir.
const {logReq, reqLogFor, REQ_LOG, server} = require('../server');
const H = 'C'.repeat(64), P = 'D'.repeat(64), X = 'E'.repeat(64);
const req = {headers: {'x-forwarded-for': '203.0.113.9'}, socket: {remoteAddress: '127.0.0.1'}};
test('entries are found by block hash and by previous, newest first, without the raw IP', () => {
  const before = fs.existsSync(REQ_LOG) ? fs.readFileSync(REQ_LOG) : null;
  try {
    logReq(req, {kind: 'work', hash: P, ok: true, tier: 'free'});
    logReq(req, {kind: 'process', hash: H, previous: P, subtype: 'receive', ok: true, error: null});
    const byHash = reqLogFor(H);
    assert.equal(byHash.length, 1); assert.equal(byHash[0].kind, 'process'); assert.equal(byHash[0].previous, P);
    const byPrev = reqLogFor(P);
    assert.equal(byPrev.length, 2); assert.equal(byPrev[0].kind, 'process'); assert.equal(byPrev[1].kind, 'work');
    assert.equal(reqLogFor(X).length, 0);
    const raw = fs.readFileSync(REQ_LOG, 'utf8');
    assert.ok(!raw.includes('203.0.113.9')); assert.match(byHash[0].ip_key, /^[0-9a-f]{12}$/); assert.ok(byHash[0].ts);
  } finally {
    if (before === null) fs.unlinkSync(REQ_LOG); else fs.writeFileSync(REQ_LOG, before);
  }
});
test('missing log file reads as empty', () => {
  const before = fs.existsSync(REQ_LOG) ? fs.readFileSync(REQ_LOG) : null;
  try { if (before !== null) fs.unlinkSync(REQ_LOG); assert.deepEqual(reqLogFor(H), []); }
  finally { if (before !== null) fs.writeFileSync(REQ_LOG, before); }
});

// llmrt, 2026-10-23: the route listed the newest 20 entries with no word that more existed, and its note says absence
// means the hash was not used here. 25 /v1/process calls on one previous answered entries:20 against the live service.
const FREE_H = 'F'.repeat(64);
function fakeRes() {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  return res;
}
async function get(url) {
  const res = fakeRes();
  await server.listeners('request')[0]({ url, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '198.51.100.31' } }, res);
  return res;
}
test('an answer that drops entries says so, counts them, and pages on request', async () => {
  const before = fs.existsSync(REQ_LOG) ? fs.readFileSync(REQ_LOG) : null;
  try {
    for (let i = 0; i < 25; i++) logReq(req, { kind: 'process', hash: null, previous: FREE_H, ok: false, error: 'missing account' });
    const dflt = await get('/v1/requests?hash=' + FREE_H);
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.entries.length, 20, 'the default page stays 20 entries');
    assert.equal(dflt.body.total, 25, 'the answer must count every entry, not only the page');
    assert.equal(dflt.body.truncated, true, 'a page that is not the whole log must say so');
    assert.match(dflt.body.next, /newest 20 of 25/);
    const all = await get('/v1/requests?hash=' + FREE_H + '&limit=25');
    assert.equal(all.body.entries.length, 25, 'limit=25 lists all of them');
    assert.equal(all.body.truncated, false); assert.equal(all.body.total, 25);
    assert.equal(all.body.next, undefined);
    // Nothing dropped, no page marker: a hash used three times answers exactly three and says it is complete.
    for (let i = 0; i < 3; i++) logReq(req, { kind: 'work', hash: 'A'.repeat(64), ok: true });
    const small = await get('/v1/requests?hash=' + 'A'.repeat(64));
    assert.equal(small.body.entries.length, 3); assert.equal(small.body.truncated, false); assert.equal(small.body.total, 3);
    const bad = await get('/v1/requests?hash=' + FREE_H + '&limit=0');
    assert.equal(bad.status, 400, 'limit=0 is refused rather than silently read as the default');
  } finally {
    if (before === null) fs.unlinkSync(REQ_LOG); else fs.writeFileSync(REQ_LOG, before);
  }
});
