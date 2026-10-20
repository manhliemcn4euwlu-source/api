// node --test  (run from api/). Fabricated blocks, mocked RPC; nothing touches the network.
'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const N = require('nanocurrency');
const x = require('../x402');
const { decodePaymentRequiredHeader, encodePaymentSignatureHeader, decodePaymentResponseHeader } = require('@x402/core/http');
const { PaymentRequiredV2Schema } = require('@x402/core/schemas');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const AMOUNT = 10n ** 27n;
const REQ = x.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, maxTimeoutSeconds: 60 });
const THRESHOLD = 'ff00000000000000'; // low so tests are fast; verify() takes it as a dep
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const BALANCE = 5n * 10n ** 27n; // payer holds 0.005 NANO

let sk, payer, other, work;
before(async () => {
  const seed = await N.generateSeed();
  sk = N.deriveSecretKey(seed, 0);
  payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  other = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(seed, 1)), { useNanoPrefix: true });
  work = await N.computeWork(FRONTIER, { workThreshold: THRESHOLD });
});

function makeBlock(over = {}) {
  const fields = { work, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO, ...over };
  const { block } = N.createBlock(sk, fields);
  block.account = block.account.replace(/^xrb_/, 'nano_');
  return block;
}
const payload = (block, accepted = REQ) => ({ x402Version: 2, accepted, payload: { block } });
const info = (over = {}) => ({ frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, confirmation_height_frontier: FRONTIER, ...over });
const deps = (over = {}) => ({ accountInfo: async () => info(), workThreshold: THRESHOLD, ...over });

test('valid block is accepted and its hash is the block hash', async () => {
  const b = makeBlock();
  const r = await x.verify(payload(b), REQ, deps());
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.payer, payer);
  assert.equal(r.hash, N.hashBlock({ account: payer, previous: FRONTIER, representative: payer, balance: b.balance, link: PAY_TO }));
  assert.equal(r.block.link_as_account, PAY_TO);
});

test('block without link_as_account is accepted (it is derived)', async () => {
  const b = makeBlock(); delete b.link_as_account;
  const r = await x.verify(payload(b), REQ, deps());
  assert.equal(r.ok, true, r.reason);
});

test('wrong previous is rejected', async () => {
  const r = await x.verify(payload(makeBlock()), REQ, deps({ accountInfo: async () => info({ frontier: 'A'.repeat(64), confirmation_height_frontier: 'A'.repeat(64) }) }));
  assert.equal(r.ok, false); assert.match(r.reason, /previous/);
});

test('unconfirmed frontier is rejected', async () => {
  const r = await x.verify(payload(makeBlock()), REQ, deps({ accountInfo: async () => info({ confirmation_height_frontier: 'B'.repeat(64) }) }));
  assert.equal(r.ok, false); assert.match(r.reason, /not confirmed/);
});

test('underpaid balance is rejected', async () => {
  const r = await x.verify(payload(makeBlock({ balance: (BALANCE - 1n).toString() })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /sends 1 raw/);
});

test('block that sends nothing is rejected', async () => {
  const r = await x.verify(payload(makeBlock({ balance: BALANCE.toString() })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /does not send/);
});

test('overpaid balance is rejected (exact amount only)', async () => {
  const r = await x.verify(payload(makeBlock({ balance: (BALANCE - AMOUNT - 1n).toString() })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /exactly/);
});

test('wrong link is rejected', async () => {
  const r = await x.verify(payload(makeBlock({ link: other })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /link/);
});

test('link_as_account claiming payTo while link points elsewhere is rejected', async () => {
  const b = makeBlock({ link: other }); b.link_as_account = PAY_TO;
  const r = await x.verify(payload(b), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /link/);
});

test('bad signature is rejected', async () => {
  const b = makeBlock();
  b.signature = (b.signature[0] === 'A' ? 'B' : 'A') + b.signature.slice(1);
  const r = await x.verify(payload(b), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /signature/);
});

test('tampered balance with the old signature is rejected', async () => {
  const b = makeBlock(); b.balance = (BALANCE - AMOUNT).toString(); // same as signed
  const t = { ...b, balance: (BALANCE - 1n).toString() };
  const r = await x.verify(payload(t), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /signature/);
});

test('work below threshold is rejected', async () => {
  let bad = '0000000000000000';
  while (N.validateWork({ blockHash: FRONTIER, work: bad, threshold: THRESHOLD })) bad = (BigInt('0x' + bad) + 1n).toString(16).padStart(16, '0');
  const r = await x.verify(payload(makeBlock({ work: bad })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /work/);
});

test('accepted requirements must match ours', async () => {
  for (const [k, v] of [['amount', '1'], ['network', 'nano:betanet'], ['scheme', 'upto'], ['payTo', other], ['asset', 'USDC']]) {
    const r = await x.verify(payload(makeBlock(), { ...REQ, [k]: v }), REQ, deps());
    assert.equal(r.ok, false, k); assert.match(r.reason, new RegExp(k === 'payTo' ? 'payTo' : k));
  }
});

test('unopened payer account is rejected', async () => {
  const r = await x.verify(payload(makeBlock()), REQ, deps({ accountInfo: async () => ({ error: 'Account not found' }) }));
  assert.equal(r.ok, false); assert.match(r.reason, /not opened/);
});

test('rpc failure is a clean rejection', async () => {
  const r = await x.verify(payload(makeBlock()), REQ, deps({ accountInfo: async () => { throw new Error('ECONNREFUSED'); } }));
  assert.equal(r.ok, false); assert.match(r.reason, /rpc/);
});

test('already-seen hash is rejected before any rpc', async () => {
  let called = false;
  const r = await x.verify(payload(makeBlock()), REQ, deps({ seen: async () => true, accountInfo: async () => { called = true; return info(); } }));
  assert.equal(r.ok, false); assert.match(r.reason, /already used/); assert.equal(called, false);
});

test('garbage payloads are rejected without throwing', async () => {
  for (const p of [null, {}, { x402Version: 1, scheme: 'exact', network: 'nano', payload: {} }, { x402Version: 2, accepted: REQ, payload: {} }, { x402Version: 2, accepted: REQ, payload: { block: { type: 'state' } } }]) {
    const r = await x.verify(p, REQ, deps());
    assert.equal(r.ok, false);
  }
});

test('settle: process success and failure', async () => {
  const b = makeBlock();
  const ok = await x.settle(b, payer, { process: async blk => { assert.equal(blk, b); return { hash: 'abc' }; } });
  assert.deepEqual(ok, { success: true, network: 'nano:mainnet', transaction: 'ABC', payer });
  const bad = await x.settle(b, payer, { process: async () => ({ error: 'Old block' }) });
  assert.equal(bad.success, false); assert.match(bad.errorReason, /Old block/);
  const thrown = await x.settle(b, payer, { process: async () => { throw new Error('down'); } });
  assert.equal(thrown.success, false); assert.match(thrown.errorReason, /down/);
  const hdr = decodePaymentResponseHeader(x.settleHeader(ok));
  assert.equal(hdr.transaction, 'ABC');
});

// A lost /process reply: the block may be on the node anyway. With deps.hash and deps.landed the outcome is taken
// from the node; without deps.landed the plain failure stands (Ops Control HQ, 2026-09-28).
test('settle: a lost or failed process reply is settled from the node when the block landed', async () => {
  const b = makeBlock();
  const H = 'C'.repeat(64);
  const thrown = await x.settle(b, payer, { hash: H, process: async () => { throw new Error('socket hang up'); }, landed: async h => { assert.equal(h, H); return true; } });
  assert.deepEqual(thrown, { success: true, network: 'nano:mainnet', transaction: H, payer });
  const errored = await x.settle(b, payer, { hash: H, process: async () => ({ error: 'Old block' }), landed: async () => true });
  assert.deepEqual(errored, { success: true, network: 'nano:mainnet', transaction: H, payer });
  assert.equal(decodePaymentResponseHeader(x.settleHeader(thrown)).transaction, H);
});

// "safe" only after a definite rejection from process; when process threw, a block the node does not hold yet may still
// land after the read, and the reason says so instead (PlatinumVera, 2026-09-28 22:30 UTC).
test('settle: landed false says a rebuilt payment is safe after a definite rejection, may still arrive after a thrown process; null says to check the hash first', async () => {
  const b = makeBlock();
  const H = 'D'.repeat(64);
  const no = await x.settle(b, payer, { hash: H, process: async () => ({ error: 'Bad signature' }), landed: async () => false });
  assert.equal(no.success, false); assert.equal(no.transaction, '');
  assert.equal(no.errorReason, 'process rejected the block: Bad signature; the block did not land, a rebuilt payment is safe');
  const notYet = await x.settle(b, payer, { hash: H, process: async () => { throw new Error('down'); }, landed: async () => false });
  assert.equal(notYet.success, false); assert.equal(notYet.transaction, '');
  assert.equal(notYet.errorReason, 'node rpc failed: down; the block is not on the node right now but may still arrive; check hash ' + H + ' before paying again');
  assert.doesNotMatch(notYet.errorReason, /safe/);
  const unknown = await x.settle(b, payer, { hash: H, process: async () => ({ error: 'Gap previous' }), landed: async () => null });
  assert.equal(unknown.success, false);
  assert.equal(unknown.errorReason, 'process rejected the block: Gap previous; the block may have landed, check hash ' + H + ' before paying again');
  const threw = await x.settle(b, payer, { hash: H, process: async () => { throw new Error('down'); }, landed: async () => { throw new Error('node down too'); } });
  assert.equal(threw.success, false); assert.match(threw.errorReason, /may have landed, check hash D{64} before paying again$/);
  const plain = await x.settle(b, payer, { hash: H, process: async () => { throw new Error('down'); } });   // no landed dep: as before
  assert.equal(plain.success, false); assert.equal(plain.errorReason, 'node rpc failed: down');
});

// A resend of a payment whose settle reply was lost: the block is already the payer's frontier. verify() answers ok
// with alreadyLanded when blockInfo shows the landed block sent exactly the amount; seen() still refuses a hash served.
test('verify: a block that is already the frontier is ok with alreadyLanded when it sent the right amount', async () => {
  const b = makeBlock();
  const hash = N.hashBlock({ account: payer, previous: FRONTIER, representative: payer, balance: b.balance, link: PAY_TO });
  const landedInfo = () => info({ frontier: hash, confirmation_height_frontier: hash, balance: (BALANCE - AMOUNT).toString() });
  let asked = null;
  const r = await x.verify(payload(b), REQ, deps({ accountInfo: async () => landedInfo(), blockInfo: async h => { asked = h; return { subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: {} }; } }));
  assert.equal(r.ok, true, r.reason); assert.equal(r.alreadyLanded, true); assert.equal(r.hash, hash); assert.equal(r.payer, payer); assert.equal(asked, hash);
  const wrongAmount = await x.verify(payload(b), REQ, deps({ accountInfo: async () => landedInfo(), blockInfo: async () => ({ subtype: 'send', amount: '1' }) }));
  assert.equal(wrongAmount.ok, false); assert.match(wrongAmount.reason, /sends 1 raw; exactly/);
  const noDep = await x.verify(payload(b), REQ, deps({ accountInfo: async () => landedInfo() }));
  assert.equal(noDep.ok, false); assert.match(noDep.reason, /previous/);
  const served = await x.verify(payload(b), REQ, deps({ accountInfo: async () => landedInfo(), seen: async () => true, blockInfo: async () => ({ subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true' }) }));
  assert.equal(served.ok, false); assert.match(served.reason, /already used/);
  // A stale previous whose block is not on the node: the plain refusal (since 2026-09-30 the block is looked up by hash first).
  const plainStale = await x.verify(payload(b), REQ, deps({ accountInfo: async () => info({ frontier: 'A'.repeat(64), confirmation_height_frontier: 'A'.repeat(64) }), blockInfo: async () => ({ error: 'Block not found' }) }));
  assert.equal(plainStale.ok, false); assert.match(plainStale.reason, /previous/);
});

// The landed block has to be confirmed too, as the frontier must be on the normal path; block_info says so as the string
// 'true' / 'false', and a missing field is not confirmation (Ops Control HQ, 2026-09-28 22:27 UTC).
test('verify: a block that is already the frontier but not confirmed yet is refused with a retry, not served', async () => {
  const b = makeBlock();
  const hash = N.hashBlock({ account: payer, previous: FRONTIER, representative: payer, balance: b.balance, link: PAY_TO });
  const landedInfo = () => info({ frontier: hash, confirmation_height_frontier: hash, balance: (BALANCE - AMOUNT).toString() });
  const r = await x.verify(payload(b), REQ, deps({ accountInfo: async () => landedInfo(), blockInfo: async () => ({ subtype: 'send', amount: AMOUNT.toString(), confirmed: 'false' }) }));
  assert.equal(r.ok, false); assert.match(r.reason, /not confirmed/); assert.equal(r.alreadyLanded, undefined); assert.equal(r.payer, payer);
  const noField = await x.verify(payload(b), REQ, deps({ accountInfo: async () => landedInfo(), blockInfo: async () => ({ subtype: 'send', amount: AMOUNT.toString() }) }));
  assert.equal(noField.ok, false); assert.match(noField.reason, /not confirmed/);
});

test('402 header round-trips through @x402/core and matches the v2 schema', () => {
  const pr = x.paymentRequired({ requirements: REQ, url: 'https://pursekeeper.dev/v1/echo?msg=hi', description: 'echo', error: 'payment required' });
  const back = decodePaymentRequiredHeader(pr.header);
  assert.deepEqual(back, pr.body);
  assert.equal(PaymentRequiredV2Schema.safeParse(back).success, true);
  assert.equal(back.accepts[0].amount, AMOUNT.toString());
  assert.equal(back.accepts[0].asset, 'XNO');
});

test('payment header decoding accepts PAYMENT-SIGNATURE and X-PAYMENT', () => {
  const p = payload(makeBlock());
  const enc = encodePaymentSignatureHeader(p);
  assert.deepEqual(x.decodePayment(x.paymentHeader({ 'payment-signature': enc })).payload, p);
  assert.deepEqual(x.decodePayment(x.paymentHeader({ 'x-payment': enc })).payload, p);
  assert.equal(x.paymentHeader({}), null);
  assert.ok(x.decodePayment('not base64!').error);
});

// Seller-side work: work is not signed, so a block with work "0" (or none) is accepted when a
// workGenerate dep exists; the generated work must validate; without the dep it is rejected.
test('missing work is computed by the seller when workGenerate is given', async () => {
  const b = makeBlock({ work: '0' });
  let asked = null;
  const r = await x.verify(payload(b), REQ, deps({ workGenerate: async h => { asked = h; return work; } }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(asked, FRONTIER);
  assert.equal(r.block.work, work.toLowerCase());
  assert.equal(r.workBy, 'seller');
  assert.equal('work_by' in r.block, false);
  const rc = await x.verify(payload(makeBlock()), REQ, deps({ workGenerate: async () => { throw new Error('must not be called'); } }));
  assert.equal(rc.ok, true, rc.reason); assert.equal(rc.workBy, 'client');
  const b2 = makeBlock(); delete b2.work;
  const r2 = await x.verify(payload(b2), REQ, deps({ workGenerate: async () => work }));
  assert.equal(r2.ok, true, r2.reason);
});

test('missing work without a workGenerate dep is rejected, and a bad source fails cleanly', async () => {
  const r = await x.verify(payload(makeBlock({ work: '0' })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /work/);
  const r2 = await x.verify(payload(makeBlock({ work: '0' })), REQ, deps({ workGenerate: async () => { throw new Error('gpu down'); } }));
  assert.equal(r2.ok, false); assert.match(r2.reason, /gpu down/);
  const r3 = await x.verify(payload(makeBlock({ work: '0' })), REQ, deps({ workGenerate: async () => '0000000000000001' }));
  assert.equal(r3.ok, false); assert.match(r3.reason, /below threshold/);
  // A source that is merely busy (server.js workFor past its paid cap) throws with code work_unavailable; the reason
  // then leads with that code so the 402's `error` is machine-matchable (scheme-proposal#1, kilkelly, 2026-10-17).
  const busy = Object.assign(new Error('4 proofs are being generated already'), { code: 'work_unavailable' });
  const r4 = await x.verify(payload(makeBlock({ work: '0' })), REQ, deps({ workGenerate: async () => { throw busy; } }));
  assert.equal(r4.ok, false); assert.match(r4.reason, /^error_work_unavailable: 4 proofs/);
});

// pyfile-toolkit, 2026-10-05: a workless block at a facilitator with no work source used to fail the shape
// check ("not a Nano state block"); work computed over the new block's own hash used to read as "below the
// send threshold". Both refusals now name what is missing.
test('a workless block without a work source names the field; work for the wrong hash names block.previous', async () => {
  const r = await x.verify(payload(makeBlock({ work: '' })), REQ, deps());
  assert.equal(r.ok, false); assert.match(r.reason, /^block\.work is required here/); assert.match(r.reason, /block\.previous at [0-9a-f]{16}$/);
  const r2 = await x.verify(payload(makeBlock({ work: '0000000000000001' })), REQ, deps());
  assert.equal(r2.ok, false); assert.match(r2.reason, /does not cover block\.previous/); assert.ok(r2.reason.includes(FRONTIER), r2.reason);
});

test('work is only generated after the cheap checks pass', async () => {
  let called = 0;
  const r = await x.verify(payload(makeBlock({ work: '0', balance: '1' })), REQ, deps({ workGenerate: async () => { called++; return work; } }));
  assert.equal(r.ok, false); assert.equal(called, 0);
});

test('requirements can advertise optional work', () => {
  const req = x.requirements({ payTo: PAY_TO, amountRaw: AMOUNT, workOptional: true });
  assert.deepEqual(req.extra, { work: 'optional', workOptional: true, workThreshold: 'fffffff800000000' });
  assert.deepEqual(REQ.extra, { work: 'required', workOptional: false, workThreshold: 'fffffff800000000' });
});

// Since 2026-09-30 the landed block is recognised by its own hash wherever the frontier is: a wallet that appended a later
// block (an auto-receive is enough) before re-presenting had its confirmed payment refused as a stale previous (ARION, 2026-09-29).
test('verify: a landed block is served once after the wallet appended a later block, and refused when it is not on the node', async () => {
  const b = makeBlock();
  const hash = N.hashBlock({ account: payer, previous: FRONTIER, representative: payer, balance: b.balance, link: PAY_TO });
  const later = 'C'.repeat(64);   // an auto-receive after the send: the frontier is neither previous nor the payment
  const movedInfo = () => info({ frontier: later, confirmation_height_frontier: later, balance: (BALANCE - AMOUNT + 7n).toString() });
  let asked = null;
  const r = await x.verify(payload(b), REQ, deps({ accountInfo: async () => movedInfo(), blockInfo: async h => { asked = h; return h === hash ? { subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true', contents: {} } : { error: 'Block not found' }; } }));
  assert.equal(r.ok, true, r.reason); assert.equal(r.alreadyLanded, true); assert.equal(r.hash, hash); assert.equal(asked, hash);
  const unconfirmed = await x.verify(payload(b), REQ, deps({ accountInfo: async () => movedInfo(), blockInfo: async () => ({ subtype: 'send', amount: AMOUNT.toString(), confirmed: 'false' }) }));
  assert.equal(unconfirmed.ok, false); assert.match(unconfirmed.reason, /not confirmed/);
  const notThere = await x.verify(payload(b), REQ, deps({ accountInfo: async () => movedInfo(), blockInfo: async () => ({ error: 'Block not found' }) }));
  assert.equal(notThere.ok, false); assert.match(notThere.reason, /not the account frontier/);
  const served = await x.verify(payload(b), REQ, deps({ accountInfo: async () => movedInfo(), seen: async () => true, blockInfo: async () => ({ subtype: 'send', amount: AMOUNT.toString(), confirmed: 'true' }) }));
  assert.equal(served.ok, false); assert.match(served.reason, /already used/);
});
