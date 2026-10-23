'use strict';
// node --test test/cohorts-passthrough.test.js  (run from api/)
// One buyer paying through two one-time pass-through wallets is ONE counterparty on
// the home page (site.counterpartyNumbers, via passthroughSources) and must be one
// here too. Today /cohorts counts each wallet as its own independently-earned address.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCohorts, totalsOf } = require('../cohorts');
const { ADDRESS, passthroughSources } = require('../site');

// Fixture accounts are synthetic (random keys): the modules under test read data/own-addresses.json and
// data/cold-addresses.json, so a real account used as a fixture collides with the live exclusion lists and the
// test's result depends on which box runs it (that is how one fixture failed here on 2026-10-23).
const US = ADDRESS;
const BUYER = 'nano_38boeia1y1canbfz6makijpd5p8u45mrs44hjjz5rfdmmwfdoi1zoog6u5ot';
const P1 = 'nano_3r5x65cfuaxpise8bgpjr5e5taq1racy8x9joctbub874b1zobnb13sy44ip';
const P2 = 'nano_1max7uajiyhjebuap7cmj6n9xq7ra74485bhqwxzr76amzpximr3ozgh5xgo';
const GRANTEE = 'nano_1whyyk4sndjr6tdxbdr1cr716zt5rkgjb5kjs9jj13zgpdqspn7xjace38s1';
const XNO = 10n ** 30n;
const T0 = 1_788_800_000;

// A one-time wallet: opened by a single receive from BUYER, emptied to us 30 s later.
const walletHistory = (wallet) => {
  const dt = wallet === P2 ? 60 : 0;
  return [
    { type: 'receive', subtype: 'receive', account: BUYER, amount: String(XNO / 10n), hash: 'IN-' + wallet.slice(5, 9), height: '1', local_timestamp: String(T0 + dt) },
    { type: 'send', subtype: 'send', account: US, amount: String(XNO / 10n), hash: 'OUT-' + wallet.slice(5, 9), height: '2', local_timestamp: String(T0 + dt + 30) },
  ];
};

const rpc = async body => {
  if (body.action === 'account_history' && body.account === US)
    return { history: [
      { type: 'state', subtype: 'receive', account: P1, amount: String(XNO / 10n), hash: 'IN-' + P1.slice(5, 9), height: '1', local_timestamp: String(T0) },
      { type: 'state', subtype: 'receive', account: P2, amount: String(XNO / 10n), hash: 'IN-' + P2.slice(5, 9), height: '2', local_timestamp: String(T0 + 60) },
    ] };
  if (body.action === 'account_history' && (body.account === P1 || body.account === P2)) return { history: walletHistory(body.account) };
  if (body.action === 'account_history' && body.account === BUYER) return { history: [] };
  if (body.action === 'account_history') return { history: [] };
  if (body.action === 'account_info') return body.account === P1 || body.account === P2
    ? { frontier: 'F', open_block: 'IN', block_count: '2' }
    : { error: 'Account not found' };
  if (body.action === 'block_info') return { local_timestamp: String(T0), contents: { link: 'L' } };
  throw new Error('unexpected rpc ' + JSON.stringify(body));
};

const ledger = [P1, P2].map((w, i) => ({ id: i + 1, ts: '2026-10-01T00:00:00Z', kind: 'payment_in',
  amount_raw: (XNO / 10n).toString(), counterparty: w, reason: 'Subnano purchase', block_hash: 'IN-' + w.slice(5, 9) }));

test('two one-time wallets of one buyer are one counterparty, not two, and count as repeat within 30 days', async () => {
  const d = await computeCohorts({ ledger, rpc });
  assert.deepEqual(d.rows.map(r => r.address), [BUYER],
    'both payments were funded by BUYER, so the row belongs to BUYER; got ' +
    JSON.stringify(d.rows.map(r => [r.address.slice(0, 12), r.funding, r.counts_as_counterparty])));
  assert.equal(d.totals.counterparties, 1, 'two wallets of one buyer are one counterparty');
  // the money is not lost in the fold: both payments stay on the row
  assert.equal(d.rows[0].received_raw, (XNO / 5n).toString(), 'both 0.1 XNO payments are still counted');
  assert.equal(d.rows[0].received_count, 2);
  assert.equal(d.rows[0].interactions.count, 2);
  assert.equal(d.rows[0].interactions.within_30d, 2);
  assert.equal(d.rows[0].interactions.repeat, true);
  assert.notEqual(d.rows[0].interactions.first_at, d.rows[0].interactions.last_at);
  assert.equal(d.totals.repeat.repeat_within_30d, 1);
  assert.equal(d.totals.repeat.one_off, 0);
});

test('a grant-funded buyer who pays us through a one-time wallet is marked paid_us and repeat_within_30d', async () => {
  const grantLedger = [
    { id: 1, ts: '2026-10-01T00:00:00Z', kind: 'payment_out', amount_raw: (XNO / 5n).toString(), counterparty: BUYER, reason: 'Grant', block_hash: 'GRANT-1' },
    { id: 2, ts: '2026-10-01T00:01:00Z', kind: 'payment_in', amount_raw: (XNO / 10n).toString(), counterparty: P1, reason: 'Subnano purchase', block_hash: 'IN-' + P1.slice(5, 9) },
  ];
  const grantRpc = async body => {
    if (body.action === 'account_history' && body.account === US)
      return { history: [
        { type: 'state', subtype: 'send', account: BUYER, amount: String(XNO / 5n), hash: 'GRANT-1', height: '1', local_timestamp: String(T0) },
        { type: 'state', subtype: 'receive', account: P1, amount: String(XNO / 10n), hash: 'IN-' + P1.slice(5, 9), height: '2', local_timestamp: String(T0 + 30) },
      ] };
    if (body.action === 'account_history' && body.account === P1) return { history: walletHistory(P1) };
    if (body.action === 'account_history' && body.account === BUYER)
      return { history: [
        { type: 'state', subtype: 'receive', account: US, amount: String(XNO / 5n), hash: 'BUYER-OPEN', previous: '0'.repeat(64), link: 'GRANT-1', height: '1', local_timestamp: String(T0 + 5) },
      ] };
    if (body.action === 'account_info') return { frontier: 'F', open_block: 'BUYER-OPEN', block_count: '2' };
    if (body.action === 'block_info') return { local_timestamp: String(T0), contents: { link: 'L' } };
    throw new Error('unexpected rpc ' + JSON.stringify(body));
  };
  const d = await computeCohorts({ ledger: grantLedger, rpc: grantRpc });
  assert.deepEqual(d.rows.map(r => r.address), [BUYER]);
  assert.deepEqual(d.rows[0].funding, { grant_funded: true, independently_earned: false, paid_us: true });
  assert.equal(d.totals.funding.grant_funded, 1);
  assert.equal(d.totals.funding.grant_funded_and_paid_us, 1);
  assert.equal(d.rows[0].interactions.count, 2);
  assert.equal(d.rows[0].interactions.within_30d, 2);
  assert.equal(d.rows[0].interactions.repeat, true);
  assert.equal(d.totals.repeat.repeat_within_30d, 1);
});

test('a grant recipient funded by pursekeeper that returns the grant within an hour is not folded into pursekeeper', async () => {
  const alinaLedger = [
    { id: 1, ts: '2026-09-30T17:07:40Z', kind: 'payment_out', amount_raw: (XNO / 100n).toString(), counterparty: GRANTEE, reason: 'Test transfer', block_hash: 'OUR-SEND' },
    { id: 2, ts: '2026-09-30T17:08:13Z', kind: 'payment_in', amount_raw: (XNO / 100n).toString(), counterparty: GRANTEE, reason: 'Received', block_hash: 'OUR-RECV' },
  ];
  const alinaHistory = [
    { type: 'receive', subtype: 'receive', account: US, amount: String(XNO / 100n), hash: 'G-OPEN', previous: '0'.repeat(64), link: 'OUR-SEND', height: '1', local_timestamp: String(T0) },
    { type: 'send', subtype: 'send', account: US, amount: String(XNO / 100n), hash: 'G-BACK', height: '2', local_timestamp: String(T0 + 28) },
  ];
  const alinaRpc = async body => {
    if (body.action === 'account_history' && body.account === US)
      return { history: [
        { type: 'state', subtype: 'send', account: GRANTEE, amount: String(XNO / 100n), hash: 'OUR-SEND', height: '1', local_timestamp: String(T0) },
        { type: 'state', subtype: 'receive', account: GRANTEE, amount: String(XNO / 100n), hash: 'OUR-RECV', link: 'G-BACK', height: '2', local_timestamp: String(T0 + 29) },
      ] };
    if (body.action === 'account_history' && body.account === GRANTEE) return { history: alinaHistory };
    if (body.action === 'account_info') return { frontier: 'G-BACK', open_block: 'G-OPEN', block_count: '2' };
    throw new Error('unexpected rpc ' + JSON.stringify(body));
  };
  // Even if site.load() calls passthroughSources first with an ownExtra set that omits ADDRESS:
  const via = await passthroughSources(alinaLedger, alinaRpc, new Set());
  assert.equal(via.has(GRANTEE), false, 'an account funded by ADDRESS is not a buyer pass-through wallet');
  const d = await computeCohorts({ ledger: alinaLedger, rpc: alinaRpc });
  assert.deepEqual(d.rows.map(r => r.address), [GRANTEE], 'counterparty row keeps GRANTEE address, never ADDRESS');
});

test('totals keep one denominator: per-state counts add up to the counterparty count', () => {
  const mk = (address, paid, received, paidCount) => ({ address, wallet_state: 'unknown',
    funding: { grant_funded: paidCount > 0, independently_earned: false, paid_us: received > 0n },
    first_spend_status: 'unknown', interactions: { count: 0, repeat: false },
    paid_raw: paid.toString(), paid_count: paidCount, received_raw: received.toString(), received_count: received > 0n ? 1 : 0 });
  // one dust sender below the threshold beside one real counterparty
  const t = totalsOf([mk(BUYER, 0n, XNO / 1000n, 0), mk(P1, XNO / 10n, 0n, 1)]);
  const states = Object.values(t.wallet_state).reduce((a, b) => a + b, 0);
  assert.equal(t.counterparties, 1);
  assert.equal(states, t.counterparties, 'wallet-state buckets sum to ' + states + ' but the page says ' + t.counterparties + ' counterparties');
});
