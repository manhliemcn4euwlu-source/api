// node --test  (run from api/). /v1/verify used to answer every node error as found:false, the same answer a block that
// is genuinely not on the chain gets. The skill's no-node.js reads found:false as "positively not on the chain" and
// rebuilds and broadcasts a send, so a node outage on this box told a payer whose send had landed to pay again
// (llmrt, 2026-10-23; c7cf798 fixed the client for this class the same day, the route it calls was not fixed).
// Now only the node's own not-found answers found:false; every other failure is 502 and carries no found field.
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.NANO_RPC = 'http://node.test/rpc';
const DATA_DIR = path.join(__dirname, '..', 'data') + path.sep;
const inData = (p) => String(p).startsWith(DATA_DIR);
const realWrite = fs.writeFileSync, realAppend = fs.appendFileSync;
const realOpen = fs.openSync, realRename = fs.renameSync, realCopy = fs.copyFileSync, realUnlink = fs.unlinkSync;
const SCRATCH = path.join(require('node:os').tmpdir(), 'verify-node-error-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { server, loadPurposes } = require('../server');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

const TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FROM = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
const HASH = 'CD'.repeat(32);

// What the node answers for this hash; each test sets it before calling the route.
let nodeAnswer = null;
globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  if (b.action !== 'block_info') return { ok: true, json: async () => ({ error: 'unexpected rpc ' + b.action }) };
  if (nodeAnswer instanceof Error) throw nodeAnswer;
  return { ok: true, json: async () => nodeAnswer };
};
async function get(pathqs) {
  const res = { headers: {}, status: null, body: null, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; }, writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  await server.listeners('request')[0]({ url: pathqs, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}
const verify = (qs) => get('/v1/verify?' + qs);

test('a block the node does not hold: 404, found:false, the absence answer callers branch on', async () => {
  nodeAnswer = { error: 'Block not found' };
  const r = await verify('hash=' + HASH + '&any=1&any_to=1');
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(r.body.found, false);
  assert.match(r.body.error, /block not found on this node/);
});

// The point of the fix: these are not "absent". A caller that reads found:false as "not on the chain" rebuilds the
// payment and broadcasts a second block, which is how a landed send became a double payment.
for (const [name, answer] of [
  ['a node error', { error: 'Database read failed' }],
  ['a proxy refusal', { error: 'HTTP 429 Too Many Requests' }],
  ['a node that is still syncing', { error: 'Account not found in ledger' }],
]) {
  test(name + ' on block_info: 502, and no found field to read as absent', async () => {
    nodeAnswer = answer;
    const r = await verify('hash=' + HASH + '&any=1&any_to=1');
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal('found' in r.body, false, 'no found field: absence is not claimed');
    assert.equal(r.body.hash, HASH);
    assert.match(r.body.error, /could not answer for this hash/);
    assert.match(r.body.note, /do not rebuild a payment/);
  });
}

test('a thrown transport failure is not answered as absent either', async () => {
  nodeAnswer = new Error('fetch failed');
  const r = await get('/v1/verify?hash=' + HASH + '&any=1&any_to=1');
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal('found' in r.body, false, 'a transport failure never says the block is absent');
  assert.match(r.body.error, /could not be reached for this hash/);
  assert.match(r.body.note, /do not rebuild a payment/);
});

test('a block the node holds still answers 200 with found:true', async () => {
  nodeAnswer = { block_account: FROM, subtype: 'send', amount: '5000', confirmed: 'true', height: '3', local_timestamp: '1758000000', contents: { link_as_account: TO } };
  const r = await verify('hash=' + HASH + '&any=1&to=' + TO);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.found, true); assert.equal(r.body.ok, true);
});

// The same root cause on the route a payer polls to learn whether its send became credit. Told "not found yet" during an
// outage, a payer may send again, and the second send is a second payment.
test('/v1/credit: a node error is 502 and says the credit is unknown, not zero', async () => {
  await loadPurposes();   // the bearer path refuses every hash until the purpose registry is loaded
  nodeAnswer = { error: 'Database read failed' };
  const r = await get('/v1/credit?hash=' + HASH);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.unknown, true);
  assert.match(r.body.error, /credit is unknown right now, not zero/);
  assert.match(r.body.note, /do not send again/);
});

test('/v1/credit: a thrown transport failure is 502 with the same words', async () => {
  nodeAnswer = new Error('fetch failed');
  const r = await get('/v1/credit?hash=' + HASH);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.equal(r.body.unknown, true);
  assert.match(r.body.error, /could not be reached to look up this hash/);
});

test('/v1/credit: a hash the node does not hold still answers 400 "not found yet", unchanged', async () => {
  nodeAnswer = { error: 'Block not found' };
  const r = await get('/v1/credit?hash=' + HASH);
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.unknown, undefined);
  assert.match(r.body.error, /block not found on this node yet/);
});

test('/v1/credit: a bad hash is still 400 and is not marked unknown', async () => {
  const r = await get('/v1/credit?hash=zzz');
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.unknown, undefined);
  assert.equal(r.body.error, 'bad hash');
});
