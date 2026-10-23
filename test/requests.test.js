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
    // Start from an empty log: the copied live log can already hold these fixed hashes (six real /v1/work calls on
    // 'A'.repeat(64) landed on 2026-10-22, and the count below read 9 against a copy of that day's data).
    fs.writeFileSync(REQ_LOG, '');
    for (let i = 0; i < 25; i++) logReq(req, { kind: 'process', hash: null, previous: FREE_H, ok: false, error: 'missing account' });
    const dflt = await get('/v1/requests?hash=' + FREE_H);
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.entries.length, 20, 'the default page stays 20 entries');
    assert.equal(dflt.body.total, 25, 'the answer must count every entry, not only the page');
    assert.equal(dflt.body.truncated, true, 'a page that is not the whole log must say so');
    assert.equal(dflt.body.next_cursor, 20, 'the answer says where the next page starts');
    assert.match(dflt.body.next, /entries 0 to 19 of 25/);
    const all = await get('/v1/requests?hash=' + FREE_H + '&limit=25');
    assert.equal(all.body.entries.length, 25, 'limit=25 lists all of them');
    assert.equal(all.body.truncated, false); assert.equal(all.body.total, 25);
    assert.equal(all.body.next, undefined);
    assert.equal(all.body.next_cursor, null, 'a complete answer has no next page');
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

// api#116 (pyfile-toolkit, 2026-10-23): limit is clamped to REQUESTS_HARD_MAX, so a hash with more than 5,000 entries
// answered truncated:true with next telling the caller to pass limit=5000 "for all of them" and got the same newest 5,000
// back. No cursor existed, so the oldest entries were unreachable, which defeats the route's own promise that a reader can
// prove a hash was not used here. A cursor now walks the log one page at a time; this test proves every entry is reachable
// exactly once across the 5,000 boundary, which is where the reported gap was.
const BIG_H = 'B'.repeat(64);
test('a hash with more than 5,000 entries can be read in full, exactly once each, by cursor', async () => {
  const before = fs.existsSync(REQ_LOG) ? fs.readFileSync(REQ_LOG) : null;
  try {
    const N = 5001;
    // One append per entry, through the log's own path, so the paging reads what a real log holds.
    for (let i = 0; i < N; i++) logReq(req, { kind: 'process', hash: null, previous: BIG_H, seq: i, ok: false, error: 'x' });
    const first = await get('/v1/requests?hash=' + BIG_H);
    assert.equal(first.status, 200);
    assert.equal(first.body.total, N, 'total counts every entry, past the hard cap');
    assert.equal(first.body.entries.length, 20);
    assert.equal(first.body.truncated, true);
    assert.equal(first.body.cursor, 0);
    assert.equal(first.body.next_cursor, 20);

    // Walk the whole log: newest first, no gaps, no repeats.
    const seen = [];
    let cursor = 0, pages = 0;
    for (;;) {
      const r = await get('/v1/requests?hash=' + BIG_H + '&limit=5000&cursor=' + cursor);
      assert.equal(r.status, 200);
      assert.equal(r.body.cursor, cursor);
      for (const e of r.body.entries) seen.push(e.seq);
      pages++;
      if (r.body.next_cursor === null) { assert.equal(r.body.truncated, false); break; }
      assert.equal(r.body.truncated, true);
      assert.equal(r.body.next_cursor, cursor + r.body.entries.length, 'the cursor advances by the entries just served');
      cursor = r.body.next_cursor;
      if (pages > 5) throw new Error('paging did not terminate');
    }
    assert.equal(pages, 2, '5,001 entries at 5,000 a page are two pages');
    assert.equal(seen.length, N, 'every entry is served exactly once');
    assert.equal(new Set(seen).size, N, 'no entry is served twice');
    assert.equal(seen[0], N - 1, 'the newest entry comes first');
    assert.equal(seen[N - 1], 0, 'the oldest entry is reachable, which the cap made impossible');

    const bad = await get('/v1/requests?hash=' + BIG_H + '&cursor=-1');
    assert.equal(bad.status, 400, 'a negative cursor is refused rather than read as the default');
    const past = await get('/v1/requests?hash=' + BIG_H + '&cursor=' + N);
    assert.equal(past.status, 200);
    assert.equal(past.body.entries.length, 0, 'a cursor past the end answers an empty page, not the first one');
    assert.equal(past.body.next_cursor, null);
  } finally {
    if (before === null) fs.unlinkSync(REQ_LOG); else fs.writeFileSync(REQ_LOG, before);
  }
});
