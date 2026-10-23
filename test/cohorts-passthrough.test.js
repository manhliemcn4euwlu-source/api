'use strict';
// node --test test/cohorts-passthrough.test.js  (run from api/)
// One buyer paying through two one-time pass-through wallets is ONE counterparty on
// the home page (site.counterpartyNumbers, via passthroughSources) and must be one
// here too. Today /cohorts counts each wallet as its own independently-earned address.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCohorts, totalsOf } = require('../cohorts');
const { ADDRESS } = require('../site');

const US = ADDRESS;
const BUYER = 'nano_1oatxz8ha1j55m4wzkkgmpoyyn4gr9bgu9snnfyqc6toawb5ht5e8w4x6s9o';
const P1 = 'nano_3gmd94aey5nxrntgjrznnbssh3s7htyubeq91x8qgjpbe8qk59xiarf1homu';
const P2 = 'nano_16qcqjhqkgopyq6dtuoarwosma8z51asec4t5zki3eq78yiuz7i5kd7bdzyh';
const XNO = 10n ** 30n;
const T0 = 1_788_800_000;

// A one-time wallet: opened by a single receive from BUYER, emptied to us 30 s later.
const walletHistory = (wallet) => [
  { type: 'receive', subtype: 'receive', account: BUYER, amount: String(XNO / 10n), hash: 'IN-' + wallet.slice(5, 9), height: '1', local_timestamp: String(T0) },
  { type: 'send', subtype: 'send', account: US, amount: String(XNO / 10n), hash: 'OUT-' + wallet.slice(5, 9), height: '2', local_timestamp: String(T0 + 30) },
];

const rpc = async body => {
  if (body.action === 'account_history' && body.account === US)
    return { history: [
      { type: 'state', subtype: 'receive', account: P1, amount: String(XNO / 10n), hash: 'IN-3gmd', height: '1', local_timestamp: String(T0) },
      { type: 'state', subtype: 'receive', account: P2, amount: String(XNO / 10n), hash: 'IN-1y95', height: '2', local_timestamp: String(T0 + 60) },
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

test('two one-time wallets of one buyer are one counterparty, not two', async () => {
  const d = await computeCohorts({ ledger, rpc });
  assert.deepEqual(d.rows.map(r => r.address), [BUYER],
    'both payments were funded by BUYER, so the row belongs to BUYER; got ' +
    JSON.stringify(d.rows.map(r => [r.address.slice(0, 12), r.funding, r.counts_as_counterparty])));
  assert.equal(d.totals.counterparties, 1, 'two wallets of one buyer are one counterparty');
  // the money is not lost in the fold: both payments stay on the row
  assert.equal(d.rows[0].received_raw, (XNO / 5n).toString(), 'both 0.1 XNO payments are still counted');
  assert.equal(d.rows[0].received_count, 2);
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
