'use strict';
// Offline: byte ranges on 200 responses (2026-09-28). pyfile-toolkit's path cut every flow at about 20 KB and a
// Range request for the second half of /log.json answered 200 with the start of the document.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
require('./guard-data');   // every write under data/ is dropped before the server boots (counters, ledgers, logs)
const {send} = require('../server');
function fakeRes(range, gzip) {
  const r = {byteRange: range, acceptsGzip: !!gzip, writeHead(code, headers) { r.code = code; r.headers = headers; }, end(b) { r.body = b === undefined ? Buffer.alloc(0) : Buffer.from(b); }};
  return r;
}
const body = 'x'.repeat(5000) + 'END';
test('a single bytes range answers 206 with the identity slice and Content-Range', () => {
  const r = fakeRes('bytes=4990-', true);
  send(r, 200, body, 'text/plain');
  assert.equal(r.code, 206); assert.equal(r.body.toString(), body.slice(4990)); assert.equal(r.headers['content-range'], 'bytes 4990-5002/5003');
  assert.equal(r.headers['content-length'], 13); assert.equal(r.headers['content-encoding'], undefined);
});
test('a bounded and a suffix range', () => {
  let r = fakeRes('bytes=0-9'); send(r, 200, body, 'text/plain');
  assert.equal(r.code, 206); assert.equal(r.body.length, 10); assert.equal(r.headers['content-range'], 'bytes 0-9/5003');
  r = fakeRes('bytes=-3'); send(r, 200, body, 'text/plain');
  assert.equal(r.code, 206); assert.equal(r.body.toString(), 'END'); assert.equal(r.headers['content-range'], 'bytes 5000-5002/5003');
});
test('an unsatisfiable range answers 416 with the total; a malformed one is ignored', () => {
  let r = fakeRes('bytes=9000-'); send(r, 200, body, 'text/plain');
  assert.equal(r.code, 416); assert.equal(r.headers['content-range'], 'bytes */5003'); assert.equal(r.body.length, 0);
  r = fakeRes('bytes=a-b', true); send(r, 200, body, 'text/plain');
  assert.equal(r.code, 200); assert.equal(r.headers['accept-ranges'], 'bytes'); assert.equal(r.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(r.body).toString(), body);
});
test('ranges do not apply to non-200 answers', () => {
  const r = fakeRes('bytes=0-1'); send(r, 402, {error: 'payment required'});
  assert.equal(r.code, 402); assert.equal(r.headers['content-range'], undefined); assert.equal(r.headers['accept-ranges'], undefined);
});
