// node --test (run from api/). data/checks.json holds no Nano, but it is the only record of third-party use of the free
// routes (/v1/verify, /v1/receivable, account_info, process) and of the 402 challenges, and the reviews cite it. Until
// 2026-10-23 it was written in place and loaded through a bare catch, so a process killed mid-write left a truncated
// file that the next start read as "no calls ever" (llmrt on api#95, 2026-10-21). This test boots the server on a
// truncated checks.json beside a complete .bak and expects the counters back and the damage named on stderr.
// Offline: the exported request listener with a mocked node; every write under data/ is dropped, the atomic store's
// openSync/rename included (the guard test/credit-cap.test.js uses), and only the two checks reads are faked.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const CHECKS = path.join(__dirname, '..', 'data', 'checks.json');
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync, realRead = fs.readFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'checks-durability-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
// The complete record, as the last good write left it, and the primary cut in half by a kill mid-write.
const good = { verify: 1234, receivable: 56, account_info: 7, process: 8, ips: { a1b2c3d4e5f6: 100, '0f0e0d0c0b0a': 1 }, since: '2026-09-12T00:00:00.000Z', challenges_402: 90, ips402: { a1b2c3d4e5f6: 90 }, since_402: '2026-09-20T00:00:00.000Z' };
const goodText = JSON.stringify(good);
fs.readFileSync = (p, ...a) => {
  if (String(p) === CHECKS) return goodText.slice(0, Math.floor(goodText.length / 2));
  if (String(p) === CHECKS + '.bak') return goodText;
  return realRead(p, ...a);
};
const stderr = [];
const realErr = console.error;
console.error = (...a) => { stderr.push(a.join(' ')); };
const { server } = require('../server');
console.error = realErr;
after(() => { fs.writeFileSync = realWrite; fs.appendFileSync = realAppend; fs.readFileSync = realRead; fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink; try { realUnlink(SCRATCH); } catch {} });

function get(url, ip = '198.51.100.21') {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  return server.listeners('request')[0]({ url, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: ip } }, res).then(() => res);
}

test('a truncated checks.json is named at boot and the counters come back from .bak', async () => {
  const line = stderr.find(l => l.startsWith('checks: '));
  assert.ok(line, 'boot must print a checks: line naming the damaged file; stderr was ' + JSON.stringify(stderr));
  assert.match(line, /is damaged/);
  assert.match(line, /recovered the last complete copy from \.bak/);
  const st = await get('/v1/stats');
  assert.equal(st.status, 200);
  assert.equal(st.body.checks.verify, 1234, 'verify count must be the .bak value, not zero');
  assert.equal(st.body.checks.receivable, 56);
  assert.equal(st.body.checks.account_info, 7);
  assert.equal(st.body.checks.process, 8);
  assert.equal(st.body.checks.distinct_ips, 2);
  assert.equal(st.body.checks.since, '2026-09-12T00:00:00.000Z', 'since must be the recorded start, not boot time');
  assert.equal(st.body.checks.challenges_402, 90);
  assert.equal(st.body.checks.challenges_402_distinct_callers, 1);
});

test('a free call after recovery counts on top of the recovered figures, not from zero', async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ blocks: {}, balance: '0', frontier: 'AB'.repeat(32), block_count: '0' }) });
  const r = await get('/v1/verify?hash=' + 'AB'.repeat(32) + '&any=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const st = await get('/v1/stats');
  assert.equal(st.body.checks.verify, 1235);
  assert.equal(st.body.checks.distinct_ips, 3, 'a new caller is a third distinct IP hash');
});
