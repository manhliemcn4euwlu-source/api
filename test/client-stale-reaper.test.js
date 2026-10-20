'use strict';
// Synthetic filesystem-only cases: no Nano wallet, seed, paid HTTP or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reapDeadHolder } = require('../examples/wallet-lock-reaper');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-reaper-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'wallet.lock');
}

test('unsafe pre-gate interleaving allows two live writers by removing B after validation of old H', t => {
  const file = temp(t), deadH = '2147483000 1', liveB = '20002 2222', liveC = '30003 3333';
  fs.writeFileSync(file, deadH);
  const cSeen = fs.readFileSync(file, 'utf8');
  const bSeen = fs.readFileSync(file, 'utf8');
  // C's equality decision is made while H is there.
  assert.equal(cSeen, bSeen);
  assert.equal(fs.readFileSync(file, 'utf8'), cSeen);
  // B checks H, unlinks H, publishes B and enters its wallet critical section.
  assert.equal(fs.readFileSync(file, 'utf8'), bSeen);
  fs.unlinkSync(file);
  fs.writeFileSync(file, liveB, { flag: 'wx' });
  // The former code would then unlink using C's now-stale comparison.
  fs.unlinkSync(file);
  fs.writeFileSync(file, liveC, { flag: 'wx' });
  assert.equal(fs.readFileSync(file, 'utf8'), liveC);
  // This is a deterministic *unsafe model*, not a real wallet payment.
});

test('reaper file is exclusive: while B holds the gate, C cannot remove old H', t => {
  const file = temp(t), deadH = '2147483000 1';
  fs.writeFileSync(file, deadH);
  const gate = file + '.reaper';
  const fd = fs.openSync(gate, 'wx');
  const blockedC = reapDeadHolder(file, deadH, () => true);
  assert.deepEqual(blockedC, { state: 'busy', gate });
  assert.equal(fs.readFileSync(file, 'utf8'), deadH);
  fs.closeSync(fd);
  fs.unlinkSync(gate);
  const b = reapDeadHolder(file, deadH, () => true);
  assert.equal(b.state, 'removed');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(gate), false);
});

test('C after B reclaimed old H and a NEW live owner has arrived refuses stale unlink', t => {
  const file = temp(t), deadH = '2147483000 1', liveB = '20002 2222';
  fs.writeFileSync(file, deadH);
  const cSeen = fs.readFileSync(file, 'utf8');
  assert.equal(reapDeadHolder(file, deadH, () => true).state, 'removed');
  fs.writeFileSync(file, liveB, { flag: 'wx' });
  const cResult = reapDeadHolder(file, cSeen, () => true);
  assert.equal(cResult.state, 'changed');
  assert.equal(fs.readFileSync(file, 'utf8'), liveB);
  assert.equal(fs.existsSync(file + '.reaper'), false);
});

test('existing crash-orphaned reaper file cannot be reaped by timeout or holder death', t => {
  const file = temp(t), deadH = '2147483000 1';
  fs.writeFileSync(file, deadH);
  const gate = file + '.reaper';
  fs.writeFileSync(gate, 'human cleanup only', { flag: 'wx' });
  for (let n = 0; n < 3; n++) {
    assert.equal(reapDeadHolder(file, deadH, () => true).state, 'busy');
    assert.equal(fs.readFileSync(file, 'utf8'), deadH);
    assert.equal(fs.readFileSync(gate, 'utf8'), 'human cleanup only');
  }
});

test('predicate is rechecked under gate; no missing/live holder can be unlinked', t => {
  const file = temp(t), deadH = '2147483000 1';
  fs.writeFileSync(file, deadH);
  assert.equal(reapDeadHolder(file, deadH, () => false).state, 'changed');
  assert.equal(fs.readFileSync(file, 'utf8'), deadH);
  fs.unlinkSync(file);
  assert.equal(reapDeadHolder(file, deadH, () => true).state, 'changed');
  assert.equal(fs.existsSync(file + '.reaper'), false);
});

test('failed filesystem inspection refuses to erase lock and always closes exclusive gate', t => {
  const file = temp(t), deadH = '2147483000 1';
  fs.writeFileSync(file, deadH);
  assert.throws(() => reapDeadHolder(file, deadH, () => {
    throw Error('simulated liveness provider failure');
  }), /liveness provider failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), deadH);
  assert.equal(fs.existsSync(file + '.reaper'), false);
});
