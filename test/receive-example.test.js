// node --test (run from api/). examples/receive.js says "Receive every pending send into a Nano account". It asks the
// node's `receivable` RPC once with count 50 and pockets that page, so an account with more than 50 pending sends is
// left with the rest pending, exit 0, and nothing on stderr. The stand: the real script in a child process against a
// loopback node whose receivable honours `count`, with 53 sends pending. No data/ writes (the script writes nothing).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const N = require('nanocurrency');

const SCRIPT = path.join(__dirname, '..', 'examples', 'receive.js');
const PENDING = 53;

test('receive.js pockets every pending send, not only the first page of the receivable RPC', { timeout: 60000 }, async t => {
  const seed = randomBytes(32).toString('hex');
  const pub = N.derivePublicKey(N.deriveSecretKey(seed, 0));
  const account = N.deriveAddress(pub, { useNanoPrefix: true });
  const from = N.deriveAddress(N.derivePublicKey(randomBytes(32).toString('hex')), { useNanoPrefix: true });
  const pending = new Map();
  for (let i = 0; i < PENDING; i++) pending.set(randomBytes(32).toString('hex').toUpperCase(), String(10n ** 27n));
  let frontier = null, balance = 0n;
  const errors = [];
  const node = http.createServer(async (req, res) => {
    let t = ''; for await (const c of req) t += c;
    const b = JSON.parse(t), out = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
      if (b.action === 'receivable') {
        assert.equal(b.account, account);
        const page = [...pending].slice(0, Number(b.count));   // a node answers at most `count` hashes
        return out({ blocks: Object.fromEntries(page.map(([h, amount]) => [h, { amount, source: from }])) });
      }
      if (b.action === 'account_info') return frontier ? out({ frontier, balance: balance.toString(), representative: account }) : out({ error: 'Account not found' });
      if (b.action === 'work_generate') return out({ work: '0'.repeat(16) });
      if (b.action === 'process') {
        const blk = b.block;
        assert.equal(blk.previous, frontier || '0'.repeat(64));
        assert.ok(pending.has(blk.link), 'link is a pending send');
        assert.equal(blk.balance, (balance + BigInt(pending.get(blk.link))).toString());
        const h = N.hashBlock(blk);
        balance = BigInt(blk.balance); pending.delete(blk.link); frontier = h;
        return out({ hash: h });
      }
      throw new Error('unexpected rpc ' + b.action);
    } catch (e) { errors.push(e.message); out({ error: e.message }); }
  });
  await new Promise(r => node.listen(0, '127.0.0.1', r));
  t.after(() => { node.closeAllConnections(); node.close(); });
  const rpc = 'http://127.0.0.1:' + node.address().port;
  const { stdout, stderr } = await new Promise((resolve, reject) => execFile(process.execPath, [SCRIPT],
    { env: { NANO_SEED: seed, NANO_RPC: rpc, NANO_REP: account, PATH: process.env.PATH, NODE_PATH: path.join(__dirname, '..', 'node_modules') }, timeout: 50000, maxBuffer: 1 << 20 },
    (e, so, se) => e ? reject(Object.assign(e, { stdout: so, stderr: se })) : resolve({ stdout: so, stderr: se })));
  assert.deepEqual(errors, []);
  t.diagnostic('pocketed ' + stdout.trim().split('\n').filter(Boolean).length + ' of ' + PENDING + '; still pending ' + pending.size);
  assert.equal(pending.size, 0, 'every pending send is received; stderr: ' + stderr.trim().split('\n').slice(-2).join(' | '));
  assert.equal(balance, BigInt(PENDING) * 10n ** 27n);
});
