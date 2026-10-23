// node --test  (run from api/). A paid /v1/work that fails and is handed back is not a paid work in the public counter.
// workStats.paid was incremented right after charge() succeeded, before workFor() ran; when every work source failed the
// handler answered 502, put the price back on the hash and unpay() rolled back calls_paid / calls_x402, but work.paid
// in /v1/stats kept the call (One Cursor / PaperPilot Tools, by mail, 2026-10-23). The counter now moves after the proof.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
process.env.NANO_RPC = 'http://node.test/rpc';
process.env.WORK_URLS = ''; process.env.PAID_WORK_URLS = '';   // the node is the only work source, and it is the mock below
// Every write under data/ is dropped: the live credits, x402 log, payers, checks and request log are untouched.
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'work-paid-counter-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { server, credits, X402_CONFIRM } = require('../server');
const x402 = require('../x402');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const AMOUNT = 10n ** 27n;                                                              // PRICE_RAW in server.js
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';   // valid at the send threshold over FRONTIER (work depends on previous only)
const BALANCE = 5n * 10n ** 27n;
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });
const request = (method, url, headers, body) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { url, method, headers: { host: 'pursekeeper.dev', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
};
const handle = async (req) => { const res = response(); await server.listeners('request')[0](req, res); return res; };

test('a paid /v1/work with no proof is handed back and does not count as a paid work in /v1/stats', async () => {
  Object.assign(X402_CONFIRM, { intervalMs: 1, boundMs: 200 });
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  const payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const hash = x402.blockHash(block);
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block } });
  const chain = new Map(); const calls = [];
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body); calls.push(b.action); let a;
    if (b.action === 'account_info') a = { frontier: FRONTIER, confirmed_frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, block_count: '1' };
    else if (b.action === 'process') { chain.set(hash, b.block); a = { hash }; }
    else if (b.action === 'block_info') a = chain.has(b.hash) ? { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: chain.get(b.hash) } : { error: 'Block not found' };
    else if (b.action === 'work_generate') a = { error: 'work server down' };   // every source fails
    else a = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => a };
  };
  const before = (await handle(request('GET', '/v1/stats', {}))).body.work.paid || 0;
  const res = await handle(request('POST', '/v1/work', { 'payment-signature': header, 'content-type': 'application/json' }, { hash: FRONTIER }));
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.match(res.body.error, /handed back as credit on [0-9A-F]{64}/);
  assert.equal(credits[hash], AMOUNT.toString(), 'the price is back on the settled block hash');
  assert.ok(calls.includes('work_generate'), 'a work source was asked');
  const stats = (await handle(request('GET', '/v1/stats', {}))).body;
  assert.equal(stats.work.paid || 0, before, 'a handed-back call is not a paid work: ' + JSON.stringify(stats.work));
  assert.equal(stats.calls_x402, 0, 'unpay rolled the x402 counter back');
});
