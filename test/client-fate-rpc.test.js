// node --test  (run from api/). The fate of an unserved payment read through NANO_RPC (examples/client-x402.js fateOf).
// After a lost reply the client reads the account; when the frontier is neither the block nor its previous, it asks the
// node for the block by hash. Only the node's "Block not found" proves the block is not on the chain ('dead': sign a new
// block). Any other answer (a rate limiter's or a degraded node's JSON error) is "cannot tell", as the comment above
// fateOf and the /v1/verify branch both say. Read as 'dead', the client told the payer to sign a new block for a payment
// that had landed: a second payment for the same call.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const N = require('nanocurrency');

const CLIENT = path.join(__dirname, '..', 'examples', 'client-x402.js');
const SEED = '0'.repeat(64);   // throwaway: never funded, never opened on the chain
const PAY_TO = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(SEED, 1)), { useNanoPrefix: true });
const AMOUNT = '1000000000000000000000000';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = s => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const randomHash = () => require('node:crypto').randomBytes(32).toString('hex').toUpperCase();

// One loopback server is the seller (/buy) and the node RPC (POST /rpc). The paid call lands the block, another block
// lands right after it (an auto-receive), and the reply is lost. block_info answers with opts.blockInfoError.
function mock(opts) {
  const state = { frontier: randomHash(), balance: '5000000000000000000000000000', landed: null, blockInfo: 0 };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      const json = (code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (req.url === '/rpc') {
        const b = JSON.parse(body);
        if (b.action === 'account_info') return json(200, { frontier: state.frontier, balance: state.balance, representative: PAY_TO, block_count: '3' });
        if (b.action === 'block_info') {
          state.blockInfo++;
          if (opts.blockInfoError) return json(200, { error: opts.blockInfoError });
          return String(b.hash).toUpperCase() === state.landed ? json(200, { block_account: 'nano_x', subtype: 'send' }) : json(200, { error: 'Block not found' });
        }
        return json(200, { error: 'unexpected ' + b.action });
      }
      const sig = req.headers['payment-signature'];
      if (!sig) {
        const pr = { x402Version: 2, resource: { url: 'http://127.0.0.1/buy' }, accepts: [{ scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', amount: AMOUNT, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { work: 'optional' } }] };
        return json(402, { x402: pr }, { 'payment-required': b64(pr) });
      }
      const block = unb64(sig).payload.block;
      const hash = N.hashBlock({ account: block.account, previous: block.previous, representative: block.representative, balance: block.balance, link: block.link });
      if (opts.land) { state.landed = hash.toUpperCase(); state.frontier = randomHash(); }   // landed, then an auto-receive on top of it
      else if (opts.overtake) state.frontier = randomHash();   // another block from this wallet took the height; this one never lands
      return res.socket.destroy();   // the reply is lost either way
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ state, origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(c => { server.closeAllConnections(); server.close(c); }) })));
}
function run(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-fate-'));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLIENT, origin + '/buy'], { env: { PATH: process.env.PATH, NANO_SEED: SEED, NANO_RPC: origin + '/rpc', API: origin, NANO_MAX_PAY: '0.001', NANO_LOCK_DIR: dir } });
    let out = '', err = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err }));
  });
}

test('NANO_RPC: a block_info error that is not "not found" is "cannot tell", never "sign a new block" (the block had landed)', async () => {
  const m = await mock({ land: true, blockInfoError: 'Too many requests, slow down' });
  const r = await run(m.origin);
  await m.close();
  assert.ok(m.state.landed, 'the payment landed on the chain');
  assert.equal(m.state.blockInfo, 1, 'the client asked the node for the block');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /sign a new block for this call/, 'the block landed; a new block would pay twice:\n' + r.err);
  assert.match(r.err, /could not read the account to tell whether the block was broadcast; check hash [0-9A-F]{64} before paying again/);
});

test('NANO_RPC: "Block not found" with the frontier moved elsewhere is still dead: sign anew', async () => {
  const m = await mock({ land: false, overtake: true });
  const r = await run(m.origin);
  await m.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /sign a new block for this call/, r.err);
});

test('NANO_RPC: a landed block behind a later one is "landed": re-present, do not sign anew', async () => {
  const m = await mock({ land: true });
  const r = await run(m.origin);
  await m.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /the block is on the chain/, r.err);
  assert.doesNotMatch(r.err, /sign a new block for this call/);
});
