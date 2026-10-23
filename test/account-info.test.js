'use strict';
// Offline: shapeAccountInfo over fabricated RPC answers. From Dalton's item-5 report, 2026-09-11:
// the documented confirmation height came back null because only the legacy field names were read.
const {test} = require('node:test');
const assert = require('node:assert/strict');
require('./guard-data');   // every write under data/ is dropped before the server boots (counters, ledgers, logs)
const {shapeAccountInfo} = require('../server');
const F = 'A'.repeat(64), E = 'B'.repeat(64);
const base = {frontier: F, balance: '5000', confirmed_balance: '5000', block_count: '45', representative: 'nano_1rep'};
test('modern node fields (confirmed_frontier, confirmed_height) are surfaced', () => {
  const o = shapeAccountInfo({...base, confirmed_frontier: F, confirmed_height: '45'});
  assert.equal(o.confirmed_frontier, F); assert.equal(o.confirmation_height, 45); assert.equal(o.confirmed, true);
});
test('legacy node fields still work', () => {
  const o = shapeAccountInfo({...base, confirmation_height_frontier: F, confirmation_height: '45'});
  assert.equal(o.confirmed_frontier, F); assert.equal(o.confirmation_height, 45); assert.equal(o.confirmed, true);
});
test('unconfirmed frontier: confirmed is false, height is the confirmed one', () => {
  const o = shapeAccountInfo({...base, confirmed_frontier: E, confirmed_height: '44'});
  assert.equal(o.confirmed_frontier, E); assert.equal(o.confirmation_height, 44); assert.equal(o.confirmed, false);
});
test('no confirmation metadata: nulls and confirmed false, nothing invented', () => {
  const o = shapeAccountInfo({...base});
  assert.equal(o.confirmed_frontier, null); assert.equal(o.confirmation_height, null); assert.equal(o.confirmed, false);
  assert.equal(JSON.parse(JSON.stringify(o)).confirmed_frontier, null, 'null survives serialization; not omitted');
});
test('blank strings count as absent', () => {
  const o = shapeAccountInfo({...base, confirmed_frontier: '', confirmed_height: ''});
  assert.equal(o.confirmed_frontier, null); assert.equal(o.confirmation_height, null);
});
