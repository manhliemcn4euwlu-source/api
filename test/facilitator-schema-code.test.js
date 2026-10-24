// node --test (run from api/). The facilitator's documented code for a PaymentPayload that fails the x402 v2 schema is
// invalid_block (check 2 of the table in its docs: "paymentPayload matches the x402 v2 PaymentPayload schema  invalid_block").
// Since ad48aa9 (2026-10-18) the failing field's path is appended to the reason, and codeFor() then matched that path against
// the later patterns: a schema failure on accepted.network/scheme/asset answered requirements_mismatch and one on
// accepted.payTo invalid_payto, while the same failure on accepted.amount, accepted itself or resource.* stayed invalid_block.
// The code a client branches on depended on which field name the zod issue happened to carry.
'use strict';
require('./guard-data');
process.env.BROADCAST_FILE = require('node:path').join(require('node:os').tmpdir(), 'pk-broadcast-schema-' + process.pid + '.json');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('../facilitator');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const REQ = { scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', payTo: PAY_TO, amount: (10n ** 27n).toString(), maxTimeoutSeconds: 5 };
const block = { type: 'state', account: PAY_TO, previous: '0'.repeat(64), representative: PAY_TO, balance: '1', link: '0'.repeat(64), signature: '0'.repeat(128), work: '0'.repeat(16) };
const deps = { rpc: async b => { throw new Error('the node must not be asked about a payload that fails the schema (' + b.action + ')'); } };

for (const field of ['network', 'scheme', 'asset', 'payTo', 'amount']) {
  test(`verify: accepted.${field} missing fails the PaymentPayload schema -> invalid_block, as documented`, async () => {
    const accepted = { ...REQ }; delete accepted[field];
    const r = await f.verifyRequest({ x402Version: 2, paymentPayload: { x402Version: 2, accepted, payload: { block } }, paymentRequirements: REQ }, deps);
    assert.equal(r.isValid, false);
    assert.match(r.invalidMessage, /does not match x402 v2 PaymentPayload schema/);
    assert.equal(r.invalidReason, 'invalid_block', r.invalidMessage);
  });
}
