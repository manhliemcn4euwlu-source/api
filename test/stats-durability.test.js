// node --test (run from api/). /v1/stats counts paid calls, x402 calls and 402 challenges. Those three lived only in process
// memory, so every restart reset them to zero while `started` moved to the restart time and the two figures beside them in the
// same answer (x402_settled from data/x402.json, credited_hashes from data/credits.json) kept their history. Measured on the
// live service on 2026-10-23: calls_paid 0, calls_x402 0, started 17:05:30Z, beside x402_settled 39 and credited_hashes 45
// (llmrt). A reader asking whether anything was ever sold here read zero. This test boots the server twice over the same data
// directory and expects the counters to survive, and expects a counter that is below the durable settlement list to say so.
// Offline: the exported request listener with a mocked node; writes under data/ go to a scratch copy so the live files are not
// touched (the same guard the other durability tests use).
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
process.env.STATS_FILE = require('node:path').join(require('node:os').tmpdir(), 'stats-durability-stats-' + process.pid + '.json');
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-durability-'));
const inData = (p) => String(p).startsWith(DATA_DIR);
// Every path under data/ is redirected into the scratch directory: the live counters, credits and x402 log stay untouched.
const remap = (p) => path.join(SCRATCH_DIR, path.basename(String(p)));
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync, realRead = fs.readFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync, realAccess = fs.accessSync;
fs.writeFileSync = (p, ...a) => realWrite(inData(p) ? remap(p) : p, ...a);
fs.appendFileSync = (p, ...a) => realAppend(inData(p) ? remap(p) : p, ...a);
fs.openSync = (p, ...a) => realOpen(inData(p) ? remap(p) : p, ...a);
fs.renameSync = (p, q, ...a) => realRename(inData(p) ? remap(p) : p, inData(q) ? remap(q) : q, ...a);
fs.copyFileSync = (p, q, ...a) => realCopy(inData(p) ? remap(p) : p, inData(q) ? remap(q) : q, ...a);
fs.unlinkSync = (p) => realUnlink(inData(p) ? remap(p) : p);
fs.accessSync = (p, ...a) => realAccess(inData(p) ? remap(p) : p, ...a);
fs.readFileSync = (p, ...a) => realRead(inData(p) ? remap(p) : p, ...a);

const STATS = process.env.STATS_FILE;
const X402_LOG = path.join(__dirname, '..', 'data', 'x402.json');
// A settlement already on the books, as the durable file holds it, and the counters a previous boot left behind.
realWrite(remap(X402_LOG), JSON.stringify([{ hash: 'A'.repeat(64), payer: 'nano_' + '1'.repeat(59), amount_raw: '1000000000000000000000000000', resource: '/v1/echo?msg=x', at: '2026-10-22T00:00:00.000Z', work_by: 'seller' }]));
realWrite(STATS, JSON.stringify({ calls_paid: 41, calls_x402: 37, calls_402: 900, started: '2026-09-07T00:00:00.000Z' }));

const boot = () => {
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('api', 'server.js'))) delete require.cache[k];
  return require('../server');
};

function get(server, url, ip = '198.51.100.31') {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  return server.listeners('request')[0]({ url, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: ip } }, res).then(() => res);
}

after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend; fs.readFileSync = realRead;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink; fs.accessSync = realAccess;
  try { for (const n of fs.readdirSync(SCRATCH_DIR)) realUnlink(path.join(SCRATCH_DIR, n)); } catch {}
});

test('a restart keeps the paid-call counters and says which clock each one runs on', async () => {
  const { server } = boot();
  const st = await get(server, '/v1/stats');
  assert.equal(st.status, 200);
  assert.equal(st.body.calls_paid, 41, 'the paid-call count must come back from disk, not start at zero');
  assert.equal(st.body.calls_x402, 37, 'the x402 count must come back too');
  assert.equal(st.body.calls_402, 900, 'the 402 challenge count must come back too');
  assert.equal(st.body.started, '2026-09-07T00:00:00.000Z', 'started is when counting began, not this boot');
  assert.notEqual(st.body.process_started_at, st.body.started, 'this boot is named separately');
  assert.equal(st.body.counters_note, undefined, 'a counter at or above the durable settlement list needs no note');
  assert.equal(st.body.x402_settled, 1, 'the durable settlement list is still read');
});

test('a counter that lost its history beside a durable settlement list says so', async () => {
  realWrite(STATS, JSON.stringify({ calls_paid: 0, calls_x402: 0, calls_402: 0, started: '2026-10-23T17:05:30.514Z' }));
  const { server } = boot();
  const st = await get(server, '/v1/stats');
  assert.equal(st.status, 200);
  assert.equal(st.body.calls_paid, 0);
  assert.equal(st.body.x402_settled, 1);
  assert.ok(st.body.counters_note, 'zero paid calls beside a settled payment must carry a note naming which figure is durable');
  assert.match(st.body.counters_note, /x402_settled/);
});

test('a damaged stats file is named at boot and does not read as a fresh install', async () => {
  realWrite(STATS, '{"calls_paid": 41, "calls_x4');
  realWrite(STATS + '.bak', JSON.stringify({ calls_paid: 12, calls_x402: 11, calls_402: 300, started: '2026-09-20T00:00:00.000Z' }));
  const stderr = [];
  const realErr = console.error;
  console.error = (...a) => { stderr.push(a.join(' ')); };
  let server;
  try { ({ server } = boot()); } finally { console.error = realErr; }
  assert.ok(stderr.some(l => l.startsWith('stats: ') && /is damaged/.test(l)), 'boot must name the damaged file; stderr was ' + JSON.stringify(stderr));
  const st = await get(server, '/v1/stats');
  assert.equal(st.body.calls_paid, 12, 'the last complete copy is the count, not zero');
});
