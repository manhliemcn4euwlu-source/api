// node --test (run from api/). A credit is money that was already sent on chain: data/credits.json is the only
// record that it has not been spent yet. The file is rewritten on every credit, spend and revoke, so a process
// killed mid-write leaves a truncated JSON, and the loader's `catch {}` then answers {} -- every unspent balance
// silently becomes zero. These tests hold the store to the rule a money file needs: a reader either sees the whole
// previous state or the whole next one, and a damaged file is never read as "no credits".
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, readJsonStore } = require('../creditstore');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'credits-'));

test('a truncated credits file is reported as damaged, never read as an empty ledger', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  fs.writeFileSync(f, '{"AB":"1000","CD":"20');   // killed mid-write
  const r = readJsonStore(f);
  assert.equal(r.damaged, true, 'a partial file must be named damaged');
  assert.deepEqual(r.value, {}, 'the value is empty, but the caller is told why');
  assert.match(r.error, /Unexpected end|Unterminated|JSON/i);
});

test('a missing file is a fresh install, not damage', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  const r = readJsonStore(f);
  assert.equal(r.damaged, false);
  assert.deepEqual(r.value, {});
});

test('an empty file is damage: a real ledger is never zero bytes', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  fs.writeFileSync(f, '');
  assert.equal(readJsonStore(f).damaged, true);
});

test('writeJsonAtomic leaves the previous file intact when the write is interrupted', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  fs.writeFileSync(f, JSON.stringify({ AB: '1000' }));
  // Simulate a crash after the temp file is open but before the rename: the destination must still hold the old bytes.
  assert.throws(() => writeJsonAtomic(f, { AB: '9999' }, { afterWrite: () => { throw new Error('killed'); } }));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { AB: '1000' });
});

test('writeJsonAtomic replaces the file whole, and a reader never sees a partial one', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1' });
  const big = {}; for (let i = 0; i < 5000; i++) big['H' + i] = String(i);
  writeJsonAtomic(f, big);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))).length, 5000);
  assert.equal(fs.readdirSync(dir).filter(n => n.includes('.tmp')).length, 0, 'no temp file is left behind');
});

test('writeJsonAtomic makes the first write recoverable immediately', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { AB: '1' });
});

test('writeJsonAtomic keeps a .bak of the last good ledger, and the damaged file is never the .bak', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1' });
  writeJsonAtomic(f, { AB: '2' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { AB: '1' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { AB: '2' });
});

test('a damaged ledger with a good .bak loads the .bak and says so', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1' });
  writeJsonAtomic(f, { AB: '2' });
  fs.writeFileSync(f, '{"AB":"2"');   // crash damage after the last good write
  const r = readJsonStore(f);
  assert.deepEqual(r.value, { AB: '1' }, 'the last complete ledger is used');
  assert.equal(r.recovered, true);
  assert.equal(r.damaged, true);
});

test('writeJsonAtomic preserves a good .bak when rename fails during recovery from a damaged primary', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1' });
  writeJsonAtomic(f, { AB: '2' });
  fs.writeFileSync(f, '{"AB":"2"'); // damaged primary; .bak still has the last complete ledger

  const before = readJsonStore(f);
  assert.equal(before.recovered, true);
  assert.deepEqual(before.value, { AB: '1' });

  assert.throws(
    () => writeJsonAtomic(f, { AB: '3' }, { renameSync: () => { throw new Error('rename failed'); } }),
    /rename failed/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { AB: '1' });
  const after = readJsonStore(f);
  assert.equal(after.recovered, true);
  assert.deepEqual(after.value, { AB: '1' });
});

test('the facilitator settlement list survives a crash: /stats must not lose every settled block', () => {
  // facilitator.json holds every settlement this facilitator made; it was rewritten in place, and its loader answered the
  // defaults on a parse error, so a crash mid-write emptied the public settlement record. Same store, same guarantee.
  const dir = tmpdir(), f = path.join(dir, 'facilitator.json');
  const settled = { since: '2026-10-01T00:00:00Z', settle: 3, settle_ok: 3,
    settled: [{ hash: 'AA'.repeat(32), payer: 'nano_a', pay_to: 'nano_b', amount_raw: '1000', at: '2026-10-02T00:00:00Z' }] };
  writeJsonAtomic(f, settled);
  assert.equal(readJsonStore(f).value.settled.length, 1);
  fs.writeFileSync(f, '{"settled":[{"hash":"AA');   // killed mid-write
  const r = readJsonStore(f);
  assert.equal(r.damaged, true);
  assert.equal(r.recovered, true);
  assert.equal(r.value.settled.length, 1, 'the settled history is not silently emptied');
});

test('the broadcast memory survives a crash: a paid block must not become an unknown one', () => {
  // broadcast.json is what lets a payer whose success reply was lost learn the block went through. Truncated, the entry is
  // gone and the retry is refused as a replay with no hash.
  const dir = tmpdir(), f = path.join(dir, 'broadcast.json');
  const b = { ['AB'.repeat(32)]: { payer: 'nano_a', payTo: 'nano_b', amount: '1000', at: Date.now(), answered: true, answeredAt: '2026-10-02T00:00:00Z' } };
  writeJsonAtomic(f, b);
  assert.equal(Object.keys(readJsonStore(f).value).length, 1);
  fs.writeFileSync(f, '{"AABB');
  const r = readJsonStore(f);
  assert.equal(r.recovered, true);
  assert.equal(Object.keys(r.value).length, 1);
});

test('the settled x402 log survives a crash: a paid call must not leave the public record', () => {
  // data/x402.json is the list of settled x402 blocks and the source of the known-payer list. Truncated, the catch answered
  // [], so a settled payment left the record and its payer left the set that gets free work on the GPU.
  const dir = tmpdir(), f = path.join(dir, 'x402.json');
  const log = [{ hash: 'AA'.repeat(32), payer: 'nano_a', amount_raw: '1000', resource: '/api', at: '2026-10-02T00:00:00Z' }];
  writeJsonAtomic(f, log);
  assert.equal(readJsonStore(f).value.length, 1);
  fs.writeFileSync(f, '[{"hash":"AA');
  const r = readJsonStore(f);
  assert.equal(r.recovered, true);
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0].payer, 'nano_a', 'the known-payer list is rebuilt from the recovered log');
});

test('the represent tokens survive a crash: a live token must not read as no record', () => {
  // data/represent.json binds a broadcast-but-unconfirmed block to the payer who was handed the 402. Read as {}, the payer's
  // own re-presentation is served as before, which is the takeover the tokens exist to prevent.
  const dir = tmpdir(), f = path.join(dir, 'represent.json');
  const tok = { ['AB'.repeat(32)]: { token: 'deadbeef', at: Date.now() } };
  writeJsonAtomic(f, tok);
  assert.equal(readJsonStore(f).value['AB'.repeat(32)].token, 'deadbeef');
  fs.writeFileSync(f, '{"AABB":{"tok');
  const r = readJsonStore(f);
  assert.equal(r.recovered, true);
  assert.equal(r.value['AB'.repeat(32)].token, 'deadbeef');
});

test('the known-payer list survives a crash: a returning payer must not be treated as a stranger', () => {
  const dir = tmpdir(), f = path.join(dir, 'payers.json');
  writeJsonAtomic(f, ['nano_a', 'nano_b']);
  assert.deepEqual(readJsonStore(f).value, ['nano_a', 'nano_b']);
  fs.writeFileSync(f, '["nano_a",');
  const r = readJsonStore(f);
  assert.equal(r.recovered, true);
  assert.deepEqual(r.value, ['nano_a', 'nano_b']);
});

test('an empty ledger with a good .bak loads the .bak, and the next writes keep the recovered credits', () => {
  // Zero bytes is damage like a truncated tail is, and the same last complete copy is there to load. Read as {} instead,
  // the server runs on an empty ledger, and its next two writes rotate that empty ledger into .bak: the first write keeps
  // the .bak (the primary does not parse), the second copies the new, near-empty primary over it.
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1000' });
  writeJsonAtomic(f, { AB: '1000', CD: '0' });
  fs.writeFileSync(f, '');   // killed between the truncate and the write
  const r = readJsonStore(f);
  assert.equal(r.damaged, true);
  assert.equal(r.recovered, true, 'the .bak is there: ' + JSON.stringify(r));
  assert.deepEqual(r.value, { AB: '1000' }, 'the last complete ledger is used, not {}');
  // the server carries on from what it loaded: two more writes
  const credits = r.value;
  credits.EF = '5'; writeJsonAtomic(f, credits);
  credits.EF = '4'; writeJsonAtomic(f, credits);
  const again = readJsonStore(f);
  assert.equal(again.value.AB, '1000', 'the unspent credit survives');
  assert.equal(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).AB, '1000', 'and so does the backup');
});

test('a whitespace-only ledger is damage with the same .bak fallback', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  writeJsonAtomic(f, { AB: '1' });
  fs.writeFileSync(f, ' \n\t');
  const r = readJsonStore(f);
  assert.equal(r.recovered, true);
  assert.deepEqual(r.value, { AB: '1' });
});

test('an empty ledger with no .bak is damage and answers {} as before', () => {
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  fs.writeFileSync(f, '');
  const r = readJsonStore(f);
  assert.equal(r.damaged, true); assert.equal(r.recovered, false); assert.equal(r.error, 'empty file');
  assert.deepEqual(r.value, {});
});

test('an empty ledger keeps settled x402 hashes: a settled payment stays spent and is never creditable again', () => {
  // server.js marks a hash spent or settled through x402 as '0' in the same ledger (the facilitator path stores
  // credits[s.transaction] = '0'), and a hash that is absent from the ledger can be credited again. Read as {}, an
  // empty primary forgets every '0', and after two writes the .bak that still held them is gone too.
  const dir = tmpdir(), f = path.join(dir, 'credits.json');
  const SETTLED = 'A'.repeat(64);
  writeJsonAtomic(f, { [SETTLED]: '0', AB: '1000' });
  writeJsonAtomic(f, { [SETTLED]: '0', AB: '1000' });
  fs.writeFileSync(f, '');
  const credits = readJsonStore(f).value;
  assert.equal(credits[SETTLED], '0', 'the settled hash is still known as spent after the empty read');
  credits.EF = '5'; writeJsonAtomic(f, credits);
  credits.EF = '4'; writeJsonAtomic(f, credits);
  const after = readJsonStore(f).value;
  assert.equal(after[SETTLED], '0', 'still spent after two writes: a re-presented settled block cannot be credited');
  assert.equal(JSON.parse(fs.readFileSync(f + '.bak', 'utf8'))[SETTLED], '0', 'and the backup still has it');
});
