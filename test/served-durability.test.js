// node --test (run from api/). The replay cache: a reply served for a payment is kept ten minutes so a client whose reply
// was lost in transit re-presents the same payment for the same method, URL and body and gets the same reply back instead
// of "already used" with the money on chain and nothing delivered. Until 2026-10-23 that cache was a Map in the process,
// and its own comment said so: "Kept in memory only: a restart forgets, and the refusal stands." A service that restarts
// (a deploy, a crash, a node restart) inside those ten minutes turns a lost reply into a permanent loss for the buyer: the
// block is already in credits.json at zero, verify answers "already used", and the reply is gone. This test boots the
// server twice over the same data directory and expects the replay to survive, and expects an entry past the ten minutes
// not to be replayed from disk.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');
const guard = require('./guard-data');

process.env.NANO_RPC = 'http://node.test/rpc';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'served-durability-'));
process.env.SERVED_FILE = path.join(SCRATCH, 'served.json');
const SERVED = process.env.SERVED_FILE;

const boot = () => {
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('api', 'server.js'))) delete require.cache[k];
  return require('../server');
};

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';   // ADDRESS in server.js
const AMOUNT = 10n ** 27n;                                                              // PRICE_RAW in server.js
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const BALANCE = 5n * 10n ** 27n;

function nodeFor(block, hash, payer) {
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    let answer;
    if (b.action === 'account_info') answer = { frontier: hash, confirmed_frontier: hash, balance: (BALANCE - AMOUNT).toString(), representative: payer, block_count: '2' };
    else if (b.action === 'block_info' && b.hash === hash) answer = { block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: block };
    else answer = { error: 'unexpected rpc ' + b.action };
    return { ok: true, json: async () => answer };
  };
}

async function paidBlock() {
  const sk = N.deriveSecretKey(await N.generateSeed(), 0);
  const payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  const block = N.createBlock(sk, { work: '0', previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO }).block;
  block.account = block.account.replace(/^xrb_/, 'nano_');
  const x402 = require('../x402');
  const hash = x402.blockHash(block);
  nodeFor(block, hash, payer);
  return { block, hash, payer };
}

const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

after(() => {
  guard.restore();
  try { for (const n of fs.readdirSync(SCRATCH)) fs.unlinkSync(path.join(SCRATCH, n)); } catch {}
});

test('a reply kept for a lost reply survives a restart: the same payment re-presented is the same 200', async () => {
  const x402 = require('../x402');
  const { block, hash } = await paidBlock();
  const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60, workOptional: true });
  const header = encodePaymentSignatureHeader({ x402Version: 2, accepted: { ...REQ, extra: { ...REQ.extra, session: 'a'.repeat(32) } }, payload: { block } });
  const req = () => ({ method: 'GET', url: '/v1/echo?msg=lost', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '198.51.100.7' } });

  const first = boot();
  const r1 = response();
  assert.equal(await first.chargeX402(req(), r1, header), true, JSON.stringify(r1.body));
  first.send(r1, 200, { echo: 'lost', at: '2026-10-23T20:00:00.000Z' });
  const kept = JSON.parse(fs.readFileSync(SERVED, 'utf8'));
  assert.ok(kept[hash], 'the reply the block bought is on disk, keyed by the block hash');
  assert.equal(kept[hash].code, 200);

  // The service restarts: a new module instance over the same data directory, so credits.json already has the hash at
  // zero and the in-process Map is empty. The buyer re-presents the same payment because the 200 never arrived.
  const second = boot();
  const r2 = response();
  assert.equal(await second.chargeX402(req(), r2, header), false);
  assert.equal(r2.status, 200, 'a restart must not turn a lost reply into "already used": ' + JSON.stringify(r2.body));
  assert.equal(r2.getHeader('x-nano-replay'), 'true');
  assert.equal(r2.getHeader('x-nano-payment-hash'), hash);
  assert.deepEqual(r2.body, { echo: 'lost', at: '2026-10-23T20:00:00.000Z' });
});

test('a bearer reply kept for a lost reply survives a restart too', async () => {
  const { server, credits, loadPurposes } = boot();
  await loadPurposes();
  const h = 'AB'.repeat(32);
  const payer = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.action === 'block_info' && b.hash === h)
      return { ok: true, json: async () => ({ block_account: payer, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', height: '3', local_timestamp: '1758000000', contents: { link_as_account: PAY_TO } }) };
    if (b.action === 'account_history')
      return { ok: true, json: async () => ({ history: [{ hash: h, type: 'send', account: PAY_TO, local_timestamp: '1758000000' }] }) };
    return { ok: true, json: async () => ({ error: 'unexpected rpc ' + b.action }) };
  };
  const call = (msg) => ({ method: 'GET', url: '/v1/echo?msg=' + msg, headers: { host: 'pursekeeper.dev', 'x-nano-payment': h }, socket: { remoteAddress: '198.51.100.8' } });
  const r1 = response();
  await server.listeners('request')[0](call('bearer'), r1);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(credits[h], '0', 'the credit is spent, so only the replay can answer the same call again');

  const second = boot();
  await second.loadPurposes();
  second.credits[h] = '0';   // what credits.json holds after the restart: the block is spent, only its reply can answer
  const r2 = response();
  await second.server.listeners('request')[0](call('bearer'), r2);
  assert.equal(r2.status, 200, 'a restart must not lose the reply a spent hash bought: ' + JSON.stringify(r2.body));
  assert.equal(r2.getHeader('x-nano-replay'), 'true');
  assert.equal(r2.body.echo, 'bearer');
});

test('an entry past the ten minutes is not replayed from disk', async () => {
  const old = 'CD'.repeat(32);
  const body = JSON.stringify({ echo: 'stale' });
  const emptyBody = require('node:crypto').createHash('sha256').update('').digest('hex');
  fs.writeFileSync(SERVED, JSON.stringify({ [old]: { key: 'GET /v1/echo?msg=stale ' + emptyBody, code: 200, body, type: 'application/json', headers: {}, at: Date.now() - 11 * 60_000, bind: { bearer: true } } }));
  const { server } = boot();
  const r = response();
  await server.listeners('request')[0]({ method: 'GET', url: '/v1/echo?msg=stale', headers: { host: 'pursekeeper.dev', 'x-nano-payment': old }, socket: { remoteAddress: '198.51.100.9' } }, r);
  assert.notEqual(r.status, 200, 'the ten minutes are the ten minutes, across a restart as within one');
  assert.equal(r.getHeader('x-nano-replay'), undefined);
});
