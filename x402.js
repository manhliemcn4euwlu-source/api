// x402 "exact" scheme on nano:mainnet, self-facilitated.
//
// Wire format is @x402/core v2 (installed 2.25.0): the 402 carries a base64 JSON
// PaymentRequired in the PAYMENT-REQUIRED header, the client sends a base64 JSON
// PaymentPayload in PAYMENT-SIGNATURE (legacy X-PAYMENT also read), and a paid
// response carries a base64 JSON SettleResponse in PAYMENT-RESPONSE. The payload
// for the Nano scheme is the client's signed send state block; we verify it here
// against our own node and broadcast it ourselves. No external facilitator.
//
// Checks beyond the reference @x402nano/exact facilitator (which only checks the
// block schema, link_as_account == payTo, account opened, balance >= amount, work
// against the frontier, and the signature):
//   - the accepted requirements in the payload equal what we asked for
//     (scheme, network, payTo, amount, asset)
//   - block.link is the public key of payTo (not just the client-supplied
//     link_as_account string)
//   - block.previous is the account's current frontier
//   - account balance minus block.balance is exactly the required amount
//   - the frontier is confirmed (confirmed_frontier or confirmation_height_frontier == frontier)
//   - the block hash has not been settled or credited before
// The reference verify() is still run as well when a helper is supplied, so a
// block must satisfy both.
'use strict';
const N = require('nanocurrency');
const { parsePaymentPayload } = require('@x402/core/schemas');
const http = require('@x402/core/http');
const { NANO_SEND_BLOCK, SEND_BLOCK_WORK_THRESHOLD } = require('@x402nano/typescript-common');

const SCHEME = 'exact';
const NETWORK = 'nano:mainnet';
const ASSET = 'XNO';
const X402_VERSION = 2;
const WORK_THRESHOLD = SEND_BLOCK_WORK_THRESHOLD; // 'fffffff800000000'

// Header names as used by @x402/core v2. Request headers are lower-cased by Node.
const REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const RESPONSE_HEADER = 'PAYMENT-RESPONSE';
const REQUEST_HEADERS = ['payment-signature', 'x-payment'];

// extra.work = 'optional' tells clients they may omit block.work (or send "0"): the seller
// computes it before broadcasting. Work is not part of the signed hash, so this is safe.
// extra.workThreshold names the send threshold either way, so a payer knows the target before
// signing (pyfile-toolkit, 2026-10-05; the same keys pyfile-toolkit and CedarProof quote).
// extra.workOptional (boolean) is the same flag under the name the scheme draft uses (kilkelly,
// x402-nano-exact-scheme-proposal PR #1, draft of 2026-10-20); both are advertised until the draft lands.
function requirements({ payTo, amountRaw, maxTimeoutSeconds = 60, workOptional = false }) {
  return { scheme: SCHEME, network: NETWORK, amount: String(amountRaw), asset: ASSET, payTo, maxTimeoutSeconds,
    extra: { work: workOptional ? 'optional' : 'required', workOptional: !!workOptional, workThreshold: WORK_THRESHOLD } };
}

const NO_WORK = w => w === undefined || w === null || /^0*$/.test(String(w));

// PaymentRequired object (x402 v2) and its header value.
function paymentRequired({ requirements: req, url, description, mimeType = 'application/json', error }) {
  const body = { x402Version: X402_VERSION, resource: { url, description, mimeType }, accepts: [req] };
  if (error) body.error = error;
  return { body, header: http.encodePaymentRequiredHeader(body) };
}

function paymentHeader(headers) {
  for (const h of REQUEST_HEADERS) if (headers[h]) return String(headers[h]);
  return null;
}

function decodePayment(value) {
  try { return { payload: http.decodePaymentSignatureHeader(value.trim()) }; }
  catch (e) { return { error: 'payment header is not base64 JSON: ' + e.message }; }
}

const up = s => String(s).toUpperCase();
const nanoPrefix = a => String(a).replace(/^xrb_/, 'nano_');

// First zod issue of a failed parse as " (path: message)", bounded; "" when the error carries no issues.
function schemaIssue(err) {
  try {
    const i = err && err.issues && err.issues[0];
    if (!i) return '';
    const path = (i.path || []).join('.') || 'payload';
    return ' (' + path + ': ' + String(i.message || i.code || '').slice(0, 120) + ')';
  } catch { return ''; }
}

// Hash of a payload block over its five signed fields, normalised as verify() normalises them (nano_ prefix, upper-case
// hex); throws on a malformed block. Exported so the seller can key a per-block lock before verify() runs: a second
// concurrent request with the same block used to pass seen() too (Ops Control HQ, 2026-09-28 22:34 UTC).
function blockHash(raw) {
  return N.hashBlock({ account: nanoPrefix(raw.account), previous: up(raw.previous), representative: nanoPrefix(raw.representative), balance: String(raw.balance), link: up(raw.link) });
}

// Verify a PaymentPayload against what we required. deps:
//   accountInfo(account) -> account_info RPC result (with representative), or {error}
//   workThreshold        -> hex threshold (default send threshold)
//   reference            -> optional @x402nano/exact facilitator scheme; its verify() runs too
//   seen(hash)           -> optional; true if this hash was already settled or credited, or a string
//                           reason when the chain holds the block but it sends another amount
//   workGenerate(hash)   -> optional; returns work for the payer's frontier when the block
//                           carries none (or invalid work). Runs last, after every cheap check.
//   blockInfo(hash)      -> optional; block_info RPC result for a block that is already the
//                           account frontier (a resend after a lost settle reply): its amount and
//                           confirmation are checked there, since the balance drop is no longer readable
// Returns { ok, reason?, payer?, hash?, block?, workBy? ('client'|'seller'), alreadyLanded? }. Never throws.
async function verify(payload, required, deps) {
  const fail = (reason, payer = '') => ({ ok: false, reason, payer });
  try {
    // version first, before the schema, so a v1 envelope gets the documented code rather than a schema failure
    if (!payload || typeof payload !== 'object') return fail('payload does not match x402 v2 PaymentPayload schema');
    if (payload.x402Version !== X402_VERSION) return fail('x402Version must be 2 (got ' + JSON.stringify(payload.x402Version) + ')');
    const parsed = parsePaymentPayload(payload);
    // Name the first failing field: a seller's 402 that breaks the ResourceInfo caps (serviceName and each tag at most
    // 32 printable ASCII characters, at most 5 tags) is echoed verbatim into the payload by every client and refused
    // here, and "does not match the schema" alone sent the seller looking at the block (Ops Control HQ, 2026-10-18).
    if (!parsed.success) return fail('payload does not match x402 v2 PaymentPayload schema' + schemaIssue(parsed.error));
    const p = parsed.data;

    // (a) the client accepted exactly what we asked for
    const a = p.accepted;
    if (a.scheme !== required.scheme) return fail('scheme must be ' + required.scheme);
    if (a.network !== required.network) return fail('network must be ' + required.network);
    if (nanoPrefix(a.payTo) !== nanoPrefix(required.payTo)) return fail('payTo does not match');
    if (String(a.amount) !== String(required.amount)) return fail('amount must be ' + required.amount + ' raw');
    if (String(a.asset).toUpperCase() !== required.asset) return fail('asset must be ' + required.asset);

    // block shape
    const raw = p.payload && p.payload.block;
    // A workless block passes the shape check whether or not a work source exists, so the work
    // check below names the missing field instead of "not a Nano state block" (pyfile-toolkit, 2026-10-05).
    if (raw && typeof raw === 'object' && NO_WORK(raw.work)) raw.work = '0';
    if (!NANO_SEND_BLOCK.safeParse(raw).success) return fail('payload.block is not a Nano state block');
    const block = {
      type: 'state', account: nanoPrefix(raw.account), previous: up(raw.previous), representative: nanoPrefix(raw.representative),
      balance: String(raw.balance), link: up(raw.link), work: String(raw.work), signature: up(raw.signature)
    };
    const payer = block.account;
    if (!N.checkAddress(block.account)) return fail('block.account is not a valid nano_ address', payer);
    if (!N.checkAddress(block.representative)) return fail('block.representative is not a valid nano_ address', payer); // (f)
    const needWork = NO_WORK(block.work);
    if (needWork && !deps.workGenerate) return fail('block.work is required here: this facilitator attaches no work (see /supported); compute it over block.previous at ' + (deps.workThreshold || WORK_THRESHOLD), payer);
    if (!needWork && !/^[0-9A-F]{16}$/i.test(block.work)) return fail('block.work must be 16 hex characters', payer);

    // (c) link must be the public key of payTo; link_as_account, if given, must agree
    const payToKey = up(N.derivePublicKey(nanoPrefix(required.payTo)));
    if (block.link !== payToKey) return fail('block.link is not the public key of payTo', payer);
    block.link_as_account = N.deriveAddress(block.link, { useNanoPrefix: true });
    if (raw.link_as_account && nanoPrefix(raw.link_as_account) !== block.link_as_account)
      return fail('block.link_as_account does not match block.link', payer);

    // (b) signature over the block hash by block.account
    let hash;
    try {
      hash = blockHash(block);
      if (!N.verifyBlock({ hash, signature: block.signature, publicKey: N.derivePublicKey(block.account) })) return fail('bad signature', payer);
    } catch (e) { return fail('cannot hash or verify block: ' + e.message, payer); }

    // seen() answers true (already used) or a string naming a different fault found on the chain: a block that is already
    // on the ledger but sends another amount than required is an amount mismatch, not a replay, so that a confirmed 1-raw
    // send presented at the full price is refused as underpayment and never read as "already paid" (check 10 of the
    // scheme document as drafted by kilkelly, x402#3432, 2026-10-13).
    if (deps.seen) { const s = await deps.seen(hash); if (s) return fail(typeof s === 'string' ? s : 'this block was already used to pay', payer); }

    // (d), (e), (h) against the node
    let info;
    try { info = await deps.accountInfo(block.account); } catch (e) { return fail('node rpc failed: ' + e.message, payer); }
    if (!info || info.error) return fail(info && info.error === 'Account not found' ? 'payer account is not opened' : 'account_info failed: ' + (info && info.error), payer);
    const frontier = up(info.frontier || '');
    if (!frontier) return fail('payer account has no frontier', payer);
    if (frontier !== block.previous) {
      // The block landed on an earlier attempt whose settle reply was lost and the client resent the same payment: served
      // once (seen() above refuses a hash already served) and only when the node shows what it sent, since account_info
      // now holds the post-send balance: the landed block's own amount and confirmation are read through blockInfo. Until
      // 2026-09-30 this branch recognised the block only while it was still the frontier, so a wallet that appended any
      // later block before re-presenting (an auto-receive is enough) had its confirmed payment refused as a stale previous
      // (ARION, 2026-09-29). It is now looked up by its own hash wherever the frontier is; the hash covers the link and
      // amount checked above. Not on the node, or without the dep, the stale-previous refusal stands (Ops Control HQ, 2026-09-28).
      if (deps.blockInfo) {
        let b;
        try { b = await deps.blockInfo(hash); } catch (e) { return fail('node rpc failed: ' + e.message, payer); }
        if (b && !b.error && b.subtype === 'send') {
          if (b.subtype && b.subtype !== 'send') return fail('the block on the chain does not send anything (subtype ' + b.subtype + ')', payer);
          if (String(b.amount) !== String(required.amount)) return fail('the block on the chain sends ' + b.amount + ' raw; exactly ' + required.amount + ' raw required', payer);
          // The confirmation gate the normal path puts on the frontier applies here too: block_info answers confirmed as the
          // string 'true' / 'false', and the first version served the landed block before it was confirmed (Ops Control HQ,
          // 2026-09-28 22:27 UTC).
          if (b.confirmed !== 'true') return fail('the resent block is on the node but not confirmed yet; retry shortly', payer);
          return { ok: true, payer, hash, block, workBy: 'client', alreadyLanded: true };
        }
      }
      return fail('block.previous is not the account frontier (' + frontier + ')', payer);
    }
    // Modern include_confirmed responses use confirmed_frontier; legacy nodes
    // use confirmation_height_frontier. Require evidence instead of skipping
    // this gate when metadata is missing, and reject contradictory fields.
    const confirmed = [info.confirmed_frontier, info.confirmation_height_frontier].filter(v => v !== undefined);
    if (!confirmed.length || confirmed.some(v => typeof v !== 'string' || !/^[0-9A-F]{64}$/i.test(v)))
      return fail('account_info failed: missing or invalid confirmation frontier', payer);
    if (confirmed.some(v => up(v) !== frontier))
      return fail('account frontier is not confirmed yet; retry shortly', payer);
    let diff;
    try { diff = BigInt(info.balance) - BigInt(block.balance); } catch { return fail('bad balance', payer); }
    const want = BigInt(required.amount);
    if (diff < want) return fail(diff <= 0n ? 'block does not send anything' : 'block sends ' + diff + ' raw; ' + want + ' raw required', payer);
    if (diff > want) return fail('block sends ' + diff + ' raw; exactly ' + want + ' raw required (overpayment is not credited on this path)', payer);

    // (g) work at the send threshold, against previous (== frontier). If the client sent none
    // (or bad work) and we have a work source, compute it now: every cheaper check has passed,
    // so only a block that is about to pay us costs us work.
    const threshold = deps.workThreshold || WORK_THRESHOLD;
    let workBy = 'client';
    const validWork = w => { try { return N.validateWork({ blockHash: block.previous, work: w, threshold }); } catch { return false; } };
    if (needWork || !validWork(block.work)) {
      if (!deps.workGenerate) return fail('work ' + block.work + ' does not cover block.previous ' + block.previous + ' at the send threshold ' + threshold + ' (work is computed over the previous block hash, never over the new block\'s own hash)', payer);
      let w;
      try { w = await deps.workGenerate(block.previous); }
      catch (e) { return fail((e && e.code === 'work_unavailable' ? 'error_work_unavailable: ' : 'could not generate work: ') + e.message, payer); }
      if (!w || !validWork(w)) return fail('could not generate work' + (w ? ' (source returned work below threshold)' : ''), payer);
      block.work = String(w).toLowerCase();
      workBy = 'seller';
    }

    // Reference implementation as an extra gate (schema, link_as_account, balance, work, signature).
    if (deps.reference) {
      const r = await deps.reference.verify({ ...p, payload: { block } }, required);
      if (!r || !r.isValid) return fail('reference verify: ' + (r && r.invalidReason || 'invalid'), payer);
    }
    return { ok: true, payer, hash, block, workBy };
  } catch (e) {
    return fail('verify error: ' + e.message);
  }
}

// Broadcast a verified block. deps.process(block) -> RPC "process" result ({hash} or {error}).
// Optional deps.hash (the block's hash) and deps.landed(hash) -> true | false | null (on the node, not, cannot tell):
// when process throws or answers an error the block may have landed anyway (a lost reply), so the outcome is taken
// from the node's view of the hash rather than reported as a failed payment; the reason then says whether a rebuilt
// payment is safe. Without deps.landed the old failure stands (Ops Control HQ, 2026-09-28).
async function settle(block, payer, deps) {
  const failed = reason => ({ success: false, network: NETWORK, transaction: '', errorReason: reason, payer });
  const settled = hash => ({ success: true, network: NETWORK, transaction: up(hash), payer });
  // definite: process answered with a rejection, so a block the node does not hold now will not arrive later. When process
  // THREW (transport failure, timeout) the node may still be working on the block and it can land after the block_info
  // read, so "not on the node" is not "safe to rebuild" on that path (PlatinumVera, 2026-09-28 22:30 UTC).
  const afterFailure = async (reason, definite) => {
    if (!deps.landed) return failed(reason);
    let landed; try { landed = await deps.landed(deps.hash); } catch { landed = null; }
    if (landed === true) return settled(deps.hash);
    if (landed === false) return failed(reason + (definite ? '; the block did not land, a rebuilt payment is safe'
      : '; the block is not on the node right now but may still arrive; check hash ' + deps.hash + ' before paying again'));
    return failed(reason + '; the block may have landed, check hash ' + deps.hash + ' before paying again');
  };
  let r;
  try { r = await deps.process(block); } catch (e) { return afterFailure('node rpc failed: ' + e.message, false); }
  if (!r || r.error || !r.hash) return afterFailure('process rejected the block: ' + (r && r.error || 'no hash'), true);
  return settled(r.hash);
}

function settleHeader(settleResponse) { return http.encodePaymentResponseHeader(settleResponse); }

module.exports = { SCHEME, NETWORK, ASSET, X402_VERSION, WORK_THRESHOLD, REQUIRED_HEADER, RESPONSE_HEADER, REQUEST_HEADERS,
  requirements, paymentRequired, paymentHeader, decodePayment, blockHash, verify, settle, settleHeader };
