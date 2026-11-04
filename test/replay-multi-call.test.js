// node --test (run from api/). One send can cover many calls (max 1 NANO per hash), so one hash can buy several different
// replies. The replay cache was keyed by the hash alone, so the second 2xx replaced the first and a payer who re-presented
// the earlier call inside the ten minutes was told the credit was used up, with that reply gone (llmrt, 2026-11-04).
// The cache is now keyed by hash and call key, and this is the reproduction.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'repro-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { server, credits, loadPurposes } = require('../server');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});
const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const AMOUNT = 10n ** 27n;
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

test('a bearer hash that pays two different calls keeps both replays', async () => {
  await loadPurposes();
  const h = 'AB'.repeat(32);
  const payer = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.action === 'block_info' && b.hash === h)
      return { ok: true, json: async () => ({ block_account: payer, subtype: 'send', amount: (2n * AMOUNT).toString(), confirmed: 'true', height: '3', local_timestamp: '1758000000', contents: { link_as_account: PAY_TO } }) };
    if (b.action === 'account_history')
      return { ok: true, json: async () => ({ history: [{ hash: h, type: 'send', account: PAY_TO, local_timestamp: '1758000000' }] }) };
    return { ok: true, json: async () => ({ error: 'unexpected rpc ' + b.action }) };
  };
  const r1 = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=first', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h }, socket: { remoteAddress: '127.0.0.1' } }, r1);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.echo, 'first');
  const r2 = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=second', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h }, socket: { remoteAddress: '127.0.0.1' } }, r2);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.echo, 'second');
  assert.equal(credits[h], '0');
  const back1 = response();
  await server.listeners('request')[0]({ url: '/v1/echo?msg=first', method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': h }, socket: { remoteAddress: '127.0.0.1' } }, back1);
  assert.equal(back1.status, 200, 'the first reply must still replay: ' + JSON.stringify(back1.body));
  assert.equal(back1.headers['x-nano-replay'], 'true');
  assert.equal(back1.body.echo, 'first');
});
