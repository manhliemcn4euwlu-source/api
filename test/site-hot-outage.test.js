// node --test  (run from api/). The home page and /log.json publish the hot wallet's balance. A node that cannot be asked
// is not a wallet holding nothing: until 2026-10-23 the account_balance catch left hot and receivable at 0n, so an outage
// made the site print "the hot wallet holds Ӿ0" and /log.json carry hot:0 as a figure (llmrt, 2026-10-23).
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// A scratch database with the tables site.load() reads, all empty: the balance is the only thing under test.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'site-hot-outage-'));
const DB = path.join(SCRATCH, 'gambit.db');
{
  const db = new DatabaseSync(DB);
  db.exec(`create table initiatives (id integer primary key, ts text, title text, status text, body text);
           create table ledger (id integer primary key, ts text, kind text, amount_raw text, counterparty text, reason text, initiative_id integer, block_hash text, cost_kind text, fiat_amount real, fiat_currency text, rate_fiat_per_nano real, meta_json text);
           create table decisions (id integer primary key, ts text, initiative_id integer, summary text, rationale text);
           create table requests (id integer primary key, ts text, kind text, status text, resolved_at text, amount_raw text, body text, resolution text);
           create table wakes (id integer primary key, started_at text, ended_at text, trigger text, model text, cost_usd real, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, summary text);
           create table reports (week_start text primary key, body text, created_at text);`);
  db.close();
}
process.env.GAMBIT_DB = DB;
process.env.NANO_RPC = 'http://node.test/rpc';
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const WRITE_SINK = path.join(SCRATCH, 'sink');
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(WRITE_SINK, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const site = require('../site');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
});

// site.load() caches for ten minutes; each case starts from a cold cache.
const fresh = () => site.clearCache();

test('an unreachable node leaves the hot balance null and names the outage, never 0', async () => {
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  fresh();
  const d = await site.loadForTest();
  assert.equal(d.numbers.hot, null, 'not 0n: the balance was never read');
  assert.equal(d.numbers.receivable, null);
  assert.match(d.numbers.hot_error, /ECONNREFUSED/);
});

test('a node that answers with an error object is also an outage, not a zero balance', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ error: 'Database read failed' }) });
  fresh();
  const d = await site.loadForTest();
  assert.equal(d.numbers.hot, null);
  assert.match(d.numbers.hot_error, /Database read failed/);
});

test('a node that answers a balance publishes it as before', async () => {
  globalThis.fetch = async () => ({ json: async () => ({ balance: '5000000000000000000000000000000', receivable: '1000' }) });
  fresh();
  const d = await site.loadForTest();
  assert.equal(d.numbers.hot, 5n * 10n ** 30n);
  assert.equal(d.numbers.receivable, 1000n);
  assert.equal(d.numbers.hot_error, null);
});
