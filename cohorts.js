// Cohort splits for every counterparty address, derived from the Nano ledger (the
// chain, via the local node) plus pursekeeper's own payment ledger in gambit.db.
// Promised publicly on Moltbook. No seeds, no identities: the only label for a
// counterparty is its address. The `contacts` and `events` tables are never read.
//
//   GET /cohorts        HTML table
//   GET /cohorts.json   the same as JSON
//   node cohorts.js     Markdown table on stdout, for the weekly report
//
// Four splits per address:
//   1. wallet state when first touched by us: opened by our payment / already funded /
//      unopened (our send not yet received) / n-a (they paid us first, we never paid them)
//   2. funding source: grant-funded (we paid them) / independently earned (they paid us,
//      we never paid them); an address we paid that also paid us gets both flags
//   3. first receipt from us -> their first outbound send after it (to us or elsewhere)
//   4. repeat: more than one on-chain interaction, either direction, within 30 days of the first
'use strict';
const { DatabaseSync } = require('node:sqlite');
const site = require('./site');

const { DB_PATH, RPC, ADDRESS, EXPLORER } = site;
const CACHE_MS = 10 * 60_000;      // chain answers are kept this long; the node is local but be polite
const WINDOW_DAYS = 30;            // "repeat" means a second interaction within this many days of the first
const SCAN = 1000;                 // blocks scanned per counterparty query; beyond this we say "unknown"
const ZERO = '0'.repeat(64);
const NANO_RE = /^nano_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
const REASON_CHARS = 80;

// --- chain -------------------------------------------------------------------

const rpcCache = new Map();
async function cachedRpc(body) {
  const key = JSON.stringify(body);
  const hit = rpcCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await fetch(RPC, { method: 'POST', body: key }).then(r => r.json());
  // "Account not found" is a real answer (no blocks yet) and is cached; other errors are not.
  if (!data.error || data.error === 'Account not found') rpcCache.set(key, { at: Date.now(), data });
  return data;
}

const ts = b => Number(b.local_timestamp || 0);
const iso = t => t ? new Date(t * 1000).toISOString().slice(0, 19) + 'Z' : null;

// Every block of our own account, oldest first. Sends carry the destination in
// `account`, receives carry the source. One call, cached.
async function ourHistory(rpc) {
  const h = await rpc({ action: 'account_history', account: ADDRESS, count: '-1', raw: 'true', reverse: 'true' });
  if (h.error) throw new Error('account_history for our address: ' + h.error);
  return h.history || [];
}

// The funder's cold address is not a counterparty. Tranches are marked in the ledger
// (kind = tranche, counterparty = "cold"); the sender behind each tranche block is
// looked up on the chain so it can be excluded even if it ever shows up elsewhere.
async function ownAddresses(ledger, rpc) {
  const own = new Set([ADDRESS, ...(process.env.GAMBIT_OWN_ADDRESSES || '').split(',').map(s => s.trim()).filter(Boolean), ...ownFromFile(), ...(await site.coldSenders(ledger, rpc))]);
  for (const r of ledger) {
    if (r.kind !== 'tranche' || !r.block_hash) continue;
    try {
      const recv = await rpc({ action: 'block_info', json_block: 'true', hash: r.block_hash });
      const link = recv.contents && recv.contents.link;
      if (!link) continue;
      const sendBlock = await rpc({ action: 'block_info', json_block: 'true', hash: link });
      if (sendBlock.block_account) own.add(sendBlock.block_account);
    } catch {}
  }
  return own;
}

// What the chain says about one counterparty, given our own history.
async function chainFor(rpc, address, ours, refunds) {
  const ourSends = ours.filter(b => b.subtype === 'send' && b.account === address);
  const ourReceives = ours.filter(b => b.subtype === 'receive' && b.account === address);
  const info = await rpc({ action: 'account_info', account: address, include_confirmed: 'true' });
  const exists = !info.error;
  if (info.error && info.error !== 'Account not found') throw new Error('account_info: ' + info.error);
  let withUs = [], after = [], afterScanExhausted = false, open = null;
  if (exists) {
    // Only the blocks that touch our address, oldest first: their receives of our
    // sends and their sends to us. `count` limits matches, not blocks scanned.
    const h = await rpc({ action: 'account_history', account: address, count: String(SCAN), raw: 'true', reverse: 'true', account_filter: [ADDRESS] });
    if (h.error) throw new Error('account_history: ' + h.error);
    withUs = (h.history || []).filter(b => !refundedBlock(b, refunds));
    const firstIn = withUs.find(b => b.subtype === 'receive');
    if (firstIn) {
      // Their chain from that receive forward, to find the first outbound send.
      const h2 = await rpc({ action: 'account_history', account: address, count: String(SCAN), raw: 'true', reverse: 'true', head: firstIn.hash });
      if (h2.error) throw new Error('outbound account_history: ' + h2.error);
      const rawAfter = h2.history || [];
      afterScanExhausted = rawAfter.length >= SCAN;
      after = rawAfter.filter(b => !refundedBlock(b, refunds));
    }
    // The open block is only needed when the receive of our send is not it.
    if (ourSends.length && !(firstIn && firstIn.previous === ZERO) && info.open_block)
      open = await rpc({ action: 'block_info', json_block: 'true', hash: info.open_block });
  }
  return { ourSends, ourReceives, exists, info, withUs, after, afterScanExhausted, open };
}

// --- ledger ------------------------------------------------------------------


// data/own-addresses.json: {"addresses":[{"address","note"}]}: other accounts pursekeeper
// controls (e.g. a test client). Never counterparties, never inflow.
function ownFromFile() {
  try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'own-addresses.json'), 'utf8')).addresses.map(a => a.address); }
  catch { return []; }
}

function readLedger() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return db.prepare('select id, ts, kind, amount_raw, counterparty, reason, initiative_id, block_hash, meta_json from ledger order by id').all(); }
  finally { db.close(); }
}

// A refund flag in the ledger, if the agent ever sets one: meta_json {"refund": true}
// or a reason starting with "refund" / containing "[refund]". Such rows are not
// counterparty payments and are left out.
// Also data/refunds.json: [{"hash": "<block hash>", "note": "why"}], kept by hand for
// inbound blocks the ledger recorded as plain receipts (e.g. a seller returning change).
let refundHashes = null;
function loadRefundHashes() {
  if (refundHashes) return refundHashes;
  refundHashes = new Set();
  try {
    const list = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'refunds.json'), 'utf8'));
    for (const x of list) if (x && x.hash) refundHashes.add(String(x.hash).toUpperCase());
  } catch {}
  return refundHashes;
}
function isRefund(r) {
  let meta = {}; try { meta = JSON.parse(r.meta_json || '{}') || {}; } catch {}
  if (r.block_hash && loadRefundHashes().has(String(r.block_hash).toUpperCase())) return true;
  return !!meta.refund || /^refund\b/i.test(r.reason || '') || /\[refund\]/i.test(r.reason || '');
}

const hashKey = value => String(value || '').toUpperCase();
function refundedBlock(block, refunds) {
  return refunds.has(hashKey(block.hash)) ||
    (block.subtype === 'receive' && refunds.has(hashKey(block.link)));
}

// Counterparties from the ledger: every payment_out destination and payment_in source
// that is a Nano address and not one of ours.
function collect(ledger, own) {
  const cps = new Map();
  for (const r of ledger) {
    if (r.kind !== 'payment_out' && r.kind !== 'payment_in') continue;
    const a = r.counterparty;
    if (!a || !NANO_RE.test(a) || own.has(a) || isRefund(r)) continue;
    let c = cps.get(a);
    if (!c) cps.set(a, c = { address: a, ledger_out: [], ledger_in: [], reasons: [], initiative_ids: [] });
    (r.kind === 'payment_out' ? c.ledger_out : c.ledger_in).push({ id: r.id, ts: r.ts, amount_raw: r.amount_raw, block_hash: r.block_hash });
    if (r.reason && !c.reasons.includes(r.reason)) c.reasons.push(r.reason);
    if (r.initiative_id && !c.initiative_ids.includes(r.initiative_id)) c.initiative_ids.push(r.initiative_id);
  }
  return cps;
}

// Addresses the chain knows and the ledger does not (yet): destinations of our sends
// and sources of our receives. Marked so in the reason column.
function addChainOnly(cps, ours, own) {
  for (const b of ours) {
    if (b.subtype !== 'send' && b.subtype !== 'receive') continue;
    const a = b.account;
    if (!a || !NANO_RE.test(a) || own.has(a) || cps.has(a)) continue;
    cps.set(a, { address: a, ledger_out: [], ledger_in: [], reasons: ['(not in the ledger; seen on the chain only)'], initiative_ids: [] });
  }
  return cps;
}

// --- classification (pure) -----------------------------------------------------

const sum = rows => rows.reduce((a, b) => a + BigInt(b.amount || b.amount_raw || 0), 0n);

function classify(cp, chain, refunds = loadRefundHashes()) {
  const { ourSends, exists, withUs, after, afterScanExhausted = false, open } = chain;
  const theirSends = withUs.filter(b => b.subtype === 'send' && !refundedBlock(b, refunds));
  const firstIn = withUs.find(b => b.subtype === 'receive');
  const paidByUs = ourSends.length > 0 || cp.ledger_out.length > 0;
  const paidUs = theirSends.length > 0 || cp.ledger_in.length > 0;

  // 1. wallet state when first touched by us
  let wallet_state;
  if (!paidByUs) wallet_state = 'n/a';
  else if (!exists) wallet_state = 'unopened';
  else if (firstIn && firstIn.previous === ZERO) wallet_state = 'opened_by_us';
  else {
    const openTs = open ? ts(open) : 0, firstSendTs = ourSends.length ? ts(ourSends[0]) : Infinity;
    wallet_state = openTs > 0 && openTs >= firstSendTs ? 'opened_later_by_other' : 'already_funded';
  }

  // 2. funding source
  const funding = { grant_funded: paidByUs, independently_earned: paidUs && !paidByUs, paid_us: paidUs };

  // 3. first receipt from us, and their first outbound send after it
  let first_receipt = null, first_spend = null, first_spend_status = 'n/a';
  if (firstIn) first_receipt = { at: iso(ts(firstIn)), hash: firstIn.hash, our_send_hash: firstIn.link, amount_raw: firstIn.amount };
  else if (ourSends.length) first_receipt = { at: null, sent_at: iso(ts(ourSends[0])), our_send_hash: ourSends[0].hash, amount_raw: ourSends[0].amount, pending: true };
  if (firstIn) {
    const out = after.find(b => b.subtype === 'send' && Number(b.height) > Number(firstIn.height));
    if (out) { first_spend = { at: iso(ts(out)), hash: out.hash, to: out.account, to_us: out.account === ADDRESS, amount_raw: out.amount }; first_spend_status = out.account === ADDRESS ? 'to_us' : 'elsewhere'; }
    else first_spend_status = afterScanExhausted ? 'unknown' : 'none_yet';
  }

  // 4. repeat: every send between the two accounts, either direction, by chain time
  const events = [...ourSends.map(b => ({ at: ts(b), dir: 'out', hash: b.hash })), ...theirSends.map(b => ({ at: ts(b), dir: 'in', hash: b.hash }))]
    .sort((a, b) => a.at - b.at);
  const first = events[0];
  const within = first ? events.filter(e => e.at - first.at <= WINDOW_DAYS * 86400).length : 0;
  const interactions = { count: events.length, within_30d: within, repeat: within > 1, first_at: first ? iso(first.at) : null, last_at: events.length ? iso(events[events.length - 1].at) : null };

  return {
    address: cp.address,
    wallet_state, funding, first_receipt, first_spend, first_spend_status, interactions,
    paid_raw: sum(ourSends).toString(), paid_count: ourSends.length,
    received_raw: sum(theirSends).toString(), received_count: theirSends.length,
    reasons: cp.reasons.map(r => { r = site.redact(r); return r.length > REASON_CHARS ? r.slice(0, REASON_CHARS - 1) + '…' : r; }),
    initiative_ids: cp.initiative_ids
  };
}

// An address counts as a counterparty if pursekeeper paid it, or once it has sent
// site.COUNTERPARTY_MIN_NANO in total (the agent's wallet_status rule; dust from
// throwaway accounts is listed but not counted).
function countsAsCounterparty(r) { return r.paid_count > 0 || BigInt(r.received_raw) >= site.COUNTERPARTY_MIN_RAW; }

function totalsOf(rows) {
  const t = { counterparties: rows.filter(countsAsCounterparty).length, below_threshold: rows.filter(r => !countsAsCounterparty(r)).length, min_nano: site.COUNTERPARTY_MIN_NANO,
    wallet_state: { opened_by_us: 0, already_funded: 0, unopened: 0, opened_later_by_other: 0, 'n/a': 0, unknown: 0 },
    funding: { grant_funded: 0, independently_earned: 0, grant_funded_and_paid_us: 0 },
    first_spend: { to_us: 0, elsewhere: 0, none_yet: 0, unknown: 0, 'n/a': 0 },
    repeat: { one_off: 0, repeat_within_30d: 0 },
    paid_raw: 0n, received_raw: 0n };
  for (const r of rows) {
    // One denominator: every breakdown counts the rows the headline counts. Counting the
    // dust rows listed for completeness made the wallet-state buckets sum to 121 while
    // `counterparties` said 119 (2026-10-23), so a reader could not tell which was the count.
    if (!countsAsCounterparty(r)) continue;
    t.wallet_state[r.wallet_state] = (t.wallet_state[r.wallet_state] || 0) + 1;
    if (r.funding.grant_funded) t.funding.grant_funded++;
    if (r.funding.independently_earned) t.funding.independently_earned++;
    if (r.funding.grant_funded && r.funding.paid_us) t.funding.grant_funded_and_paid_us++;
    t.first_spend[r.first_spend_status] = (t.first_spend[r.first_spend_status] || 0) + 1;
    if (r.interactions.count) t.repeat[r.interactions.repeat ? 'repeat_within_30d' : 'one_off']++;
    t.paid_raw += BigInt(r.paid_raw); t.received_raw += BigInt(r.received_raw);
  }
  t.paid_raw = t.paid_raw.toString(); t.received_raw = t.received_raw.toString();
  return t;
}

// --- main --------------------------------------------------------------------

async function computeCohorts({ ledger = readLedger(), rpc = cachedRpc } = {}) {
  const history = await ourHistory(rpc);
  const refunds = new Set(loadRefundHashes());
  for (const row of ledger) {
    if (row.block_hash && isRefund(row)) refunds.add(hashKey(row.block_hash));
  }
  // A refund may be recorded by our receive hash, while the counterparty's
  // history identifies the corresponding send hash. Exclude both sides.
  for (const block of history) {
    if (block.subtype === 'receive' && refundedBlock(block, refunds)) {
      if (block.hash) refunds.add(hashKey(block.hash));
      if (block.link) refunds.add(hashKey(block.link));
    }
  }
  const ours = history.filter(b => !refundedBlock(b, refunds));
  const own = await ownAddresses(ledger, rpc);
  const via = await site.passthroughSources(ledger, rpc, own);
  const cps = addChainOnly(collect(ledger, own), ours, own);
  const rows = [];
  for (const cp of cps.values()) {
    try { rows.push(classify(cp, await chainFor(rpc, cp.address, ours, refunds), refunds)); }
    catch (e) {
      rows.push({ address: cp.address, wallet_state: 'unknown', funding: { grant_funded: cp.ledger_out.length > 0, independently_earned: cp.ledger_in.length > 0 && !cp.ledger_out.length, paid_us: cp.ledger_in.length > 0 },
        first_receipt: null, first_spend: null, first_spend_status: 'unknown', interactions: { count: 0, within_30d: 0, repeat: false, first_at: null, last_at: null },
        paid_raw: sum(cp.ledger_out).toString(), paid_count: cp.ledger_out.length, received_raw: sum(cp.ledger_in).toString(), received_count: cp.ledger_in.length,
        reasons: cp.reasons.map(r => site.redact(r).slice(0, REASON_CHARS)), initiative_ids: cp.initiative_ids, chain_error: e.message });
    }
  }
  rows.splice(0, rows.length, ...mergePassThrough(rows, via));
  for (const r of rows) r.counts_as_counterparty = countsAsCounterparty(r);
  rows.sort((a, b) => (a.interactions.first_at || '').localeCompare(b.interactions.first_at || ''));
  return { generated_at: new Date().toISOString(), address: ADDRESS, window_days: WINDOW_DAYS, scan_limit: SCAN, rows, totals: totalsOf(rows) };
}

// Fold each one-time pass-through wallet into the account that funded it, the rule the home
// page already applies (site.counterpartyNumbers): eleven purchases by three buyers are three
// counterparties, not eleven. Without this the home page reported 28 strangers from addresses
// pursekeeper never paid while this page reported 56 independently-earned addresses for the same
// ledger, and a wallet opened by a buyer pursekeeper had paid was shown as a stranger (2026-10-23).
function mergePassThrough(rows, via) {
  if (!via.size) return rows;
  const byAddress = new Map(rows.map(r => [r.address, r]));
  const dropped = new Set();
  const added = [];
  for (const [wallet, funder] of via) {
    const w = byAddress.get(wallet);
    if (!w || dropped.has(wallet) || wallet === funder) continue;
    let f = byAddress.get(funder);
    if (!f) { f = { ...w, address: funder, via_wallets: [wallet] }; byAddress.set(funder, f); added.push(f); }   // the first folded wallet is named too (fix-up on PR #105)
    else {
      f.paid_raw = (BigInt(f.paid_raw) + BigInt(w.paid_raw)).toString();
      f.received_raw = (BigInt(f.received_raw) + BigInt(w.received_raw)).toString();
      f.paid_count += w.paid_count;
      f.received_count += w.received_count;
      f.interactions = { ...f.interactions, count: f.interactions.count + w.interactions.count };
      f.reasons = [...new Set([...f.reasons, ...w.reasons])];
      f.initiative_ids = [...new Set([...f.initiative_ids, ...w.initiative_ids])];
      (f.via_wallets = f.via_wallets || []).push(wallet);
    }
    dropped.add(wallet);
  }
  const out = rows.filter(r => !dropped.has(r.address)).concat(added);
  for (const r of out) r.counts_as_counterparty = countsAsCounterparty(r);
  return out;
}

// --- rendering ---------------------------------------------------------------

const WALLET = { opened_by_us: 'opened by our payment', already_funded: 'already funded', unopened: 'unopened (our send not yet received)',
  opened_later_by_other: 'opened after our send, by another payment', 'n/a': 'n/a (they paid first)', unknown: 'unknown' };

function fundingText(r) {
  if (r.funding.grant_funded && r.funding.paid_us) return 'grant-funded; also paid us';
  if (r.funding.grant_funded) return 'grant-funded';
  if (r.funding.independently_earned) return 'independently earned';
  return 'n/a';
}
function receiptText(r, w = s => s) {
  const f = r.first_receipt;
  if (!f) return 'n/a';
  if (f.pending) return `sent ${w(f.sent_at)}, not yet received`;
  return w(f.at);
}
function spendText(r, w = s => s, a = s => s) {
  const s = r.first_spend;
  if (s) return `${w(s.at)} ${s.to_us ? 'to us' : 'elsewhere (' + a(s.to) + ')'}`;
  return { none_yet: 'none yet', unknown: `unknown (more than ${SCAN} blocks after)`, 'n/a': 'n/a' }[r.first_spend_status] || r.first_spend_status;
}
const repeatText = r => r.interactions.count ? (r.interactions.repeat ? `repeat within ${WINDOW_DAYS} days (${r.interactions.within_30d})` : `one-off (${r.interactions.count})`) : 'none on chain';
const short = a => a.slice(0, 12) + '…' + a.slice(-6);

function intro() {
  return `<p>One row per address pursekeeper has paid or been paid by, worked out from the Nano chain (local node) and pursekeeper's own <a href="/log">ledger</a>. Addresses are the only labels; nothing here comes from private notes. <b>Wallet state</b>: whether the address had no blocks before it received pursekeeper's payment (opened by our payment) or was already funded. <b>Funding</b>: grant-funded means pursekeeper paid it; independently earned means it paid pursekeeper and was never paid by it; an address in both camps gets both flags. <b>First receipt → first spend</b>: when it received pursekeeper's first payment and when it first sent anything afterwards, to pursekeeper or elsewhere. <b>Repeat</b>: whether there was more than one payment between the two, in either direction, within ${WINDOW_DAYS} days of the first.</p>
<p class="muted">Handing out small amounts measures onboarding throughput, not demand: an address opened by pursekeeper's payment is a wallet that exists because of the grant, not a customer. The numbers that count for the experiment are inflow from addresses pursekeeper never paid and the count of distinct counterparties, both on the <a href="/log">public log</a>. Chain answers are cached for ten minutes. JSON: <a href="/cohorts.json">/cohorts.json</a>.</p>`;
}

function render(d) {
  const { esc, xno, addr, hash, when } = site;
  const w = t => t ? `<span class="num">${when(t)}</span>` : '';
  const t = d.totals;
  const rows = d.rows.map(r => `<tr><td>${addr(r.address)}<br><small class="num">paid ${xno(r.paid_raw)} (${r.paid_count}) · received ${xno(r.received_raw)} (${r.received_count})</small>${r.counts_as_counterparty === false ? '<br><small class="muted">below the Ӿ' + esc(t.min_nano) + ' threshold: listed, not counted</small>' : ''}</td>
<td>${esc(WALLET[r.wallet_state] || r.wallet_state)}${r.chain_error ? `<br><small class="dead">chain: ${esc(r.chain_error)}</small>` : ''}</td>
<td>${esc(fundingText(r))}</td>
<td>${receiptText(r, w)}${r.first_receipt && !r.first_receipt.pending ? ' ' + hash(r.first_receipt.hash) : ''}<br><small>→ ${spendText(r, w, addr)}${r.first_spend ? ' ' + hash(r.first_spend.hash) : ''}</small></td>
<td>${esc(repeatText(r))}</td>
<td><small>${r.reasons.map(x => esc(x)).join('<br>')}${r.initiative_ids.length ? '<br>' + r.initiative_ids.map(i => `<a href="/log#initiative-${i}">#${i}</a>`).join(' ') : ''}</small></td></tr>`).join('\n');
  const body = `<h1>Counterparty cohorts</h1>
${intro()}
<table><tr><th>address</th><th>wallet state</th><th>funding</th><th>first receipt → first spend</th><th>repeat</th><th>ledger reason</th></tr>
${rows || '<tr><td colspan="6" class="muted">no counterparties yet</td></tr>'}</table>
<h2>Totals</h2>
<table>
<tr><td>counterparties</td><td class="num">${t.counterparties}${t.below_threshold ? ` <small>(+${t.below_threshold} address${t.below_threshold === 1 ? '' : 'es'} below the threshold)</small>` : ''}</td></tr>
<tr><td>wallet state</td><td>${Object.entries(t.wallet_state).filter(([, n]) => n).map(([k, n]) => `${esc(WALLET[k] || k)}: ${n}`).join(' · ') || '–'}</td></tr>
<tr><td>funding</td><td>grant-funded: ${t.funding.grant_funded} · independently earned: ${t.funding.independently_earned} · grant-funded and also paid us: ${t.funding.grant_funded_and_paid_us}</td></tr>
<tr><td>first spend after our payment</td><td>to us: ${t.first_spend.to_us} · elsewhere: ${t.first_spend.elsewhere} · none yet: ${t.first_spend.none_yet} · unknown: ${t.first_spend.unknown}</td></tr>
<tr><td>repeat</td><td>one-off: ${t.repeat.one_off} · repeat within ${WINDOW_DAYS} days: ${t.repeat.repeat_within_30d}</td></tr>
<tr><td>paid / received</td><td class="num">${xno(t.paid_raw)} / ${xno(t.received_raw)}</td></tr>
</table>
<p class="muted">Generated ${when(d.generated_at)} from <a href="${EXPLORER}${ADDRESS}"><code>${short(ADDRESS)}</code></a>. Excluded: pursekeeper's own addresses, the funder's tranches, and blocks listed in data/refunds.json (change returned by a seller, not a purchase from pursekeeper). "Unopened" means the account has no blocks yet because pursekeeper's send has not been received. Chain times are when the local node saw each block. An address that paid pursekeeper counts as a counterparty only once it has sent Ӿ${esc(t.min_nano)} in total, the same rule the agent's wallet tool applies; addresses below that are listed but not counted. Addresses pursekeeper paid count regardless.</p>`;
  return site.page('pursekeeper: counterparty cohorts', body, 'Per-address cohorts for every counterparty of the pursekeeper agent: opened by its payment or already funded, grant-funded or independently earned, first spend, repeat.');
}

function markdown(d) {
  const { xno } = site;
  const t = d.totals;
  const lines = [`Counterparty cohorts as of ${d.generated_at.slice(0, 16).replace('T', ' ')} UTC (${d.rows.length} address${d.rows.length === 1 ? '' : 'es'}; chain + ledger; https://pursekeeper.dev/cohorts)`, '',
    '| address | wallet state | funding | first receipt → first spend | repeat | paid / received | reason |', '|---|---|---|---|---|---|---|'];
  for (const r of d.rows) {
    const rec = receiptText(r, s => s.replace('T', ' ').slice(0, 16));
    const sp = spendText(r, s => s.replace('T', ' ').slice(0, 16), short);
    lines.push(`| ${short(r.address)} | ${WALLET[r.wallet_state] || r.wallet_state} | ${fundingText(r)} | ${rec} → ${sp} | ${repeatText(r)} | ${xno(r.paid_raw)} / ${xno(r.received_raw)} | ${r.reasons.join('; ').replace(/\|/g, '/')}${r.initiative_ids.length ? ' (#' + r.initiative_ids.join(', #') + ')' : ''} |`);
  }
  lines.push('', `Totals: ${t.counterparties} counterpart${t.counterparties === 1 ? 'y' : 'ies'}${t.below_threshold ? ` (+${t.below_threshold} below the ${t.min_nano} XNO threshold)` : ''}; ${Object.entries(t.wallet_state).filter(([, n]) => n).map(([k, n]) => `${WALLET[k] || k} ${n}`).join(', ')}; grant-funded ${t.funding.grant_funded}, independently earned ${t.funding.independently_earned}, both ${t.funding.grant_funded_and_paid_us}; first spend to us ${t.first_spend.to_us}, elsewhere ${t.first_spend.elsewhere}, none yet ${t.first_spend.none_yet}; one-off ${t.repeat.one_off}, repeat within ${WINDOW_DAYS} days ${t.repeat.repeat_within_30d}.`);
  return lines.join('\n');
}

// --- router ------------------------------------------------------------------

// A cold computeCohorts() walks the chain for every counterparty (hundreds of RPC
// calls, well over 20 s once the per-call cache has expired), which used to stall the
// first request after every ten-minute window past most clients' timeouts (reported
// 2026-09-27). The router now serves the last finished result at once and refreshes it
// in the background, single-flight, when it is older than CACHE_MS; only the very first
// request after a restart waits, and warm() at startup makes that rare too.
let last = null;          // { at, data }
let inflight = null;      // Promise while a refresh is running
function refresh() {
  if (!inflight) {
    inflight = computeCohorts().then(data => { last = { at: Date.now(), data }; return data; }).finally(() => { inflight = null; });
  }
  return inflight;
}
async function current() {
  if (last && Date.now() - last.at < CACHE_MS) return last.data;
  if (last) { refresh().catch(() => {}); return last.data; }   // stale-while-revalidate
  return refresh();
}
function warm() {
  const t = setTimeout(() => refresh().catch(() => {}), 5_000);
  const i = setInterval(() => refresh().catch(() => {}), CACHE_MS);
  t.unref(); i.unref();
}

async function handle(req, res, u, send) {
  if (u.pathname === '/cohorts') return send(res, 200, render(await current()), 'text/html'), true;
  if (u.pathname === '/cohorts.json') return send(res, 200, JSON.stringify(await current(), null, 1)), true;
  return false;
}

module.exports = { ownFromFile, computeCohorts, warm, classify, collect, addChainOnly, isRefund, totalsOf, countsAsCounterparty, render, markdown, handle, ZERO, SCAN, WINDOW_DAYS };

if (require.main === module) {
  computeCohorts().then(d => console.log(markdown(d))).catch(e => { console.error(e.message); process.exit(1); });
}
