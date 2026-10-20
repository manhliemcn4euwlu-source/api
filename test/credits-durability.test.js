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
