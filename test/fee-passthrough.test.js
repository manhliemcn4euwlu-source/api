// node --test  (run from api/). A send that arrived through a fee-taking checkout wallet (Subnano post purchases and tips)
// paid for that, not for API calls, so it must never become X-Nano-Payment credit, whoever presents the hash. feePassthrough
// decides per send from the payer's account_history read from that send forward (head: the send, reverse: true, count: 2):
// the send itself, then the block after it. A checkout wallet's fee send is the block AFTER its share, never before it
// (trollhunters, 2026-09-29), and the answer is per send, not per account (pyfile-toolkit, 2026-09-29).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./guard-data');   // every write under data/ is dropped before the server boots (counters, ledgers, logs)
const { feePassthrough, FEE_COLLECTORS } = require('../server');

const ME = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FEE = [...FEE_COLLECTORS][0];
const BUYER = 'nano_35wwkw7eg3aa4r4gubhhj3mmrg37oabnohokip51iunmi68bwjftm9t8tfai';
const HASH = 'AB'.repeat(32);
const NOW = 1_800_000_000_000;   // ms
const share = (age = 5) => ({ type: 'send', account: ME, amount: '185000000000000000000000000000', hash: HASH, local_timestamp: String(NOW / 1000 - age) });
const fee = { type: 'send', account: FEE, amount: '15000000000000000000000000000', hash: 'CD'.repeat(32) };
const other = { type: 'send', account: BUYER, amount: '1', hash: 'EF'.repeat(32) };
const receive = { type: 'receive', account: BUYER, amount: '1', hash: '01'.repeat(32) };

test('row A: the share, then the fee send to the collector -> a checkout wallet', () => {
  assert.equal(feePassthrough([share(), fee], FEE_COLLECTORS, ME, HASH, NOW), true);
  assert.equal(feePassthrough([share(600), fee], FEE_COLLECTORS, ME, HASH.toLowerCase(), NOW), true, 'age and hash case do not matter once the fee block is there');
});
test('row B: a wallet that bought a Subnano post and then paid the API in its next block is a real payer (the fee send is BEFORE, not after)', () => {
  // Read from the API send forward there is nothing after it, and the send is minutes old: false. Until 2026-09-30 the
  // older neighbour counted too and this payment was refused as a checkout send (trollhunters, 2026-09-29).
  assert.equal(feePassthrough([share(600)], FEE_COLLECTORS, ME, HASH, NOW), false);
});
test('the share followed by anything but a fee send -> not a checkout wallet', () => {
  assert.equal(feePassthrough([share(), other], FEE_COLLECTORS, ME, HASH, NOW), false);
  assert.equal(feePassthrough([share(), receive], FEE_COLLECTORS, ME, HASH, NOW), false);
});
test('the share alone: false once it is older than a minute, null while its fee block may still follow', () => {
  assert.equal(feePassthrough([share(61)], FEE_COLLECTORS, ME, HASH, NOW), false);
  assert.equal(feePassthrough([share(5)], FEE_COLLECTORS, ME, HASH, NOW), null);
});
test('rows that do not start with the send, or no rows at all, cannot tell: null, never "proven real payer"', () => {
  assert.equal(feePassthrough([], FEE_COLLECTORS, ME, HASH, NOW), null);   // an empty history answered false before 2026-09-30 (pyfile-toolkit)
  assert.equal(feePassthrough(undefined, FEE_COLLECTORS, ME, HASH, NOW), null);
  assert.equal(feePassthrough([other, fee], FEE_COLLECTORS, ME, HASH, NOW), null);            // another block at the head
  assert.equal(feePassthrough([{ ...share(), account: BUYER }, fee], FEE_COLLECTORS, ME, HASH, NOW), null);   // the head is not a send to us
});
test('per send: the same wallet answers differently for two of its sends', () => {
  const H2 = '23'.repeat(32);
  assert.equal(feePassthrough([share(), fee], FEE_COLLECTORS, ME, HASH, NOW), true);
  assert.equal(feePassthrough([{ ...share(600), hash: H2 }, other], FEE_COLLECTORS, ME, H2, NOW), false);
});
