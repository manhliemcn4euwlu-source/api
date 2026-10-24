// node --test (run from api/). The facilitator's documented code for "node unreachable" is node_unavailable. The first node call
// /verify and /settle make is the block_info inside seen() (check 7, the replay check), and it was not wrapped: a node that is
// down, times out or answers a non-2xx page threw out of seen(), verify's outer catch turned it into "verify error: ...", and
// codeFor() mapped that to the generic invalid_payment. A resource server branching on the code then treated a transient
// outage as an invalid payment. The existing "node down -> node_unavailable" test answers block_info and fails account_info
// only, so it never reached this path.
'use strict';
require('./guard-data');
process.env.BROADCAST_FILE = require('node:path').join(require('node:os').tmpdir(), 'pk-broadcast-nodedown-' + process.pid + '.json');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('nanocurrency');
const f = require('../facilitator');

const PAY_TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const REQ = { scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', payTo: PAY_TO, amount: (10n ** 27n).toString(), maxTimeoutSeconds: 5 };
const FRONTIER = '4DA37CC62F040730D14E9D57A83D3810C54CBFF1C7A389E477F5A290B28A688F';

// The three ways server.js rpc() fails when the node is not there: undici's transport error, a proxy's non-2xx page
// (rpc() throws "rpc HTTP <status>"), and the RPC_TIMEOUT_MS abort.
for (const failure of ['fetch failed', 'rpc HTTP 502', 'The operation was aborted due to timeout']) {
  test(`verify and settle with the node down (${failure}) -> node_unavailable, as documented`, async () => {
    const sk = N.deriveSecretKey(await N.generateSeed(), 0);
    const payer = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
    const { block } = N.createBlock(sk, { work: '0000000000000001', previous: FRONTIER, representative: payer, balance: '1', link: PAY_TO });
    block.account = block.account.replace(/^xrb_/, 'nano_');
    const body = { x402Version: 2, paymentPayload: { x402Version: 2, accepted: REQ, payload: { block } }, paymentRequirements: REQ };
    const deps = { rpc: async () => { throw new Error(failure); } };
    const v = await f.verifyRequest(body, deps);
    assert.equal(v.isValid, false);
    assert.equal(v.invalidReason, 'node_unavailable', v.invalidMessage);
    const s = await f.settleRequest(body, deps);
    assert.equal(s.success, false);
    assert.equal(s.errorReason, 'node_unavailable', s.errorMessage);
    assert.equal(s.transaction, '');
  });
}
