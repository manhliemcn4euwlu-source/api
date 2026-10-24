// node --test  (run from api/). Facilitator request handlers with a mocked node.
'use strict';
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.BROADCAST_FILE = path.join(require("node:os").tmpdir(), "pursekeeper-broadcast-test-" + process.pid + ".json");   // the own-broadcast memory is on disk since 2026-09-30; tests keep it out of data/
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'facilitator-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const N = require('nanocurrency');
const f = require('../facilitator');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const AMOUNT = 10n ** 27n;
const REQ = { scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', payTo: PAY_TO, amount: AMOUNT.toString(), maxTimeoutSeconds: 5 };
const THRESHOLD = 'ff00000000000000';
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
const BALANCE = 5n * 10n ** 27n;

let sk, payer, work;
before(async () => {
  const seed = await N.generateSeed();
  sk = N.deriveSecretKey(seed, 0);
  payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  work = await N.computeWork(FRONTIER, { workThreshold: THRESHOLD });
});
// Every test builds the same block (same seed, previous, balance, link), so the hash repeats across tests: the facilitator's
// own-broadcast memory is module state and is cleared before each test.
beforeEach(() => f.broadcast.clear());
function makeBlock(over = {}) {
  const { block } = N.createBlock(sk, { work, previous: FRONTIER, representative: payer, balance: (BALANCE - AMOUNT).toString(), link: PAY_TO, ...over });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  return block;
}
const body = (block, req = REQ) => ({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: req, payload: { block } }, paymentRequirements: req });
const info = (over = {}) => ({ frontier: FRONTIER, balance: BALANCE.toString(), representative: payer, confirmation_height_frontier: FRONTIER, ...over });

// A node that knows one account, has no blocks yet, and confirms whatever it processes.
function node(over = {}) {
  const chain = new Map();
  const rpc = async b => {
    if (b.action === 'account_info') return over.info ? over.info() : info();
    if (b.action === 'block_info') { const x = chain.get(b.hash); return x ? { block_account: payer, subtype: 'send', amount: (BALANCE - BigInt(x.balance)).toString(), confirmed: over.confirm === false ? 'false' : 'true', contents: x } : { error: 'Block not found' }; }
    if (b.action === 'process') { if (over.processError) return { error: over.processError }; const h = N.hashBlock({ account: b.block.account, previous: b.block.previous, representative: b.block.representative, balance: b.block.balance, link: b.block.link }); chain.set(h, b.block); return { hash: h }; }
    throw new Error('unexpected rpc ' + b.action);
  };
  rpc.chain = chain;
  return rpc;
}
const deps = (rpc, over = {}) => ({ rpc, workThreshold: THRESHOLD, sleep: async () => {}, ...over });

test('/supported lists exact on nano:mainnet, v2, work required, workOptional false', () => {
  assert.deepEqual(f.SUPPORTED.kinds.map(k => [k.x402Version, k.scheme, k.network, k.extra.work, k.extra.workOptional]), [[2, 'exact', 'nano:mainnet', 'required', false]]);
});

test('verify: a valid block is valid and names the payer', async () => {
  const r = await f.verifyRequest(body(makeBlock()), deps(node()));
  assert.equal(r.isValid, true, r.detail); assert.equal(r.payer, payer);
});

test('verify: frontier moved -> frontier_moved', async () => {
  const r = await f.verifyRequest(body(makeBlock()), deps(node({ info: () => info({ frontier: 'AA'.repeat(32), confirmation_height_frontier: 'AA'.repeat(32) }) })));
  assert.equal(r.isValid, false); assert.equal(r.invalidReason, 'frontier_moved');
});

test('verify: underpayment -> amount_mismatch', async () => {
  const r = await f.verifyRequest(body(makeBlock({ balance: (BALANCE - AMOUNT + 1n).toString() })), deps(node()));
  assert.equal(r.invalidReason, 'amount_mismatch');
});

test('verify: bad work -> invalid_work', async () => {
  const r = await f.verifyRequest(body(makeBlock({ work: '0000000000000000' })), deps(node()));
  assert.equal(r.invalidReason, 'invalid_work');
});

test('verify: block already on the chain -> block_already_exists (check 9)', async () => {
  const n = node();
  const b = makeBlock();
  await n({ action: 'process', block: b });
  const r = await f.verifyRequest(body(b), deps(n));
  assert.equal(r.invalidReason, 'block_already_exists');
});

test('verify: a confirmed block on the chain that sends 1 raw, presented at the full price -> amount_mismatch, not block_already_exists (check 10, x402#3432)', async () => {
  const n = node();
  const b = makeBlock({ balance: (BALANCE - 1n).toString() });   // a real 1-raw send, landed and confirmed
  await n({ action: 'process', block: b });
  const r = await f.verifyRequest(body(b), deps(n));
  assert.equal(r.isValid, false);
  assert.equal(r.invalidReason, 'amount_mismatch', r.detail);
  assert.match(r.detail, /sends 1 raw; exactly 1000000000000000000000000000 raw required/);
  const s = await f.settleRequest(body(b), deps(n));
  assert.equal(s.success, false); assert.equal(s.errorReason, 'amount_mismatch'); assert.equal(s.transaction, '');
  assert.equal([...n.chain.keys()].length, 1, 'nothing else was broadcast');
});

test('verify: a block on the chain that is not a send -> amount_mismatch (check 10 subtype clause)', async () => {
  const n = node();
  const b = makeBlock();
  await n({ action: 'process', block: b });
  const rpc = async q => { const a = await n(q); if (q.action === 'block_info' && !a.error) return { ...a, subtype: 'receive' }; return a; };
  const r = await f.verifyRequest(body(b), deps(rpc));
  assert.equal(r.invalidReason, 'amount_mismatch'); assert.match(r.detail, /subtype receive/);
});

test('verify: a block on the chain with the right amount is still block_already_exists (check 10 order: amount first, then confirmation)', async () => {
  const n = node();
  const b = makeBlock();
  await n({ action: 'process', block: b });
  const r = await f.verifyRequest(body(b), deps(n));
  assert.equal(r.invalidReason, 'block_already_exists');
});

test('verify: requirements for another network or scheme are refused before any rpc', async () => {
  const r = await f.verifyRequest(body(makeBlock(), { ...REQ, network: 'base' }), deps(async () => { throw new Error('rpc must not be called'); }));
  assert.equal(r.invalidReason, 'requirements_unsupported');
  const r2 = await f.verifyRequest(body(makeBlock(), { ...REQ, scheme: 'upto' }), deps(async () => { throw new Error('rpc must not be called'); }));
  assert.equal(r2.invalidReason, 'requirements_unsupported');
});

test('verify: payload accepted != requirements -> requirements_mismatch', async () => {
  const b = body(makeBlock());
  b.paymentPayload.accepted = { ...REQ, amount: '1' };
  const r = await f.verifyRequest(b, deps(node()));
  assert.equal(r.invalidReason, 'requirements_mismatch');
});

test('verify: node down -> node_unavailable', async () => {
  const r = await f.verifyRequest(body(makeBlock()), deps(async b => { if (b.action === 'block_info') return { error: 'Block not found' }; throw new Error('ECONNREFUSED'); }));
  assert.equal(r.invalidReason, 'node_unavailable');
});

test('settle: processes, polls, returns the confirmed hash', async () => {
  const n = node();
  const r = await f.settleRequest(body(makeBlock()), deps(n));
  assert.equal(r.success, true, r.detail);
  assert.equal(r.network, 'nano:mainnet'); assert.equal(r.payer, payer);
  assert.ok(n.chain.has(r.transaction));
});

test('settle: process error -> process_failed with the node text', async () => {
  const r = await f.settleRequest(body(makeBlock()), deps(node({ processError: 'Gap previous block' })));
  assert.equal(r.success, false); assert.equal(r.errorReason, 'process_failed'); assert.match(r.detail, /Gap previous/);
});

test('settle: processed but never confirmed -> confirmation_timeout with the hash', async () => {
  const n = node({ confirm: false });
  let t = 0;
  const r = await f.settleRequest(body(makeBlock(), { ...REQ, maxTimeoutSeconds: 1 }), deps(n, { sleep: async ms => { t += ms; } }));
  assert.equal(r.success, false); assert.equal(r.errorReason, 'confirmation_timeout'); assert.ok(n.chain.has(r.transaction));
});

test('settle: a second settle of the same block is refused', async () => {
  const n = node();
  const b = makeBlock();
  const r1 = await f.settleRequest(body(b), deps(n));
  assert.equal(r1.success, true);
  const r2 = await f.settleRequest(body(b), deps(n));
  assert.equal(r2.success, false); assert.equal(r2.errorReason, 'block_already_exists');
  assert.equal(r2.transaction, r1.transaction, 'the replay names the settled hash'); assert.match(r2.detail, /answered success at/);
  assert.equal(r2.errorMessage, r2.detail, 'errorMessage carries the same text as detail (x402 SettleResponse name)');
});

test('settle: two concurrent settles of the same block yield one success and one refusal, and one process call', async () => {
  // Before the per-hash lock both passed verify's seen() check (the reservation was made only after verify's node reads
  // returned) and both broadcast; serialised, the second sees the first's block on the chain (2026-09-29).
  const n = node();
  let processes = 0;
  const rpc = async b => { if (b.action === 'process') processes++; return n(b); };
  const b = makeBlock();
  const [r1, r2] = await Promise.all([f.settleRequest(body(b), deps(rpc)), f.settleRequest(body(b), deps(rpc))]);
  const ok = [r1, r2].filter(r => r.success), bad = [r1, r2].filter(r => !r.success);
  assert.equal(ok.length, 1, JSON.stringify([r1, r2]));
  assert.equal(bad[0].errorReason, 'block_already_exists');
  assert.equal(processes, 1, 'one block, one broadcast');
  assert.ok(n.chain.has(ok[0].transaction));
});

test('settle: an in-flight hash is refused while settling', async () => {
  const settling = new Set();
  const b = makeBlock();
  const h = N.hashBlock({ account: payer, previous: FRONTIER, representative: payer, balance: b.balance, link: PAY_TO });
  settling.add(h);
  const r = await f.verifyRequest(body(b), deps(node(), { settling }));
  assert.equal(r.invalidReason, 'block_already_exists');
});

// Dalton's docs QA, 2026-09-10: C1 and C2 (research/2026-09-10-dalton-nanogpt-guide-and-facilitator-docs-qa.md)
test('verify: a v1 envelope -> unsupported_x402_version, not invalid_block (C1)', async () => {
  const b = body(makeBlock()); b.paymentPayload.x402Version = 1;
  const r = await f.verifyRequest(b, deps(node()));
  assert.equal(r.isValid, false); assert.equal(r.invalidReason, 'unsupported_x402_version'); assert.equal(r.payer, '');
});

// Ops Control HQ page-extract, 2026-10-18: a 402 whose resource.serviceName has 34 characters is echoed into the payload by
// every client and fails @x402/core's ResourceInfo cap (32); the refusal names the field instead of pointing at the block.
test('verify: resource.serviceName over 32 characters -> invalid_block with the field named', async () => {
  const b = body(makeBlock()); b.paymentPayload.resource = { url: 'https://example.com/v1/x', serviceName: 'Ops Control HQ Nano Page Extraction' };
  const r = await f.verifyRequest(b, deps(node()));
  assert.equal(r.isValid, false); assert.equal(r.invalidReason, 'invalid_block');
  assert.match(r.invalidMessage, /resource\.serviceName: .*32/);
});

test('verify: accepted.payTo differs from requirements.payTo -> invalid_payto (C2, documented as such)', async () => {
  const other = { ...REQ, payTo: 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp' };
  const b = body(makeBlock()); b.paymentPayload.accepted = other;
  const r = await f.verifyRequest(b, deps(node()));
  assert.equal(r.isValid, false); assert.equal(r.invalidReason, 'invalid_payto');
});

// Oversized bodies (pyfile-toolkit, 2026-09-11): until then readBody destroyed the socket at the
// limit, so the documented 400 never reached the client (dropped connection, or 502 via the proxy).
test('a body over 32,000 bytes is answered 400 "body too large" with Connection: close, not a dropped socket', async () => {
  const { PassThrough } = require('node:stream');
  const req = new PassThrough(); req.headers = { host: f.HOST }; req.method = 'POST'; req.socket = { remoteAddress: '203.0.113.9' };
  let destroyed = false; req.destroy = () => { destroyed = true; };
  const headers = {}; let out;
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  const send = (_res, status, body) => { out = { status, body }; };
  const p = f.handle(req, res, { pathname: '/verify' }, send, deps(node()));
  req.write(Buffer.from('{"paymentPayload":"' + 'x'.repeat(40_000) + '"}')); req.end();
  assert.equal(await p, true);
  assert.equal(out.status, 400);
  assert.match(out.body.error, /body too large: over 32,000 bytes/);
  assert.equal(headers.connection, 'close');
  assert.equal(destroyed, false, 'the socket must stay open until the answer is written');
});
test('a body under the limit is parsed as before', async () => {
  const { PassThrough } = require('node:stream');
  const req = new PassThrough(); req.headers = { host: f.HOST }; req.method = 'POST'; req.socket = { remoteAddress: '203.0.113.10' };
  let out; const send = (_res, status, body) => { out = { status, body }; };
  const p = f.handle(req, { setHeader() {} }, { pathname: '/verify' }, send, deps(node()));
  req.write(Buffer.from(JSON.stringify({ paymentPayload: 'x'.repeat(30_000), paymentRequirements: {} }))); req.end();
  await p;
  assert.equal(out.status, 200);
  assert.equal(out.body.invalidReason, 'requirements_unsupported');
});

// llmrt, 2026-10-23: the facilitator's limiter pushed the timestamp of a refused call into the window, so a client that
// retried at the rate it was refused stayed over the limit, and the 429 carried no Retry-After. Measured on
// facilitator.pursekeeper.dev: 130 concurrent /verify calls from one host answered 400 x120 then 429 x10, none with
// Retry-After, while pursekeeper.dev's own free routes answer 429 with Retry-After since 2026-10-23.
test('a refused verify call does not extend the window, and the 429 says when to come back', async () => {
  const { PassThrough } = require('node:stream');
  const ip = '203.0.113.44';
  let out, headers;
  async function post() {
    const req = new PassThrough(); req.headers = { host: f.HOST }; req.method = 'POST'; req.socket = { remoteAddress: ip };
    headers = {};
    const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
    out = null;
    const send = (_res, status, body) => { out = { status, body }; };
    const p = f.handle(req, res, { pathname: '/verify' }, send, deps(node()));
    req.write(Buffer.from('{}')); req.end();
    await p;
    return out;
  }
  // 120 served calls use the minute's allowance (LIMITS.verify).
  for (let i = 0; i < 120; i++) assert.equal((await post()).status, 400, 'call ' + (i + 1) + ' is served');
  const over = await post();
  assert.equal(over.status, 429);
  const ra = Number(headers['retry-after']);
  assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, 'a 429 must say when the window clears, got ' + JSON.stringify(headers['retry-after']));
  // The refused call must not push the window forward: the answer stays 429 with a Retry-After that does not grow past 60 s,
  // and the window still clears when the 120 served calls age out.
  const again = await post();
  assert.equal(again.status, 429);
  const ra2 = Number(headers['retry-after']);
  assert.ok(ra2 >= 1 && ra2 <= 60, 'the second refusal still names the window, got ' + ra2);
  assert.ok(ra2 <= ra, 'a refused call must not extend the window (was ' + ra + ' s, then ' + ra2 + ' s)');
});

test('rollup: totals, one row per payTo, per-payer counts, verify-only payTos included', () => {
  const A = 'nano_1zqdw3qf1z8k3jx8jintaiwpo3yz7zqh1me4ph5j439ts8hsppx8dzy4xcsz', B = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
  const P1 = 'nano_1i3y944esngqw6wb6ia68dotj4yuqctch9kx8ct65twt8ewi4rdcfgax7ggf', P2 = 'nano_3uojbn47b5xqcbs4yibbasamn8aeyqxgyi1z8peogwtdn6z3kagjanjpz4ss';
  const s = { since: 't0', verify: 5, verify_ok: 3, settle: 4, settle_ok: 3, ips: { a: 1, b: 2 },
    settled: [{ hash: 'H1', payer: P1, pay_to: A, amount_raw: '1000', at: '2026-09-11T00:00:00Z' }, { hash: 'H2', payer: P2, pay_to: A, amount_raw: '2000', at: '2026-09-12T00:00:00Z' }, { hash: 'H3', payer: P1, pay_to: B, amount_raw: '5', at: '2026-09-13T00:00:00Z' }],
    pay_to: { [A]: { verify: 2, verify_ok: 2, settle: 1, settle_ok: 1, first: 'x', last: 'y' }, nano_3untmgdrmee8dbghrk88pdij8kpuiqpfyben6gwgzerjwc44fbj4g847qhe4: { verify: 1, verify_ok: 0, settle: 0, settle_ok: 0, first: 'v', last: 'v' } }, pay_to_since: 'ts' };
  const r = f.rollup(s);
  assert.equal(r.settled_count, 3); assert.equal(r.settled_amount_raw, '3005');
  assert.equal(r.distinct_pay_to, 3); assert.equal(r.distinct_pay_to_settled, 2); assert.equal(r.distinct_payers, 2); assert.equal(r.distinct_ips, 2);
  assert.deepEqual(r.sellers.map(x => [x.pay_to, x.settled, x.amount_raw, x.payers, x.verify]), [[A, 2, '3000', 2, 2], [B, 1, '5', 1, 0], ['nano_3untmgdrmee8dbghrk88pdij8kpuiqpfyben6gwgzerjwc44fbj4g847qhe4', 0, '0', 0, 1]]);
  assert.deepEqual(r.payers, [{ payer: P1, settled: 2, amount_raw: '1005' }, { payer: P2, settled: 1, amount_raw: '2000' }]);
  assert.equal(r.pay_to_counters_since, 'ts');
  assert.ok(!('ips' in r), 'hashed ips never leave');
});

// Item 5, 2026-09-29: a process reply lost after the node accepted the block (Enrico / Practical Automation Lab; pyfile-toolkit
// second), and a retry of the facilitator's own broadcast after confirmation_timeout (uknwplayer).
test('settle: process records the block then throws -> settled from the node view, success with the hash (A)', async () => {
  const n = node();
  let processes = 0;
  const rpc = async b => { if (b.action === 'process') { processes++; await n(b); throw new Error('socket hang up'); } return n(b); };
  const r = await f.settleRequest(body(makeBlock()), deps(rpc));
  assert.equal(r.success, true, r.detail);
  assert.ok(n.chain.has(r.transaction)); assert.equal(processes, 1);
});

test('settle: a retry of its own broadcast after confirmation_timeout is answered from the chain, one process call in total (B)', async () => {
  const n = node();
  let confirm = false, processes = 0;
  const rpc = async b => {
    if (b.action === 'process') processes++;
    const r = await n(b);
    if (b.action === 'block_info' && r.contents) r.confirmed = confirm ? 'true' : 'false';
    return r;
  };
  const blk = makeBlock();
  const req = { ...REQ, maxTimeoutSeconds: 1 };
  const r1 = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r1.success, false); assert.equal(r1.errorReason, 'confirmation_timeout'); assert.ok(n.chain.has(r1.transaction));
  confirm = true;
  const r2 = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r2.success, true, r2.detail); assert.equal(r2.transaction, r1.transaction); assert.equal(r2.payer, payer);
  assert.equal(processes, 1, 'the retry does not broadcast again');
  // Success answered once: a further /verify or /settle of the same block is a replay, refused as before, and the /settle
  // refusal names the hash and the settle time (a seller that lost the success reply learns the payment went through)
  const v = await f.verifyRequest(body(blk, req), deps(rpc));
  assert.equal(v.isValid, false); assert.equal(v.invalidReason, 'block_already_exists');
  const r2b = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r2b.success, false); assert.equal(r2b.errorReason, 'block_already_exists'); assert.equal(r2b.transaction, r1.transaction); assert.match(r2b.detail, /answered success at/);
  assert.equal(processes, 1);
  // For other requirements the block on the chain sends a different amount than asked: since 2026-10-14 that is an
  // amount_mismatch with no hash (check 10 of the scheme document compares subtype and amount before calling it a
  // replay); until then it was block_already_exists with no hash
  const other = { ...req, amount: (AMOUNT + 1n).toString() };
  const r3 = await f.settleRequest(body(blk, other), deps(rpc));
  assert.equal(r3.success, false); assert.equal(r3.errorReason, 'amount_mismatch'); assert.equal(r3.transaction, '');
  assert.ok(f.broadcast.has(r1.transaction));
});

test('settle: a remembered broadcast the node no longer holds is processed again, not polled for (B, node lost it)', async () => {
  const blk = makeBlock();
  const req = { ...REQ, maxTimeoutSeconds: 1 };
  const r1 = await f.settleRequest(body(blk, req), deps(node({ confirm: false })));
  assert.equal(r1.errorReason, 'confirmation_timeout'); assert.ok(f.broadcast.has(r1.transaction));
  const fresh = node(); let processes = 0;
  const rpc = async b => { if (b.action === 'process') processes++; return fresh(b); };
  const r2 = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r2.success, true, r2.detail); assert.equal(r2.transaction, r1.transaction); assert.equal(processes, 1, 'processed once more on the fresh node');
});

test('settle: the retry when the node already shows the block as the payer frontier polls again; success once confirmed (B, node view)', async () => {
  // On a real node the frontier moves to the broadcast block, so verify takes its alreadyLanded branch: unconfirmed, the
  // own broadcast is still passed on to the poll (confirmation_timeout, not frontier_unconfirmed); confirmed, success.
  const n = node();
  let landed = null, confirm = false, processes = 0;
  const rpc = async b => {
    if (b.action === 'account_info' && landed) return info({ frontier: landed, confirmation_height_frontier: confirm ? landed : FRONTIER, balance: (BALANCE - AMOUNT).toString() });
    if (b.action === 'process') processes++;
    const r = await n(b);
    if (b.action === 'process') landed = r.hash;
    if (b.action === 'block_info' && r.contents) Object.assign(r, { subtype: 'send', amount: AMOUNT.toString(), confirmed: confirm ? 'true' : 'false' });
    return r;
  };
  const blk = makeBlock();
  const req = { ...REQ, maxTimeoutSeconds: 1 };
  const r1 = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r1.errorReason, 'confirmation_timeout');
  const r2 = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r2.errorReason, 'confirmation_timeout', JSON.stringify(r2)); assert.equal(r2.transaction, r1.transaction);
  confirm = true;
  const r3 = await f.settleRequest(body(blk, req), deps(rpc));
  assert.equal(r3.success, true, r3.detail); assert.equal(r3.transaction, r1.transaction);
  assert.equal(processes, 1);
});

// The own-broadcast memory is on disk since 2026-09-30: a restart between the block landing and the success reply used to
// turn the payer's retry into a refused replay with no hash (Jay44333 / Ops Control HQ, api#80, 2026-09-28).
test('settle: the own-broadcast memory survives a restart between landing and the reply, and the retry is answered from the chain', async () => {
  const over = { confirm: false };
  const n = node(over);
  const b = makeBlock();
  const r1 = await f.settleRequest(body(b, { ...REQ, maxTimeoutSeconds: 1 }), deps(n));
  assert.equal(r1.success, false); assert.equal(r1.errorReason, 'confirmation_timeout');
  f.broadcast.clear();                                   // the process restarts
  assert.equal(f.loadBroadcast(), 1, 'reloaded from ' + f.BROADCAST_FILE);
  assert.ok(f.broadcast.has(r1.transaction)); assert.equal(f.broadcast.get(r1.transaction).answered, false);
  over.confirm = true;                                   // the block confirmed meanwhile
  const r2 = await f.settleRequest(body(b), deps(n));
  assert.equal(r2.success, true, r2.detail); assert.equal(r2.transaction, r1.transaction); assert.equal(r2._retry, true);
  f.broadcast.clear(); f.loadBroadcast();
  assert.equal(f.broadcast.get(r1.transaction).answered, true, 'the answered mark is on disk too');
  const r3 = await f.settleRequest(body(b), deps(n));
  assert.equal(r3.success, false); assert.equal(r3.errorReason, 'block_already_exists'); assert.equal(r3.transaction, r1.transaction);
  require('node:fs').rmSync(f.BROADCAST_FILE, { force: true });
});

test('codeFor: "network must be ..." is requirements_mismatch, not invalid_work (word-bounded since 2026-10-01)', () => {
  assert.equal(f.codeFor('network must be nano:mainnet'), 'requirements_mismatch');
  assert.equal(f.codeFor('block.work is required here'), 'invalid_work');
  assert.equal(f.codeFor('work is below the send threshold fffffff800000000'), 'invalid_work');
  assert.equal(f.codeFor('block.work is required here: this facilitator attaches no work (see /supported); compute it over block.previous at fffffff800000000'), 'invalid_work');
  assert.equal(f.codeFor("work 0000000000000001 does not cover block.previous 2F74 at the send threshold fffffff800000000 (work is computed over the previous block hash, never over the new block's own hash)"), 'invalid_work');
  assert.equal(f.codeFor('scheme must be exact'), 'requirements_mismatch');
});

test('settle: a matching block the chain holds that this facilitator did not broadcast answers block_already_exists WITH the hash (scheme head 2c5607a2, Scenario 2, 2026-10-16)', async () => {
  const n = node();
  const b = makeBlock();
  await n({ action: 'process', block: b });   // broadcast elsewhere (the payer's own node, another facilitator)
  const h = N.hashBlock({ account: b.account, previous: b.previous, representative: b.representative, balance: b.balance, link: b.link }).toUpperCase();
  const r = await f.settleRequest(body(b), deps(n));
  assert.equal(r.success, false); assert.equal(r.errorReason, 'block_already_exists');
  assert.equal(r.transaction, h, 'the hash is filled so the seller can apply its own served record');
  assert.match(r.detail, /not broadcast through this facilitator/);
  assert.equal(r.errorMessage, r.detail);
});

test('settle: a matching block the chain holds but has not confirmed answers block_awaiting_confirmation with the hash (Scenario 3: do not serve, resettle)', async () => {
  const n = node({ confirm: false });
  const b = makeBlock();
  await n({ action: 'process', block: b });
  const h = N.hashBlock({ account: b.account, previous: b.previous, representative: b.representative, balance: b.balance, link: b.link }).toUpperCase();
  const v = await f.verifyRequest(body(b), deps(n));
  assert.equal(v.isValid, false); assert.equal(v.invalidReason, 'block_awaiting_confirmation');
  const r = await f.settleRequest(body(b), deps(n));
  assert.equal(r.success, false); assert.equal(r.errorReason, 'block_awaiting_confirmation'); assert.equal(r.transaction, h);
});

test('settle: a chain-held block that sends the wrong amount still answers amount_mismatch with transaction "" (check 10 order unchanged)', async () => {
  const n = node();
  const b = makeBlock({ balance: (BALANCE - 1n).toString() });   // sends 1 raw
  await n({ action: 'process', block: b });
  const r = await f.settleRequest(body(b), deps(n));
  assert.equal(r.success, false); assert.equal(r.errorReason, 'amount_mismatch'); assert.equal(r.transaction, '');
});
