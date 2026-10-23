// node --test  (run from api/). /v1/verify answers ok:false with the reason when min_raw and min_nano are both missing, since
// 2026-09-29 (pyfile-toolkit, item 5): before that the amount was never checked and ok:true read as "paid". Not a 400: a
// caller that reads only `found` keeps working. any=1 asks only whether the block is a confirmed send to the address and
// the answer says so. Driven through the exported request listener with a mocked node; data/ writes dropped.
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
const SCRATCH = path.join(require('node:os').tmpdir(), 'verify-min-scratch-' + process.pid);
fs.writeFileSync = (p, ...a) => { if (inData(p)) return; return realWrite(p, ...a); };
fs.appendFileSync = (p, ...a) => { if (inData(p)) return; return realAppend(p, ...a); };
fs.openSync = (p, ...a) => (inData(p) ? realOpen(SCRATCH, 'w') : realOpen(p, ...a));
fs.renameSync = (p, ...a) => { if (inData(p)) return; return realRename(p, ...a); };
fs.copyFileSync = (p, ...a) => { if (inData(p)) return; return realCopy(p, ...a); };
fs.unlinkSync = (p) => { if (inData(p)) return; return realUnlink(p); };
const { server } = require('../server');
after(() => {
  fs.writeFileSync = realWrite; fs.appendFileSync = realAppend;
  fs.openSync = realOpen; fs.renameSync = realRename; fs.copyFileSync = realCopy; fs.unlinkSync = realUnlink;
  try { realUnlink(SCRATCH); } catch {}
});

const TO = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
const FROM = 'nano_3njeurfzgpwpnqjxoytfnqa7ezbgkordga8e8jg74ey77kww5d5emjjyzrhp';
const HASH = 'AB'.repeat(32);
let lastThreshold = null;
globalThis.fetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  const a = b.action === 'block_info' && b.hash === HASH
    ? { block_account: FROM, subtype: 'send', amount: '5000', confirmed: 'true', height: '3', local_timestamp: '1758000000', contents: { link_as_account: TO } }
    : b.action === 'receivable' ? (lastThreshold = b.threshold, { blocks: {} })
    : { error: 'unexpected rpc ' + b.action };
  return { ok: true, json: async () => a };
};
async function get(pathqs) {
  const res = { headers: {}, status: null, body: null, setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    writeHead(s) { this.status = s; }, end(out) { this.body = out ? JSON.parse(String(out)) : null; } };
  await server.listeners('request')[0]({ url: pathqs, method: 'GET', headers: { host: 'pursekeeper.dev' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}
const verify = (qs) => get('/v1/verify?' + qs);

test('without min_raw or min_nano -> 200, found, ok:false with a reason that names any=1', async () => {
  const r = await verify('hash=' + HASH + '&to=' + TO);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.found, true); assert.equal(r.body.confirmed, true); assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /no minimum given, so the amount was not checked: pass min_raw or min_nano, or any=1/);
  assert.equal(r.body.min_raw, null); assert.equal(r.body.any_amount, false);
});

test('any=1 together with a minimum: the minimum wins, any_amount false', async () => {
  const r = await verify('hash=' + HASH + '&to=' + TO + '&min_raw=5001&any=1');
  assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.match(r.body.reason, /below min 5001 raw/); assert.equal(r.body.any_amount, false);
});

test('any=1 -> the old answer plus min_raw: null and any_amount: true', async () => {
  const r = await verify('hash=' + HASH + '&to=' + TO + '&any=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true); assert.equal(r.body.found, true); assert.equal(r.body.confirmed, true);
  assert.equal(r.body.to, TO); assert.equal(r.body.from, FROM); assert.equal(r.body.amount_raw, '5000');
  assert.equal(r.body.min_raw, null); assert.equal(r.body.any_amount, true);
});

test('with a minimum: checked, echoed, any_amount false', async () => {
  const ok = await verify('hash=' + HASH + '&to=' + TO + '&min_raw=5000');
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.min_raw, '5000'); assert.equal(ok.body.any_amount, false);
  const low = await verify('hash=' + HASH + '&to=' + TO + '&min_raw=5001');
  assert.equal(low.status, 200); assert.equal(low.body.ok, false); assert.match(low.body.reason, /below min 5001 raw/);
  const nanoMin = await verify('hash=' + HASH + '&to=' + TO + '&min_nano=0.000000000000000000000000001');   // 1000 raw; to is required for ok since 2026-09-30
  assert.equal(nanoMin.status, 200); assert.equal(nanoMin.body.ok, true); assert.equal(nanoMin.body.min_raw, '1000');
});

// Since 2026-09-30 the recipient is part of ok too: without `to` the destination was never checked and ok:true read as
// "paid to me" (uknwplayer, 2026-09-29). any_to=1 asks only whether H is a confirmed send to anyone.
test('without to -> 200, found, ok:false with a reason that names any_to=1', async () => {
  const r = await verify('hash=' + HASH + '&min_raw=5000');
  assert.equal(r.status, 200); assert.equal(r.body.found, true); assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /no recipient given/); assert.match(r.body.reason, /any_to=1/); assert.equal(r.body.expected_to, null); assert.equal(r.body.any_to, false);
});
test('any_to=1 without to -> ok:true when the amount passes; a given to still wins over any_to', async () => {
  const r = await verify('hash=' + HASH + '&min_raw=5000&any_to=1');
  assert.equal(r.status, 200); assert.equal(r.body.ok, true); assert.equal(r.body.any_to, true); assert.equal(r.body.to, TO);
  const wrong = await verify('hash=' + HASH + '&min_raw=5000&any_to=1&to=' + FROM);
  assert.equal(wrong.body.ok, false); assert.match(wrong.body.reason, /sent to .* not to/); assert.equal(wrong.body.any_to, false);
});

// 2026-10-01 (pyfile-toolkit, item 5, two reports with one root cause): the flag semantics were right, the text was not.
// ok needs an amount side (min_raw, min_nano or any=1) and a recipient side (to= or any_to=1); each single-flag answer
// names the combination, and the two combined calls answer ok:true.
test('single flags: any=1 alone and any_to=1 alone are ok:false, and the reason names the combination', async () => {
  const onlyAny = await verify('hash=' + HASH + '&any=1');
  assert.equal(onlyAny.status, 200); assert.equal(onlyAny.body.ok, false); assert.equal(onlyAny.body.any_amount, true); assert.equal(onlyAny.body.any_to, false);
  assert.match(onlyAny.body.reason, /no recipient given/); assert.match(onlyAny.body.reason, /ok needs both a recipient side, to= or any_to=1, and an amount side/); assert.match(onlyAny.body.reason, /\?any=1&any_to=1/);
  const onlyAnyTo = await verify('hash=' + HASH + '&any_to=1');
  assert.equal(onlyAnyTo.status, 200); assert.equal(onlyAnyTo.body.ok, false); assert.equal(onlyAnyTo.body.any_to, true); assert.equal(onlyAnyTo.body.any_amount, false);
  assert.match(onlyAnyTo.body.reason, /no minimum given/); assert.match(onlyAnyTo.body.reason, /ok needs both an amount side, min_raw, min_nano or any=1, and a recipient side/); assert.match(onlyAnyTo.body.reason, /\?any=1&to=A/);
  assert.doesNotMatch(onlyAnyTo.body.reason, /no recipient given/);
});
test('combined: any=1&to=A and any=1&any_to=1 are ok:true with both flags echoed', async () => {
  const withTo = await verify('hash=' + HASH + '&any=1&to=' + TO);
  assert.equal(withTo.status, 200, JSON.stringify(withTo.body)); assert.equal(withTo.body.ok, true); assert.equal(withTo.body.reason, undefined);
  assert.equal(withTo.body.any_amount, true); assert.equal(withTo.body.min_raw, null); assert.equal(withTo.body.expected_to, TO); assert.equal(withTo.body.any_to, false);
  const both = await verify('hash=' + HASH + '&any=1&any_to=1');
  assert.equal(both.status, 200, JSON.stringify(both.body)); assert.equal(both.body.ok, true); assert.equal(both.body.reason, undefined);
  assert.equal(both.body.any_amount, true); assert.equal(both.body.any_to, true); assert.equal(both.body.expected_to, null); assert.equal(both.body.to, TO);
});

// 2026-10-23 (llmrt): nano_ and xrb_ are two spellings of one account, and the chain reports every destination as nano_.
// A caller passing its own address in the older xrb_ spelling was told the block was sent "not to xrb_..." for the account it
// did pay, so a seller that keeps its address in the pre-rename form read a real payment as unpaid. The facilitator already
// normalises payTo (facilitator.js nanoPrefix); this route now answers the same way.
test('an xrb_ spelling of the destination is the same account and answers ok:true', async () => {
  const xrb = TO.replace(/^nano_/, 'xrb_');
  const r = await verify('hash=' + HASH + '&to=' + xrb + '&min_raw=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.reason, undefined);
  assert.equal(r.body.expected_to, TO, 'the answer echoes the canonical nano_ spelling');
  assert.equal(r.body.to, TO);
});

// 2026-10-01 (pyfile-toolkit, item 5): a threshold above 2^128-1 reached the node, which refused it, and the refusal was
// served as 502. The parser now refuses it with 400 on both routes; 2^128-1 itself is accepted.
const MAX = (2n ** 128n - 1n).toString(), OVER = (2n ** 128n).toString();
const ACC = 'nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue';
test('min_raw = 2^128-1 is accepted on both routes; 2^128 is a 400 with the range in the message', async () => {
  const v = await verify('hash=' + HASH + '&to=' + TO + '&min_raw=' + MAX);
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body.ok, false); assert.match(v.body.reason, /below min/); assert.equal(v.body.min_raw, MAX);
  const vo = await verify('hash=' + HASH + '&to=' + TO + '&min_raw=' + OVER);
  assert.equal(vo.status, 400); assert.equal(vo.body.error, 'min_raw must be at most ' + MAX + ' raw (2^128-1)');
  lastThreshold = null;
  const r = await get('/v1/receivable?account=' + ACC + '&min_raw=' + MAX);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(lastThreshold, MAX);
  lastThreshold = null;
  const ro = await get('/v1/receivable?account=' + ACC + '&min_raw=' + OVER);
  assert.equal(ro.status, 400); assert.equal(ro.body.error, 'min_raw must be at most ' + MAX + ' raw (2^128-1)'); assert.equal(lastThreshold, null);
});
test('min_nano above 2^128-1 raw is a 400 on both routes; the largest representable amount is accepted', async () => {
  const over = await verify('hash=' + HASH + '&to=' + TO + '&min_nano=340282366.920938463463374607431768211456');   // 2^128 raw
  assert.equal(over.status, 400); assert.match(over.body.error, /^min_nano must be at most 340282366\.920938463463374607431768211455 NANO/);
  const max = await verify('hash=' + HASH + '&to=' + TO + '&min_nano=340282366.920938463463374607431768211455');
  assert.equal(max.status, 200); assert.equal(max.body.min_raw, MAX);
  const ro = await get('/v1/receivable?account=' + ACC + '&min_nano=1000000000');   // 10^39 raw, well above u128
  assert.equal(ro.status, 400); assert.match(ro.body.error, /^min_nano must be at most/);
});
