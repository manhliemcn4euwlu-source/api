// node --test  (run from api/). One wallet, ten concurrent purchases, through the stock client examples/client-x402.js.
//
// CasualSecurityInc's x402.Nano review (7c55f32, pursekeeper/api#90, 2026-10-18) asked what contract the client gives ten
// subagents paying through one seed: ten sends prepared against one frontier are competing continuations of one account
// chain, one lands, the rest are refused frontier_moved, and no per-hash lock on the seller side can order them. Their
// deterministic model completes 1 of 10 without a wallet writer and 10 of 10 with one. These tests run the real client,
// ten processes at once, against a mock seller and a mock account-info service on loopback (no node, no funds, a
// throwaway seed), and check: (1) with the per-account lock, 10 of 10 served in order; (2) with NANO_LOCK=0 and all ten
// reading the same frontier, 1 of 10 and the nine losers told to sign anew, not to re-present; (3) a receive by another
// writer between the frontier read and the paid call: that block is dead, the client says so, the next writer continues;
// (4) a lost reply after the block landed: the client reads the fate from the account and says re-present, and the
// writers behind it continue; (5) a fresh live holder past NANO_LOCK_WAIT_MS: exit 5, nothing signed, nothing sent;
// (6) a dead holder is taken over; (7) a live holder past NANO_LOCK_MAX_MS is never taken over, and can resume safely;
// (8) an empty or invalid-PID record is polled until NANO_LOCK_WAIT_MS, left in place, and never permits a signed payment.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const N = require('nanocurrency');

const CLIENT = path.join(__dirname, '..', 'examples', 'client-x402.js');
const SEED = '0'.repeat(64);   // throwaway: never funded, never opened on the chain
const PAY_TO = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(SEED, 1)), { useNanoPrefix: true });
const AMOUNT = '1000000000000000000000000';   // 0.000001 XNO in raw
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = s => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const randomHash = () => require('node:crypto').randomBytes(32).toString('hex').toUpperCase();

// A seller plus the account-info service the client reads, sharing one simulated account chain.
// opts.barrier: hold every account_info reply until that many are waiting, then answer all with the same frontier (forces
//   the uncoordinated collision the way the model's schedule does; without it the fastest process may finish first).
// opts.receiveAfter: right after the n-th account_info reply, another writer lands a receive (frontier moves, balance grows).
// opts.loseReplyOnce: the first paid call lands the block, then the socket is destroyed before any reply.
// opts.pauseFirstInfo: pause the first account_info reply after its caller holds the lock, until resumeInfo().
function mock(opts = {}) {
  const state = { frontier: randomHash(), balance: '5000000000000000000000000000', chain: new Set(), issued: new Set(), landed: 0, served: 0, refused: 0, probes: 0, infoReplies: 0, paidCalls: 0 };
  const waiting = [];
  let firstInfoSeen, resumeFirstInfo, infoPaused = false;
  const firstInfo = new Promise(resolve => { firstInfoSeen = resolve; });
  const info = () => ({ found: true, frontier: state.frontier, balance_raw: state.balance, representative: PAY_TO, block_count: 1 });
  let lost = false, barrierDone = false;   // the barrier is one-shot: the losers' later fate reads must not wait behind it
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/v1/account_info') {
      const reply = () => { state.infoReplies++; json(200, info()); if (opts.receiveAfter && state.infoReplies === opts.receiveAfter) { state.frontier = randomHash(); state.balance = (BigInt(state.balance) + 1000n).toString(); } };
      if (opts.pauseFirstInfo && !infoPaused) { infoPaused = true; resumeFirstInfo = reply; firstInfoSeen(); return; }
      if (opts.barrier && !barrierDone) { waiting.push(reply); if (waiting.length >= opts.barrier) { barrierDone = true; while (waiting.length) waiting.shift()(); } return; }
      return reply();
    }
    if (u.pathname === '/v1/verify') return json(200, { hash: u.searchParams.get('hash'), found: state.chain.has(String(u.searchParams.get('hash')).toUpperCase()) });
    if (u.pathname !== '/buy') return json(404, { error: 'no such endpoint' });
    const sig = req.headers['payment-signature'];
    // Each quote carries its own price (base + the probe's number): ten purchases from one frontier at one price would be
    // ten byte-identical blocks, one hash, which the seller's per-hash lock does serialise; the review's case is ten
    // distinct sends (different sellers, prices or links), so the quotes differ here and so do the blocks.
    if (!sig) { state.probes++;
      if (opts.quoteRedirectTo) { res.writeHead(opts.quoteRedirectStatus || 307, { location: opts.quoteRedirectTo }); return res.end(); }
      const amount = (BigInt(AMOUNT) + BigInt(state.probes)).toString(); state.issued.add(amount);
      const pr = { x402Version: 2, resource: { url: 'http://127.0.0.1/buy' }, accepts: [{ scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', amount, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { work: 'optional' } }] };
      return json(402, { x402: pr }, { 'payment-required': b64(pr) }); }
    state.paidCalls++;
    if (opts.redirectTo) { res.writeHead(opts.redirectStatus || 307, { location: opts.redirectTo }); return res.end(); }
    let block; try { block = unb64(sig).payload.block; } catch { state.refused++; return json(402, { error: 'bad payment header' }); }
    if (String(block.previous).toUpperCase() !== state.frontier) { state.refused++; return json(402, { error: 'block.previous is not the account frontier (' + state.frontier + ')' }); }
    if (!state.issued.has((BigInt(state.balance) - BigInt(block.balance)).toString())) { state.refused++; return json(402, { error: 'wrong amount' }); }
    const hash = N.hashBlock({ account: block.account, previous: block.previous, representative: block.representative, balance: block.balance, link: block.link });
    if (!N.verifyBlock({ hash, signature: block.signature, publicKey: N.derivePublicKey(block.account) })) { state.refused++; return json(402, { error: 'bad signature' }); }
    state.frontier = hash.toUpperCase(); state.balance = block.balance; state.chain.add(state.frontier); state.landed++;
    if (opts.loseReplyOnce && !lost) { lost = true; return res.socket.destroy(); }
    state.served++;
    return json(200, { served: true, hash }, { 'payment-response': b64({ success: true, transaction: hash, network: 'nano:mainnet' }) });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ state, server, origin: 'http://127.0.0.1:' + server.address().port, firstInfo, resumeInfo: () => { const reply = resumeFirstInfo; resumeFirstInfo = null; if (reply) reply(); }, close: () => new Promise(r => server.close(r)) })));
}

function run(origin, lockDir, env = {}) {
  let child;
  const completion = new Promise(resolve => {
    child = spawn(process.execPath, [CLIENT, origin + '/buy'], { env: { PATH: process.env.PATH, NANO_SEED: SEED, API: origin, NANO_MAX_PAY: '0.001', NANO_LOCK_DIR: lockDir, ...env } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: null, out, err: err + e.message }));
    child.on('close', code => resolve({ code, out, err }));
  });
  completion.cancel = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill(); };
  return completion;
}
function redirectSink() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, paymentSignature: req.headers['payment-signature'] || null, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('redirect target reached');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, requests, origin: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  })));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'client-lock-'));
const account = () => N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(SEED, 0)), { useNanoPrefix: true });
const lockFile = dir => path.join(dir, 'pursekeeper-wallet-' + account() + '.lock');

test('ten concurrent purchases through one wallet: the per-account lock orders them, 10 of 10 served', async () => {
  const m = await mock(); const dir = tmp();
  const rs = await Promise.all(Array.from({ length: 10 }, () => run(m.origin, dir)));
  await m.close();
  assert.deepEqual(rs.map(r => r.code), Array(10).fill(0), rs.map(r => r.err).join('\n---\n'));
  assert.equal(m.state.served, 10); assert.equal(m.state.refused, 0); assert.equal(m.state.landed, 10);
  assert.ok(rs.filter(r => /waiting for the wallet lock/.test(r.err)).length >= 1, 'a process behind another says it waited (process start-up is staggered, so not all ten contend)');
  assert.equal(fs.existsSync(lockFile(dir)), false, 'the lock is released at exit');
});

test('NANO_LOCK=0, all ten reading one frontier: 1 of 10 served, the nine refused are told to sign anew (the model\'s 1/10)', async () => {
  const m = await mock({ barrier: 10 }); const dir = tmp();
  const rs = await Promise.all(Array.from({ length: 10 }, () => run(m.origin, dir, { NANO_LOCK: '0' })));
  await m.close();
  assert.equal(m.state.served, 1); assert.equal(m.state.refused, 9); assert.equal(m.state.landed, 1);
  assert.equal(rs.filter(r => r.code === 0).length, 1);
  const losers = rs.filter(r => r.code !== 0);
  assert.equal(losers.length, 9);
  for (const r of losers) {
    assert.equal(r.code, 1);
    assert.match(r.err, /the account frontier moved past [0-9A-F]{64} to another block, not this one/);
    assert.match(r.err, /sign a new block for this call/);
    assert.doesNotMatch(r.err, /re-present the same PAYMENT-SIGNATURE/, 'a dead block must not be re-presented');
  }
});

test('a receive by another writer between the frontier read and the paid call: that block is dead, said so, and the next writer continues', async () => {
  const m = await mock({ receiveAfter: 3 }); const dir = tmp();
  const rs = await Promise.all(Array.from({ length: 10 }, () => run(m.origin, dir)));
  assert.equal(m.state.served, 9); assert.equal(m.state.refused, 1);
  const dead = rs.filter(r => r.code !== 0);
  assert.equal(dead.length, 1);
  assert.match(dead[0].err, /a concurrent payment, a receive or a representative change from this wallet landed first/);
  assert.match(dead[0].err, /sign a new block/);
  const again = await run(m.origin, dir);   // the caller does what the line says
  await m.close();
  assert.equal(again.code, 0); assert.equal(m.state.served, 10);
});

test('a lost reply after the block landed: the fate is read from the account (landed, re-present), the writers behind continue', async () => {
  const m = await mock({ loseReplyOnce: true }); const dir = tmp();
  const rs = await Promise.all(Array.from({ length: 10 }, () => run(m.origin, dir)));
  await m.close();
  assert.equal(m.state.landed, 10); assert.equal(m.state.served, 9); assert.equal(m.state.refused, 0);
  const lost = rs.filter(r => r.code !== 0);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].code, 1);
  assert.match(lost[0].err, /no reply from the seller after the payment was sent/);
  assert.match(lost[0].err, /the block is on the chain \(hash [0-9A-F]{64}\): re-present the same PAYMENT-SIGNATURE/);
  assert.doesNotMatch(lost[0].err, /; sign a new block for this call/);
  assert.doesNotMatch(lost[0].err, /^error:/m, 'a lost reply is resolved, not reported as a bare error');
});

test('a live holder past NANO_LOCK_WAIT_MS: exit 5, nothing signed, no paid call', async () => {
  const m = await mock(); const dir = tmp();
  fs.writeFileSync(lockFile(dir), process.pid + ' ' + Date.now());   // this test process holds it and stays alive
  const r = await run(m.origin, dir, { NANO_LOCK_WAIT_MS: '400' });
  await m.close();
  assert.equal(r.code, 5);
  assert.match(r.err, /waiting for the wallet lock/);
  assert.match(r.err, /waited 0 s for the wallet lock/);
  assert.doesNotMatch(r.err, /signed block/);
  assert.equal(m.state.paidCalls, 0); assert.equal(m.state.infoReplies, 0); assert.equal(m.state.probes, 1);
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8').split(' ')[0], String(process.pid), 'a live holder\'s lock is left alone');
});

test('a stale holder is taken over only when its process is gone', async () => {
  const m = await mock(); const dir = tmp();
  const gone = spawn(process.execPath, ['-e', '']); await new Promise(r => gone.on('close', r));
  fs.writeFileSync(lockFile(dir), gone.pid + ' ' + Date.now());
  const a = await run(m.origin, dir);
  assert.equal(a.code, 0); assert.match(a.err, /wallet lock .* is stale \(its process is gone\); taking it over/);
  await m.close();
  assert.equal(m.state.served, 1);
  assert.equal(fs.existsSync(lockFile(dir)), false);
});


test('three simultaneous waiters on one dead account record serialize reclamation and each mock purchase', async () => {
  const m = await mock(); const dir = tmp();
  const gone = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => gone.on('close', resolve));
  fs.writeFileSync(lockFile(dir), gone.pid + ' ' + Date.now());
  const rs = await Promise.all(Array.from({length:3}, () => run(m.origin,dir)));
  await m.close();
  assert.deepEqual(rs.map(r=>r.code),[0,0,0],rs.map(r=>r.err).join('\n---\n'));
  assert.equal(m.state.served,3);
  assert.equal(m.state.refused,0);
  assert.equal(m.state.landed,3);
  assert.equal(fs.existsSync(lockFile(dir)),false);
  assert.equal(fs.existsSync(lockFile(dir)+'.reaper'),false);
});

test('pre-existing stale reaper FILE beside dead holder blocks the real client unsigned', { timeout: 15000 }, async t => {
  const m = await mock(), dir = tmp(), file = lockFile(dir);
  const gone = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => gone.on('close', resolve));
  const oldHolder = gone.pid + ' ' + Date.now();
  fs.writeFileSync(file, oldHolder);
  const gate = file + '.reaper';
  fs.writeFileSync(gate, 'orphaned reaper gate from stopped process', { flag: 'wx' });
  t.after(async () => { m.server.closeAllConnections(); await m.close(); });
  const r = await run(m.origin, dir, { NANO_LOCK_WAIT_MS: '320' });
  assert.equal(r.code, 5, r.err);
  assert.ok(r.err.includes(file), 'refusal must name original lock');
  assert.ok(r.err.includes(gate), 'refusal must name exclusive gate');
  assert.match(r.err, /Nothing signed/);
  assert.match(r.err, /manually delete an orphaned gate file/);
  assert.doesNotMatch(r.err, /signed block|taking it over/);
  assert.equal(m.state.infoReplies, 0, 'must not touch account state');
  assert.equal(m.state.paidCalls, 0, 'must not attempt paid request');
  assert.equal(m.state.served, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), oldHolder, 'original dead-holder record preserved');
  assert.equal(fs.readFileSync(gate, 'utf8'), 'orphaned reaper gate from stopped process');
});

test('crash-orphaned stale reaper gate refuses unsigned and does not steal a lock', async () => {
  const m=await mock();const dir=tmp();
  const gone=spawn(process.execPath,['-e','']);
  await new Promise(resolve=>gone.on('close',resolve));
  fs.writeFileSync(lockFile(dir),gone.pid+' '+Date.now());
  fs.writeFileSync(lockFile(dir)+'.reaper', 'orphan reaper', { flag: 'wx' });
  const r=await run(m.origin,dir,{NANO_LOCK_WAIT_MS:'320'});
  await m.close();
  assert.equal(r.code,5,r.err);
  assert.match(r.err,/stale-reaper gate/);
  assert.match(r.err,/Nothing signed/);
  assert.doesNotMatch(r.err,/signed block|taking it over/);
  assert.equal(m.state.infoReplies,0);
  assert.equal(m.state.paidCalls,0);
  assert.equal(fs.existsSync(lockFile(dir)),true);
  assert.equal(fs.existsSync(lockFile(dir)+'.reaper'),true);
});

test('signed cross-origin 307/308 responses are not followed and do not count as served', async t => {
  const target = await redirectSink();
  t.after(() => target.close());
  for (const status of [307, 308]) {
    const m = await mock({ redirectTo: target.origin + '/capture', redirectStatus: status });
    const dir = tmp();
    const proof = path.join(dir, `proof-${status}.json`);
    try {
      const r = await run(m.origin, dir, { METHOD: 'POST', BODY: '{"probe":"synthetic"}', NANO_SAVE_PAYLOAD: proof });
      await m.close();
      assert.equal(r.code, 1, r.err);
      assert.equal(m.state.paidCalls, 1);
      assert.equal(target.requests.length, 0, 'redirect target must not receive any request');
      assert.match(r.err, new RegExp(`signed redirect refused: HTTP ${status}`));
      assert.ok(r.err.includes('Location origin ' + target.origin), r.err);
      assert.match(r.err, /PAYMENT-SIGNATURE was not forwarded to the redirect target/i);
      const saved = JSON.parse(fs.readFileSync(proof, 'utf8'));
      assert.equal(saved.url, m.origin + '/buy');
      assert.equal(saved.status, status);
      assert.equal(saved.served, false);
    } finally {
      if (m.server.listening) await m.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('unsigned quote may redirect, but the signed call uses the URL that returned 402', async t => {
  const target = await redirectSink();
  t.after(() => target.close());
  const canonical = await mock({ redirectTo: target.origin + '/capture', redirectStatus: 307 });
  const entry = await mock({ quoteRedirectTo: canonical.origin + '/buy', quoteRedirectStatus: 307 });
  const dir = tmp();
  const proof = path.join(dir, 'canonical-proof.json');
  try {
    const r = await run(entry.origin, dir, { METHOD: 'POST', BODY: '{"probe":"canonical"}', NANO_SAVE_PAYLOAD: proof });
    await Promise.all([entry.close(), canonical.close()]);
    assert.equal(r.code, 1, r.err);
    assert.equal(entry.state.probes, 1, 'original endpoint issued only an unsigned redirect');
    assert.equal(canonical.state.probes, 1, 'canonical endpoint returned the quote');
    assert.equal(canonical.state.paidCalls, 1, 'signed request went to the endpoint that returned 402');
    assert.equal(target.requests.length, 0, 'signed 307 was not followed');
    const saved = JSON.parse(fs.readFileSync(proof, 'utf8'));
    assert.equal(saved.url, canonical.origin + '/buy');
    assert.equal(saved.status, 307);
    assert.equal(saved.served, false);
    assert.ok(r.err.includes('Location origin ' + target.origin), r.err);
  } finally {
    if (entry.server.listening) await entry.close();
    if (canonical.server.listening) await canonical.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NANO_SAVE_PAYLOAD: a proof file that already exists is rewritten with mode 600', async () => {
  const m = await mock(); const dir = tmp();
  const proof = require('node:path').join(dir, 'proof.json');
  fs.writeFileSync(proof, 'old contents', { mode: 0o644 });
  assert.equal(fs.statSync(proof).mode & 0o777, 0o644);
  const r = await run(m.origin, dir, { NANO_SAVE_PAYLOAD: proof });
  await m.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.statSync(proof).mode & 0o777, 0o600, 'an existing file keeps its bits unless chmod runs');
  assert.match(JSON.parse(fs.readFileSync(proof, 'utf8')).hash, /^[0-9A-F]{64}$/);
});

test('a live holder past NANO_LOCK_MAX_MS is refused immediately, keeps its lock, and can resume', { timeout: 15000 }, async t => {
  const m = await mock({ pauseFirstInfo: true }); const dir = tmp();
  const maxMs = 200;
  const holder = run(m.origin, dir, { NANO_LOCK_MAX_MS: String(maxMs) });
  let waiterRun;
  t.after(async () => {
    m.resumeInfo();
    holder.cancel(); if (waiterRun) waiterRun.cancel();
    await Promise.allSettled([holder, waiterRun].filter(Boolean));
    m.server.closeAllConnections();
    await m.close();
  });
    await Promise.race([m.firstInfo, holder.then(r => { throw new Error('holder exited before account_info: ' + r.err); })]);
    // A owns the actual client lock, but has not received account info or signed.
    const token = fs.readFileSync(lockFile(dir), 'utf8');
    const [pid, at] = token.trim().split(' ');
    await new Promise(r => setTimeout(r, Math.max(0, Number(at) + maxMs + 100 - Date.now())));
    waiterRun = run(m.origin, dir, { NANO_LOCK_MAX_MS: String(maxMs), NANO_LOCK_WAIT_MS: '30000' });
    const waiter = await waiterRun;
    assert.equal(waiter.code, 5, waiter.err);
    assert.ok(waiter.err.includes('live pid ' + pid), waiter.err);
    assert.match(waiter.err, /for \d+ ms; NANO_LOCK_MAX_MS=200/);
    assert.doesNotMatch(waiter.err, /waiting for the wallet lock|signed block|taking it over/);
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), token, 'the live holder still owns exactly the same lock');
    assert.equal(m.state.probes, 2);
    assert.equal(m.state.infoReplies, 0, 'the waiter did not reach account_info; A is still paused');
    assert.equal(m.state.paidCalls, 0, 'no signed payment was sent');
    m.resumeInfo();
    const resumed = await holder;
    assert.equal(resumed.code, 0, resumed.err);
    assert.equal(m.state.served, 1); assert.equal(m.state.paidCalls, 1);
    assert.equal(fs.existsSync(lockFile(dir)), false, 'A releases its own lock when it exits');
});


for (const [label, record] of [
  ['empty', ''],
  ['truncated whitespace', ' \n'],
  ['foreign', 'owner=another-tool'],
  ['non-integer PID', '1.5 0'],
  ['out-of-range PID', '2147483648 0'],
]) {
  test('a lock with an ' + label + ' record waits, exits 5 unsigned, and remains untouched', { timeout: 10000 }, async t => {
    const m = await mock(); const dir = tmp(); const file = lockFile(dir);
    let waiter;
    t.after(async () => {
      if (waiter) { waiter.cancel(); await waiter; }
      m.server.closeAllConnections();
      await m.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    fs.writeFileSync(file, record);
    // A tiny MAX must not turn unknown ownership into a live-holder refusal or a stale takeover.
    waiter = run(m.origin, dir, { NANO_LOCK_WAIT_MS: '400', NANO_LOCK_MAX_MS: '1' });
    const r = await waiter;
    assert.equal(r.code, 5, r.err);
    assert.match(r.err, /waiting for the wallet lock/);
    assert.match(r.err, /refusing: waited .*no PID available/);
    assert.ok(r.err.includes(file), 'the refusal names the lock file for inspection');
    assert.match(r.err, /Nothing signed/);
    assert.match(r.err, /Check for running clients.*only if none are running, manually remove this lock file/);
    assert.doesNotMatch(r.err, /signed block|taking it over|held by live pid/);
    assert.equal(m.state.probes, 1);
    assert.equal(m.state.infoReplies, 0, 'the client never reached account_info');
    assert.equal(m.state.paidCalls, 0, 'the client never sent a signed payment');
    assert.equal(m.state.served, 0); assert.equal(m.state.landed, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), record, 'the lock remains byte-for-byte unchanged');
  });
}
