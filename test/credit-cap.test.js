// node --test (run from api/). README promises: "Overpayment stays as credit on that hash, capped at 1 NANO per hash".
// The code did not cap: a send above 1 NANO was refused whole, so the payer's money sat on chain and the ledger held
// nothing. This test states the documented contract against the exported request listener with a mocked node.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
// npm test runs in the directory the service runs from, so the live ledger is on disk here. Every write under data/ is
// dropped before server.js is required, the guard test/charge-x402.test.js uses. The guard covers the atomic store too: it
// writes a temp file with openSync and renames it over the destination, so guarding writeFileSync alone would let an empty
// temp file replace the live ledger. The in-memory credits map is what the assertions read.
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'credit-cap-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { server, credits, loadPurposes } = require('../server');
// The purpose registry gates bearer credit; the server loads it before listening, so the test does the same.
const ready = loadPurposes();

const TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FROM = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
const BIG = 'CD'.repeat(32);
const CAP = 10n ** 30n;
const OVERPAY = 2n * CAP;   // 2 NANO: above the documented 1 NANO cap, not a tranche

globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  let a;
  if (b.action === 'block_info' && b.hash === BIG) {
    a = { block_account: FROM, subtype: 'send', amount: OVERPAY.toString(), confirmed: 'true', height: '3',
      local_timestamp: '1758000000', contents: { link_as_account: TO } };
  } else if (b.action === 'account_history') {
    a = { history: [{ hash: BIG, type: 'send', account: TO, local_timestamp: '1758000000' }] };
  } else {
    a = { error: 'unexpected rpc ' + b.action };
  }
  return { ok: true, json: async () => a };
};

async function get(pathqs) {
  const res = { headers: {}, status: null, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  const handlers = server.listeners('request');
  await handlers[handlers.length - 1]({ url: pathqs, method: 'GET',
    headers: { host: 'pursekeeper.dev', 'x-nano-payment': BIG }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

test('a 2 NANO send is credited at the documented 1 NANO cap, and the reply names the excess', async () => {
  await ready;
  const r = await get('/v1/credit?hash=' + BIG);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.error, undefined, 'a send above the cap must not be refused whole: ' + JSON.stringify(r.body));
  // The credit is the documented 1 NANO ceiling, not the 2 NANO that was sent: the excess is named, never applied.
  assert.equal(r.body.remaining_raw, CAP.toString(), 'the documented cap is 1 NANO');
  assert.equal(r.body.remaining_nano, '1');
  assert.equal(r.body.capped, true);
  assert.equal(r.body.amount_raw, OVERPAY.toString());
  assert.equal(r.body.excess_raw, CAP.toString(), 'the reply names what was not applied');
  assert.equal(credits[BIG], CAP.toString(), 'the ledger holds the cap');
});

test('the capped credit is spendable, and the excess is not', async () => {
  await ready;
  assert.equal(credits[BIG], CAP.toString(), 'the ledger holds the cap, not the 2 NANO send');
  const r = await get('/v1/echo?msg=hi');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.echo, 'hi');
  // One call costs 0.001 NANO: the capped credit pays for it and the remainder is exact.
  assert.equal(r.headers['x-nano-credit-remaining-raw'], (CAP - 10n ** 27n).toString());
});
