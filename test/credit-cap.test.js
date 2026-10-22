// node --test (run from api/). README promises: "Overpayment stays as credit on that hash, capped at 1 NANO per hash".
// The code does not cap: a send above 1 NANO is refused whole, so the payer's money is on chain and the ledger holds
// nothing. This test states the documented contract against the exported request listener with a mocked node.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
// The server writes its money files under data/ at require time, so the ledger is read from whatever is on disk. This
// file must never touch the live ledger: it uses its own hash and removes that key afterwards. Every write goes through
// the real file, so the assertions below read the same bytes the server does.
const DATA_DIR = path.join(__dirname, '..', 'data');
const { server, credits, loadPurposes } = require('../server');
const cleanup = () => {
  const f = path.join(DATA_DIR, 'credits.json');
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    let changed = false;
    for (const k of Object.keys(d)) if (k.startsWith('CDCD')) { delete d[k]; changed = true; }
    if (changed) fs.writeFileSync(f, JSON.stringify(d));
  } catch { /* nothing to clean */ }
  try {
    const a = path.join(DATA_DIR, 'credit-accounts.json');
    const d = JSON.parse(fs.readFileSync(a, 'utf8'));
    let changed = false;
    for (const k of Object.keys(d)) if (k.startsWith('CDCD')) { delete d[k]; changed = true; }
    if (changed) fs.writeFileSync(a, JSON.stringify(d));
  } catch { /* nothing to clean */ }
};
after(cleanup);
// The purpose registry gates bearer credit; the server loads it before listening, so the test does the same.
const ready = loadPurposes();

const TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FROM = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
const BIG = 'CD'.repeat(32);
const OVERPAY = (2n * 10n ** 30n).toString();   // 2 NANO: above the documented 1 NANO cap, not a tranche

globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  let a;
  if (b.action === 'block_info' && b.hash === BIG) {
    a = { block_account: FROM, subtype: 'send', amount: OVERPAY, confirmed: 'true', height: '3',
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

test('a 2 NANO send is credited at the documented 1 NANO cap, not refused', async () => {
  await ready;
  console.error('DEBUG before call ledger=', credits[BIG], 'cap=', (10n ** 30n).toString());
  const r = await get('/v1/credit?hash=' + BIG);
  console.error('DEBUG body=', JSON.stringify(r.body), 'ledger=', credits[BIG], 'status=', r.status);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.error, undefined, 'a send above the cap must not be refused whole: ' + JSON.stringify(r.body));
  // The credit is the documented 1 NANO ceiling, not the 2 NANO that was sent: the excess is named, never applied.
  assert.equal(r.body.remaining_raw, (10n ** 30n).toString(), 'the documented cap is 1 NANO');
  assert.equal(r.body.remaining_nano, '1');
  assert.equal(credits[BIG], (10n ** 30n).toString(), 'the ledger holds the cap');
  assert.ok(BigInt(r.body.remaining_raw) < BigInt(OVERPAY), 'the 2 NANO send is not credited whole');
});

test('the capped credit is spendable, and the excess is not', async () => {
  assert.equal(credits[BIG], (10n ** 30n).toString(), 'the ledger holds the cap, not the 2 NANO send');
  const r = await get('/v1/echo?msg=hi');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.echo, 'hi');
  // One call costs 0.001 NANO: the capped credit pays for it and the remainder is exact.
  assert.equal(r.headers['x-nano-credit-remaining-raw'], (10n ** 30n - 10n ** 27n).toString());
});
