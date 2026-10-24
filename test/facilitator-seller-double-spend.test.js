'use strict';
// node --test (run from api/). Cross-path double-spend and exclusion checks between the facilitator
// (/facilitator/settle) and the seller paths (chargeX402 and X-Nano-Payment / creditFor).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const N = require('nanocurrency');
const { encodePaymentSignatureHeader } = require('@x402/core/http');

process.env.NANO_RPC = 'http://node.test/rpc';
const TMP_BROADCAST = path.join(os.tmpdir(), 'pk-fac-seller-broadcast-' + process.pid + '.json');
process.env.BROADCAST_FILE = TMP_BROADCAST;
const guard = require('./guard-data');

const f = require('../facilitator');
const purposes = require('../purposes');
const { chargeX402, creditFor, loadPurposes, credits } = require('../server');
const x402 = require('../x402');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const AMOUNT = 10n ** 27n;
const REQ = x402.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 5, workOptional: true });
const FAC_REQ = { scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', payTo: PAY_TO, amount: AMOUNT.toString(), maxTimeoutSeconds: 5 };
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const WORK = '02d156dc7f9d5f45';
const BALANCE = 5n * 10n ** 27n;

let origSources, tmpDir, manualFile;
let sk1, payer1, sk2, payer2, sk3, payer3;
const chain = new Map();
const frontiers = new Map();
const timestamps = new Map();

before(async () => {
  for (const k of Object.keys(credits)) delete credits[k];
  sk1 = N.deriveSecretKey(await N.generateSeed(), 0);
  payer1 = N.deriveAddress(N.derivePublicKey(sk1), { useNanoPrefix: true });
  sk2 = N.deriveSecretKey(await N.generateSeed(), 0);
  payer2 = N.deriveAddress(N.derivePublicKey(sk2), { useNanoPrefix: true });
  sk3 = N.deriveSecretKey(await N.generateSeed(), 0);
  payer3 = N.deriveAddress(N.derivePublicKey(sk3), { useNanoPrefix: true });

  for (const p of [payer1, payer2, payer3]) frontiers.set(p, FRONTIER);

  globalThis.fetch = async (_url, opts) => {
    const b = JSON.parse(opts.body);
    if (b.action === 'account_info') {
      const fr = frontiers.get(b.account) || FRONTIER;
      const bal = fr === FRONTIER ? BALANCE.toString() : (BALANCE - AMOUNT).toString();
      return { ok: true, json: async () => ({ frontier: fr, confirmed_frontier: fr, confirmation_height_frontier: fr, balance: bal, representative: b.account, block_count: '2' }) };
    }
    if (b.action === 'process') {
      const h = x402.blockHash(b.block);
      chain.set(h, b.block);
      frontiers.set(b.block.account, h);
      return { ok: true, json: async () => ({ hash: h }) };
    }
    if (b.action === 'block_info') {
      const blk = chain.get(b.hash);
      if (!blk) return { ok: true, json: async () => ({ error: 'Block not found' }) };
      const ts = timestamps.has(b.hash) ? String(timestamps.get(b.hash)) : String(Math.floor(Date.now() / 1000) - 120);
      return { ok: true, json: async () => ({ block_account: blk.account, subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', local_timestamp: ts, contents: { ...blk, link_as_account: PAY_TO } }) };
    }
    if (b.action === 'account_history') {
      const blk = chain.get(b.head);
      if (!blk) return { ok: true, json: async () => ({ history: [] }) };
      const ts = timestamps.has(b.head) ? String(timestamps.get(b.head)) : String(Math.floor(Date.now() / 1000) - 120);
      return { ok: true, json: async () => ({ history: [{ type: 'send', account: PAY_TO, amount: AMOUNT.toString(), hash: b.head, local_timestamp: ts }] }) };
    }
    return { ok: true, json: async () => ({ error: 'unexpected rpc ' + b.action }) };
  };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-purposes-test-'));
  manualFile = path.join(tmpDir, 'purposes.json');
  fs.writeFileSync(manualFile, JSON.stringify({ hashes: {}, accounts: {} }));
  origSources = { ...purposes.SOURCES };
  const absent = path.join(tmpDir, 'absent.json');
  for (const k of Object.keys(purposes.SOURCES)) purposes.SOURCES[k] = absent;
  purposes.SOURCES.manual = manualFile;
  await loadPurposes();
});

after(() => {
  if (origSources) Object.assign(purposes.SOURCES, origSources);
  guard.restore();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TMP_BROADCAST, { force: true }); } catch {}
});

function makeBlock(sk, payer, rep = payer) {
  const { block } = N.createBlock(sk, { work: WORK, previous: FRONTIER, representative: rep, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  return block;
}

const request = header => ({ method: 'GET', url: '/v1/echo?msg=hi', headers: { host: 'pursekeeper.dev', 'payment-signature': header }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, status: null, body: null,
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
  writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } });

test('a block settled through /facilitator/settle cannot also buy a call on chargeX402 or be credited on X-Nano-Payment', async () => {
  f.broadcast.clear();
  const blk = makeBlock(sk1, payer1);
  const h = x402.blockHash(blk);
  const facBody = { x402Version: 2, paymentPayload: { x402Version: 2, accepted: FAC_REQ, payload: { block: blk } }, paymentRequirements: FAC_REQ };
  const rpc = async q => (await globalThis.fetch('http://node.test/rpc', { body: JSON.stringify(q) })).json();
  const hdr = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: blk } });
  const rSeller = response();

  // Race /facilitator/settle (queued first on the shared hash lock) and chargeX402 on the same block.
  const [facRes, sellerOk] = await Promise.all([
    f.settleRequest(facBody, { rpc, sleep: async () => {} }),
    chargeX402(request(hdr), rSeller, hdr),
  ]);
  assert.equal(facRes.success, true, JSON.stringify(facRes));
  assert.equal(facRes.transaction, h);
  assert.equal(sellerOk, false, 'chargeX402 must not serve a second time on a block settled by the facilitator');
  assert.equal(rSeller.status, 402);
  assert.match(rSeller.body.error, /facilitator/);

  // Presenting the facilitator-settled hash on the bearer path (/v1/credit / X-Nano-Payment) is refused too.
  const c = await creditFor(h);
  assert.ok(c.error, 'creditFor must refuse a hash settled through the facilitator');
  assert.match(c.error, /facilitator/);
  assert.equal(credits[h], undefined);
});

test('alreadyLanded x402 blocks respect purposeReg hash/account exclusions and NOT_BEFORE', async () => {
  // 1. Excluded hash (e.g. a ladder stake or manual exclusion) already confirmed on the chain.
  const bStake = makeBlock(sk2, payer2, payer2);
  const hStake = x402.blockHash(bStake);
  chain.set(hStake, bStake);
  frontiers.set(payer2, hStake);

  // 2. Excluded payer account (e.g. an own/funding account) with a confirmed block on the chain.
  const bOwn = makeBlock(sk3, payer3, payer3);
  const hOwn = x402.blockHash(bOwn);
  chain.set(hOwn, bOwn);
  frontiers.set(payer3, hOwn);

  fs.writeFileSync(manualFile, JSON.stringify({
    hashes: { [hStake]: 'this send is a forecast-ladder stake' },
    accounts: { [payer3]: 'this send came from one of pursekeeper\'s own accounts' },
  }));
  await loadPurposes();

  const rStake = response();
  const hdrStake = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: bStake } });
  assert.equal(await chargeX402(request(hdrStake), rStake, hdrStake), false);
  assert.equal(rStake.status, 402);
  assert.match(rStake.body.error, /forecast-ladder stake/);

  const rOwn = response();
  const hdrOwn = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: bOwn } });
  assert.equal(await chargeX402(request(hdrOwn), rOwn, hdrOwn), false);
  assert.equal(rOwn.status, 402);
  assert.match(rOwn.body.error, /own accounts/);

  // 3. A landed block whose local_timestamp predates NOT_BEFORE is refused on alreadyLanded too.
  const bOld = makeBlock(sk2, payer2, PAY_TO);
  const hOld = x402.blockHash(bOld);
  chain.set(hOld, bOld);
  frontiers.set(payer2, hOld);
  timestamps.set(hOld, 1700000000);   // before NOT_BEFORE (1757210000)

  const rOld = response();
  const hdrOld = encodePaymentSignatureHeader({ x402Version: 2, accepted: REQ, payload: { block: bOld } });
  assert.equal(await chargeX402(request(hdrOld), rOld, hdrOld), false);
  assert.equal(rOld.status, 402);
  assert.match(rOld.body.error, /predates this service/);
});
