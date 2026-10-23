// node --test  (run from api/). Pure classification logic with mocked chain and ledger rows.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, collect, addChainOnly, isRefund, totalsOf, computeCohorts, markdown, ZERO, SCAN } = require('../cohorts');
const { ADDRESS } = require('../site');

const US = ADDRESS;
const A = 'nano_3s1m5exgw9rjeohudkrapco6hh46c8mp3ky87kac3tg6ysm3fuof7dunrxtz';
const B = 'nano_17kan9js3g53c7dtou9o9ixncwnax6iuzobgiukhzmc8gp3ai45pa6q9sq5f';
const FUNDER = 'nano_3gchoita7jmtofp69goiowyrytnfdjz1srz9fy9t1jygagjiej1eqo7ecpe8';
const XNO = 10n ** 30n;
const T0 = 1_788_800_000; // some unix time
const DAY = 86400;

const blk = (o) => ({ type: 'state', local_timestamp: String(o.at), amount: String(o.amount ?? XNO / 10n), hash: o.hash, previous: o.previous || 'P', height: String(o.height || 1), subtype: o.subtype, account: o.account, link: o.link || 'L' });
const cp = (address, extra = {}) => ({ address, ledger_out: [], ledger_in: [], reasons: [], initiative_ids: [], ...extra });

test('a failed outbound-history lookup is unknown, not proof of no spending', async () => {
  const grant = blk({ subtype: 'send', account: A, hash: 'GRANT', at: T0 });
  const opened = blk({ subtype: 'receive', account: US, hash: 'OPEN', link: 'GRANT', previous: ZERO, at: T0 + 1 });
  const ledger = [{ id: 1, kind: 'payment_out', counterparty: A, amount_raw: grant.amount, block_hash: 'GRANT' }];
  const rpc = async body => {
    if (body.action === 'account_history' && body.account === US) return { history: [grant] };
    if (body.action === 'account_info') return { open_block: 'OPEN' };
    if (body.action === 'account_history' && body.head) return { error: 'History unavailable' };
    if (body.action === 'account_history') return { history: [opened] };
    throw new Error('unexpected fixture RPC');
  };
  const result = await computeCohorts({ ledger, rpc });
  assert.equal(result.rows[0].first_spend_status, 'unknown');
  assert.match(result.rows[0].chain_error, /History unavailable/);
  assert.equal(result.rows[0].paid_raw, grant.amount);
});

test('computeCohorts does not reintroduce a ledger refund from chain history', async () => {
  const refund = blk({ subtype: 'send', account: A, hash: 'REFUND', at: T0 });
  const ledger = [{ id: 1, kind: 'payment_out', counterparty: A, amount_raw: '1', block_hash: 'REFUND', meta_json: '{"refund":true}' }];
  const rpc = async body => {
    if (body.action === 'account_history' && body.account === US) return { history: [refund] };
    if (body.action === 'account_info') return { error: 'Account not found' };
    throw new Error('unexpected fixture RPC');
  };
  const result = await computeCohorts({ ledger, rpc });
  assert.deepEqual(result.rows, []);
  assert.equal(result.totals.paid_raw, '0');
});

test('a returned payment does not turn a grant recipient into a repeat buyer', async () => {
  const grant = blk({ subtype: 'send', account: A, hash: 'GRANT', at: T0 });
  const refundSend = blk({ subtype: 'send', account: US, hash: 'BACK', at: T0 + 20, height: 2 });
  const refundReceive = blk({ subtype: 'receive', account: A, hash: 'REFUND-RECEIVE', link: 'BACK', at: T0 + 21 });
  const opened = blk({ subtype: 'receive', account: US, hash: 'OPEN', link: 'GRANT', previous: ZERO, at: T0 + 1 });
  const ledger = [
    { id: 1, kind: 'payment_out', counterparty: A, amount_raw: grant.amount, block_hash: 'GRANT' },
    { id: 2, kind: 'payment_in', counterparty: A, amount_raw: refundReceive.amount, block_hash: 'REFUND-RECEIVE', reason: 'Refund of change' }
  ];
  const rpc = async body => {
    if (body.action === 'account_history' && body.account === US) return { history: [grant, refundReceive] };
    if (body.action === 'account_info') return { open_block: 'OPEN' };
    if (body.action === 'account_history' && body.account === A) return { history: [opened, refundSend] };
    throw new Error('unexpected fixture RPC');
  };
  const result = await computeCohorts({ ledger, rpc });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].paid_count, 1);
  assert.equal(result.rows[0].received_count, 0);
  assert.equal(result.rows[0].funding.paid_us, false);
  assert.equal(result.rows[0].interactions.repeat, false);
  assert.equal(result.rows[0].first_spend, null);
  assert.equal(result.rows[0].first_spend_status, 'none_yet');
  assert.equal(result.totals.received_raw, '0');
});

test('refund filtering does not hide an exhausted first-spend scan', async () => {
  const grant = blk({ subtype: 'send', account: A, hash: 'GRANT', at: T0 });
  const refundSend = blk({ subtype: 'send', account: US, hash: 'BACK', at: T0 + 2, height: 2 });
  const refundReceive = blk({ subtype: 'receive', account: A, hash: 'REFUND-RECEIVE', link: 'BACK', at: T0 + 3 });
  const opened = blk({ subtype: 'receive', account: US, hash: 'OPEN', link: 'GRANT', previous: ZERO, at: T0 + 1 });
  const fullScan = [opened, refundSend, ...Array.from({ length: SCAN - 2 }, (_, i) =>
    blk({ subtype: 'receive', account: 'nano_x', hash: 'H' + i, at: T0 + 4 + i, height: 3 + i }))];
  const ledger = [
    { id: 1, kind: 'payment_out', counterparty: A, amount_raw: grant.amount, block_hash: 'GRANT' },
    { id: 2, kind: 'payment_in', counterparty: A, amount_raw: refundReceive.amount, block_hash: 'REFUND-RECEIVE', reason: 'Refund of change' }
  ];
  const rpc = async body => {
    if (body.action === 'account_history' && body.account === US) return { history: [grant, refundReceive] };
    if (body.action === 'account_info') return { open_block: 'OPEN' };
    if (body.action === 'account_history' && body.head) return { history: fullScan };
    if (body.action === 'account_history' && body.account === A) return { history: [opened, refundSend] };
    throw new Error('unexpected fixture RPC');
  };
  const result = await computeCohorts({ ledger, rpc });
  assert.equal(result.rows[0].first_spend, null);
  assert.equal(result.rows[0].first_spend_status, 'unknown');
});

test('opened by our payment: receive of our send is the open block', () => {
  const ourSend = blk({ subtype: 'send', account: A, hash: 'S1', at: T0, height: 3 });
  const theirOpen = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: ZERO, at: T0 + 5, height: 1 });
  const r = classify(cp(A, { ledger_out: [{ amount_raw: '1' }] }), { ourSends: [ourSend], ourReceives: [], exists: true, info: {}, withUs: [theirOpen], after: [theirOpen], open: null });
  assert.equal(r.wallet_state, 'opened_by_us');
  assert.deepEqual(r.funding, { grant_funded: true, independently_earned: false, paid_us: false });
  assert.equal(r.first_receipt.hash, 'R1');
  assert.equal(r.first_spend_status, 'none_yet');
  assert.equal(r.interactions.count, 1);
  assert.equal(r.interactions.repeat, false);
});

test('already funded: account had blocks before our send', () => {
  const ourSend = blk({ subtype: 'send', account: B, hash: 'S1', at: T0, height: 3 });
  const theirRecv = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: 'OLD', at: T0 + 5, height: 40 });
  const open = { local_timestamp: String(T0 - 90 * DAY) };
  const r = classify(cp(B), { ourSends: [ourSend], ourReceives: [], exists: true, info: {}, withUs: [theirRecv], after: [theirRecv], open });
  assert.equal(r.wallet_state, 'already_funded');
});

test('opened after our send by another payment is not counted as opened by us', () => {
  const ourSend = blk({ subtype: 'send', account: B, hash: 'S1', at: T0, height: 3 });
  const theirRecv = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: 'X', at: T0 + 100, height: 2 });
  const open = { local_timestamp: String(T0 + 50) };
  const r = classify(cp(B), { ourSends: [ourSend], ourReceives: [], exists: true, info: {}, withUs: [theirRecv], after: [theirRecv], open });
  assert.equal(r.wallet_state, 'opened_later_by_other');
});

test('unopened: our send not yet received', () => {
  const ourSend = blk({ subtype: 'send', account: A, hash: 'S1', at: T0, height: 3 });
  const r = classify(cp(A), { ourSends: [ourSend], ourReceives: [], exists: false, info: { error: 'Account not found' }, withUs: [], after: [], open: null });
  assert.equal(r.wallet_state, 'unopened');
  assert.equal(r.first_receipt.pending, true);
  assert.equal(r.first_spend_status, 'n/a');
});

test('n/a and independently earned: they paid us, we never paid them', () => {
  const theirSend = blk({ subtype: 'send', account: US, hash: 'T1', at: T0, height: 9 });
  const r = classify(cp(B, { ledger_in: [{ amount_raw: '1' }] }), { ourSends: [], ourReceives: [blk({ subtype: 'receive', account: B, hash: 'R9', at: T0 + 1 })], exists: true, info: {}, withUs: [theirSend], after: [], open: null });
  assert.equal(r.wallet_state, 'n/a');
  assert.deepEqual(r.funding, { grant_funded: false, independently_earned: true, paid_us: true });
  assert.equal(r.first_receipt, null);
  assert.equal(r.received_count, 1);
});

test('both flags when we paid them and they later paid us; first spend to us', () => {
  const ourSend = blk({ subtype: 'send', account: B, hash: 'S1', at: T0, height: 3 });
  const theirRecv = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: ZERO, at: T0 + 5, height: 1 });
  const theirSend = blk({ subtype: 'send', account: US, hash: 'T1', at: T0 + 10, height: 2 });
  const r = classify(cp(B), { ourSends: [ourSend], ourReceives: [], exists: true, info: {}, withUs: [theirRecv, theirSend], after: [theirRecv, theirSend], open: null });
  assert.deepEqual(r.funding, { grant_funded: true, independently_earned: false, paid_us: true });
  assert.equal(r.first_spend_status, 'to_us');
  assert.equal(r.first_spend.to_us, true);
  assert.equal(r.interactions.count, 2);
  assert.equal(r.interactions.repeat, true);
});

test('first spend elsewhere; a receive after ours is not a spend', () => {
  const ourSend = blk({ subtype: 'send', account: B, hash: 'S1', at: T0, height: 3 });
  const theirRecv = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: ZERO, at: T0 + 5, height: 1 });
  const other = blk({ subtype: 'receive', account: 'nano_other', hash: 'R2', at: T0 + 6, height: 2 });
  const out = blk({ subtype: 'send', account: 'nano_1elsewhere', hash: 'O1', at: T0 + 7, height: 3 });
  const r = classify(cp(B), { ourSends: [ourSend], ourReceives: [], exists: true, info: {}, withUs: [theirRecv], after: [theirRecv, other, out], open: null });
  assert.equal(r.first_spend_status, 'elsewhere');
  assert.equal(r.first_spend.to, 'nano_1elsewhere');
  assert.equal(r.first_spend.hash, 'O1');
});

test('first spend unknown when the scan window is exhausted', () => {
  const ourSend = blk({ subtype: 'send', account: B, hash: 'S1', at: T0, height: 3 });
  const theirRecv = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: ZERO, at: T0 + 5, height: 1 });
  const after = [theirRecv, ...Array.from({ length: SCAN - 1 }, (_, i) => blk({ subtype: 'receive', account: 'nano_x', hash: 'H' + i, at: T0 + 6 + i, height: 2 + i }))];
  const r = classify(cp(B), { ourSends: [ourSend], ourReceives: [], exists: true, info: {}, withUs: [theirRecv], after, afterScanExhausted: true, open: null });
  assert.equal(r.first_spend_status, 'unknown');
});

test('repeat detection: second interaction inside 30 days counts, outside does not', () => {
  const s1 = blk({ subtype: 'send', account: A, hash: 'S1', at: T0, height: 1 });
  const s2 = blk({ subtype: 'send', account: A, hash: 'S2', at: T0 + 10 * DAY, height: 2 });
  const s3 = blk({ subtype: 'send', account: A, hash: 'S3', at: T0 + 45 * DAY, height: 3 });
  const recv = blk({ subtype: 'receive', account: US, hash: 'R1', link: 'S1', previous: ZERO, at: T0 + 1, height: 1 });
  const chain = (sends) => ({ ourSends: sends, ourReceives: [], exists: true, info: {}, withUs: [recv], after: [recv], open: null });
  const one = classify(cp(A), chain([s1, s3]));
  assert.equal(one.interactions.count, 2);
  assert.equal(one.interactions.within_30d, 1);
  assert.equal(one.interactions.repeat, false);
  const rep = classify(cp(A), chain([s1, s2, s3]));
  assert.equal(rep.interactions.within_30d, 2);
  assert.equal(rep.interactions.repeat, true);
  // a send from them to us also counts as an interaction
  const back = blk({ subtype: 'send', account: US, hash: 'T1', at: T0 + 2 * DAY, height: 2 });
  const both = classify(cp(A), { ...chain([s1]), withUs: [recv, back] });
  assert.equal(both.interactions.count, 2);
  assert.equal(both.interactions.repeat, true);
});

test('collect: own addresses, tranches, non-address counterparties and refund-flagged rows are excluded', () => {
  const ledger = [
    { id: 1, kind: 'tranche', counterparty: 'cold', amount_raw: '5', reason: 'Tranche for request #1', block_hash: 'TR' },
    { id: 2, kind: 'payment_out', counterparty: US, amount_raw: '1', reason: 'to self' },
    { id: 3, kind: 'payment_out', counterparty: FUNDER, amount_raw: '1', reason: 'to funder' },
    { id: 4, kind: 'payment_out', counterparty: A, amount_raw: '1', reason: 'first job', initiative_id: 7 },
    { id: 5, kind: 'payment_in', counterparty: A, amount_raw: '1', reason: 'Received' },
    { id: 6, kind: 'payment_out', counterparty: B, amount_raw: '1', reason: 'Refund of an overpayment' },
    { id: 7, kind: 'payment_in', counterparty: B, amount_raw: '1', reason: 'Received', meta_json: '{"refund":true}' },
    { id: 8, kind: 'cost', counterparty: null, amount_raw: '1', reason: 'domain' },
    { id: 9, kind: 'payment_in', counterparty: 'not-an-address', amount_raw: '1', reason: 'x' }
  ];
  const cps = collect(ledger, new Set([US, FUNDER]));
  assert.deepEqual([...cps.keys()], [A]);
  const a = cps.get(A);
  assert.equal(a.ledger_out.length, 1);
  assert.equal(a.ledger_in.length, 1);
  assert.deepEqual(a.reasons, ['first job', 'Received']);
  assert.deepEqual(a.initiative_ids, [7]);
  assert.equal(isRefund(ledger[5]), true);
  assert.equal(isRefund(ledger[6]), true);
  assert.equal(isRefund(ledger[3]), false);
});

test('addChainOnly: chain-only destinations are added, own and funder addresses are not', () => {
  const ours = [blk({ subtype: 'receive', account: FUNDER, hash: 'X', at: T0 }), blk({ subtype: 'send', account: B, hash: 'Y', at: T0 }), blk({ subtype: 'change', account: US, hash: 'Z', at: T0 })];
  const cps = addChainOnly(new Map(), ours, new Set([US, FUNDER]));
  assert.deepEqual([...cps.keys()], [B]);
  assert.match(cps.get(B).reasons[0], /not in the ledger/);
});

test('computeCohorts end to end with a mocked node: funder found via the tranche block and excluded', async () => {
  const tranche = blk({ subtype: 'receive', account: FUNDER, hash: 'TRH', link: 'FSEND', at: T0 - 10, height: 1 });
  const sendA = blk({ subtype: 'send', account: A, hash: 'SA', at: T0, height: 2, amount: XNO / 5n });
  const sendB = blk({ subtype: 'send', account: B, hash: 'SB', at: T0 + 1, height: 3 });
  const recvB = blk({ subtype: 'receive', account: B, hash: 'RB', link: 'TB', at: T0 + 3, height: 4 });
  const bOpen = blk({ subtype: 'receive', account: US, hash: 'BO', link: 'SB', previous: ZERO, at: T0 + 2, height: 1 });
  const bSend = blk({ subtype: 'send', account: US, hash: 'TB', at: T0 + 2.5, height: 2 });
  const calls = [];
  const rpc = async (body) => {
    calls.push(body);
    if (body.action === 'account_history' && body.account === US) return { history: [tranche, sendA, sendB, recvB] };
    if (body.action === 'block_info' && body.hash === 'TRH') return { contents: { link: 'FSEND' } };
    if (body.action === 'block_info' && body.hash === 'FSEND') return { block_account: FUNDER };
    if (body.action === 'account_info') return body.account === B ? { open_block: 'BO', block_count: '2' } : { error: 'Account not found' };
    if (body.action === 'account_history' && body.account === B) return { history: [bOpen, bSend] };
    throw new Error('unexpected rpc ' + JSON.stringify(body));
  };
  const ledger = [
    { id: 1, ts: '2026-09-06T23:13:52Z', kind: 'tranche', counterparty: 'cold', amount_raw: '42', reason: 'Tranche for request #2', block_hash: 'TRH' },
    { id: 2, ts: '2026-09-07T16:48:33Z', kind: 'payment_out', counterparty: A, amount_raw: (XNO / 5n).toString(), reason: 'Ӿ0.2 for an answer. Budget is Ӿ10,000 in total.', initiative_id: 7, block_hash: 'SA' }
  ];
  const d = await computeCohorts({ ledger, rpc });
  assert.deepEqual(d.rows.map(r => r.address).sort(), [A, B].sort());
  const a = d.rows.find(r => r.address === A), b = d.rows.find(r => r.address === B);
  assert.equal(a.wallet_state, 'unopened');
  assert.equal(a.paid_raw, (XNO / 5n).toString());
  assert.match(a.reasons[0], /\[withheld\]/); // redact() applies to ledger reasons
  assert.equal(b.wallet_state, 'opened_by_us');
  assert.equal(b.funding.paid_us, true);
  assert.equal(b.first_spend_status, 'to_us');
  assert.equal(b.interactions.repeat, true);
  assert.equal(d.totals.counterparties, 2);
  assert.equal(d.totals.wallet_state.opened_by_us, 1);
  assert.equal(d.totals.funding.grant_funded_and_paid_us, 1);
  assert.ok(!calls.some(c => c.action === 'account_info' && c.account === FUNDER), 'funder address never queried as a counterparty');
  const md = markdown(d);
  assert.match(md, /\| address \| wallet state \|/);
  assert.doesNotMatch(md, /10,000/);
  assert.equal(JSON.stringify(totalsOf(d.rows)), JSON.stringify(d.totals));
});

test('totals: dust senders are listed but not counted as counterparties; paid addresses count regardless', () => {
  const mk = (address, paid, received, paidCount) => ({ address, wallet_state: 'unknown', funding: { grant_funded: paidCount > 0, independently_earned: false, paid_us: received > 0n }, first_spend_status: 'unknown', interactions: { count: 0, repeat: false }, paid_raw: paid.toString(), paid_count: paidCount, received_raw: received.toString(), received_count: received > 0n ? 1 : 0 });
  const rows = [mk(A, 0n, XNO / 1000n, 0), mk(B, XNO / 10n, 0n, 1), mk(FUNDER, 0n, XNO / 100n, 0)];
  const t = totalsOf(rows);
  assert.equal(t.counterparties, 2);
  assert.equal(t.below_threshold, 1);
  assert.equal(t.min_nano, '0.01');
});
