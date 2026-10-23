// node --test  (run from api/). Every proof a work source returns is checked against the hash and the threshold before it is
// served; an invalid one falls through to the next source, and when every source fails workFor throws (the route hands the
// call back). Before 2026-09-30 a source's answer was passed on unchecked (uknwplayer, 2026-09-29). Mocked fetch, no network.
'use strict';
process.env.WORK_URLS = 'http://first.test/#first,http://second.test/#second';
process.env.PAID_WORK_URLS = '';
process.env.NANO_RPC = 'http://node.test/rpc';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const N = require('nanocurrency');
require('./guard-data');   // every write under data/ is dropped before the server boots (counters, ledgers, logs)
const { workFor } = require('../server');

const THRESHOLD = 'ff00000000000000';
const HASH = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';
let good;
before(async () => { good = await N.computeWork(HASH, { workThreshold: THRESHOLD }); });
const answers = {};
const asked = [];
globalThis.fetch = async (url) => { asked.push(url); const a = answers[url]; return { ok: true, json: async () => a }; };

test('an invalid proof from the first source falls through to the second, whose valid proof is served', async () => {
  asked.length = 0;
  answers['http://first.test/#first'] = { work: '0000000000000000' };
  answers['http://second.test/#second'] = { work: good };
  const r = await workFor(HASH, { threshold: THRESHOLD, timeoutMs: 1000 });
  assert.equal(r.work, good.toLowerCase()); assert.equal(r.source, 'second');
  assert.deepEqual(asked, ['http://first.test/#first', 'http://second.test/#second']);
});
test('work valid for another hash is invalid here; every source failing throws with the last reason', async () => {
  const otherHash = 'A'.repeat(64);
  const other = await N.computeWork(otherHash, { workThreshold: THRESHOLD });
  answers['http://first.test/#first'] = { work: other };
  answers['http://second.test/#second'] = { work: other };
  answers['http://node.test/rpc'] = { error: 'node says no' };
  // A hash of its own: a proof for HASH was served above and is kept for a minute (coalescing test below).
  const hash2 = 'B'.repeat(64);
  await assert.rejects(workFor(hash2, { threshold: THRESHOLD, timeoutMs: 1000 }), /node: node says no/);
  // The failure is not kept: the next call for the same hash asks the sources again.
  asked.length = 0;
  await assert.rejects(workFor(hash2, { threshold: THRESHOLD, timeoutMs: 1000 }), /node: node says no/);
  assert.equal(asked.length, 3);
});
// Several blocks on one frontier presented together cost one proof, not one each: the x402 lock is per block hash, so
// K signed variants of the same send (different representative) all reached workFor at once and each bought a proof for
// one payment (kilkelly, x402-nano-exact-scheme-proposal#1, 2026-10-16).
test('concurrent calls for the same hash share one proof, and the proof is reused within the minute', async () => {
  const hash3 = 'C'.repeat(64);   // its own hash: HASH's proof from the first test is still kept
  const good3 = await N.computeWork(hash3, { workThreshold: THRESHOLD });
  asked.length = 0;
  answers['http://first.test/#first'] = { work: good3 };
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => workFor(hash3, { threshold: THRESHOLD, timeoutMs: 1000 })));
  assert.equal(a.work, good3.toLowerCase()); assert.equal(b.work, a.work); assert.equal(c.work, a.work);
  assert.equal(asked.length, 1, 'one source call for three concurrent requests');
  assert.equal(a.shared, undefined); assert.equal(b.shared, true); assert.equal(c.shared, true);
  const d = await workFor(hash3, { threshold: THRESHOLD, timeoutMs: 1000 });
  assert.equal(d.work, a.work); assert.equal(d.shared, true); assert.equal(asked.length, 1, 'no new call within the minute');
});

// Distinct accounts are distinct frontiers, one proof each, so a payer with many funded accounts can keep the work
// sources busy at the route price (kilkelly, same thread, 2026-10-16). Paid proofs are capped in flight; the fifth is
// refused before anything is broadcast, with the 402 asking for work attached. Free calls are bounded per IP elsewhere.
test('paid proofs are capped at four in flight; a fifth paid call is refused at once, a free one is not', async () => {
  const hashes = ['D', 'E', 'F', '1', '2', '3'].map(c => c.repeat(64));
  const proofs = {};
  for (const h of hashes) proofs[h] = (await N.computeWork(h, { workThreshold: THRESHOLD })).toLowerCase();
  let release; const gate = new Promise(r => { release = r; });
  globalThis.fetch = async (url, init) => { const h = JSON.parse(init.body).hash; await gate; return { ok: true, json: async () => ({ work: proofs[h] }) }; };
  const four = hashes.slice(0, 4).map(h => workFor(h, { threshold: THRESHOLD, timeoutMs: 1000, paid: true }));
  await assert.rejects(workFor(hashes[4], { threshold: THRESHOLD, timeoutMs: 1000, paid: true }), e => e.code === 'work_unavailable' && /4 proofs are being generated already; attach work computed over block.previous/.test(e.message));
  const free = workFor(hashes[4], { threshold: THRESHOLD, timeoutMs: 1000 });
  release();
  const rs = await Promise.all(four);
  for (let i = 0; i < 4; i++) assert.equal(rs[i].work, proofs[hashes[i]]);
  assert.equal((await free).work, proofs[hashes[4]]);
  const after = await workFor(hashes[5], { threshold: THRESHOLD, timeoutMs: 1000, paid: true });   // slots freed
  assert.equal(after.work, proofs[hashes[5]]); assert.equal(after.shared, undefined);
});
