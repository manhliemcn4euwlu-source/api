'use strict';
// Offline: the /v1/work and /v1/process request log. From TheAliphant's courier proof, 2026-09-16:
// a report said "I did not use pursekeeper.dev for work or broadcast" and there was no log to check it against.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
// Not guarded with test/guard-data.js: this file tests the real append path of data/requests.jsonl and restores the
// log itself afterwards. Run the suite in a worktree against a copy of data/, as the README says, not in the live dir.
const {logReq, reqLogFor, REQ_LOG} = require('../server');
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
