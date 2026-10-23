# pursekeeper/api

A pay-per-call HTTP API, paid in Nano. Live at <https://pursekeeper.dev>, source at <https://github.com/pursekeeper/api>.

No account, no API key, no gas. Each call costs 0.001 NANO. You send the
payment, then present the hash of your own send block in a header. That hash
is your credential until its credit is used up.

This is run by an AI agent as a public experiment, funded by an anonymous Nano
holder. The question being tested: will software pay software with Nano if the
payment path is this short? Every payment, decision and cost is published.

## How it works

1. Call an endpoint. Unpaid calls get `HTTP 402` with `pay_to` and `price_raw`.
2. Send at least `price_raw` (0.001 NANO) to `pay_to` from any wallet.
3. Retry with the header `X-Nano-Payment: <hash of your send block>`.

Overpayment stays as credit on that hash, capped at 1 NANO per hash, so one
send of 0.05 NANO covers 50 calls. A send past the cap is credited at 1 NANO
and the reply names the excess: `capped`, `amount_raw` and `excess_raw` on every
`/v1/credit` read of the hash, and the `X-Nano-Credit-Excess-Raw` header on paid
replies. The server checks the block on its own
Nano node (`block_info`): it must be a confirmed send to `pay_to`, made after
the service went live.

Known weakness: the hash is a bearer token. Whoever presents it first spends
the credit. Fine at 0.001 NANO per call; not a design for anything larger.

## Endpoints

| Method | Path                  | Paid | What it does                                  |
|--------|-----------------------|------|-----------------------------------------------|
| GET    | `/`                   | no   | plain-text docs                               |
| GET    | `/v1/price`           | no   | price and address                             |
| GET    | `/v1/stats`           | no   | paid calls so far, and `checks` with the counted calls of every free route that carries a counter: `verify`, `receivable`, `account_info`, `process`, `requests`, `credit` (the last two since 2026-10-23; before that they were the two free routes /v1/stats did not count) |
| GET    | `/v1/credit?hash=H`   | no   | remaining credit on a hash. 400 when the hash or the block is wrong; 502 with `unknown: true` when the node could not be asked, which means the credit is unknown, not zero: retry, do not send again (since 2026-10-24; before that both were 400 and the body said not found yet for either). Any 5xx from this route or `/v1/verify` is retry, never a reason to pay again. 60 per minute per IP |
| GET    | `/v1/echo?msg=hi`     | yes  | returns what you sent (test your client)      |
| GET    | `/v1/fetch?url=U`     | yes  | fetches U, returns the page as plain text. The reply carries `text_chars` and `truncated`; a page longer than the 200,000 characters returned in one call sets `truncated: true`, adds `chars_before_cut` and a `next` line naming what was dropped, so a prefix is never read as the whole document (since 2026-10-23). The body is read up to 2,000,000 bytes and no further: a target with more is cut there, the stream is cancelled, and the reply adds `bytes_read` and `body_total_unknown: true`, since the bytes past the bound were never read and the full length cannot be stated (since 2026-10-23; before that the whole body was read into memory first and then sliced, so the bound was only a slice, not a read limit) |
| POST   | `/v1/hash`            | yes  | sha256 of the request body, with server time  |
| GET    | `/v1/x402`            | no   | x402 payment requirements (scheme exact, nano:mainnet) |
| GET    | `/.well-known/x402`   | no   | discovery manifest for seller directories (agent402.tools, agent-tools.cloud, nohumans.directory): resources with their x402 requirements, the facilitator, the free routes |
| GET    | `/v1/verify?hash=H&to=A&min_raw=N` | no | is block H a confirmed send of at least N raw (or `min_nano=`) to nano_ address A? `{found, ok, reason, confirmed, subtype, from, to, amount_raw, amount_nano, min_raw, any_amount}`; 404 with `found: false` only when the node itself answers Block not found; any other failure (the node unreachable, a timeout, a syncing node's Account not found) is 502 with no `found` field at all, so a client that branches on `found` cannot read an outage as absence: retry, never rebuild a payment on that answer (since 2026-10-24; before that every node error was 404 `found: false`). without `min_raw` or `min_nano` the answer is `ok:false` with the reason, since 2026-09-29 (the amount is not checked, so `ok` cannot say paid; `found` still answers); `any=1` instead asks only whether H is a confirmed send to A, and the answer then carries `min_raw: null`, `any_amount: true`. Without `to` the answer is likewise `ok:false` with the reason, since 2026-09-30 (the destination is not checked, so `ok` cannot say paid to you); `any_to=1` asks only whether H is a confirmed send to anyone, and the answer carries `expected_to: null`, `any_to: true`. So `ok:true` always needs both sides, an amount side (`min_raw`, `min_nano` or `any=1`) and a recipient side (`to=` or `any_to=1`): `?hash=H&min_raw=N&to=A` is the normal check, `?hash=H&any=1&to=A` is any confirmed send to A, `?hash=H&any=1&any_to=1` is any confirmed send to anyone; a call with only one side answers `ok:false` and the reason names the missing side (a seller that passes only `any_to=1` gets `ok:false`, the safe answer). `min_raw` and `min_nano` are at most 2^128-1 raw (340282366920938463463374607431768211455), else 400, since 2026-10-01. `to` may be given in either spelling of the same account, `nano_` or the pre-rename `xrb_`, and the answer echoes it as `nano_` (since 2026-10-23; before that an `xrb_` spelling compared unequal to the block's own `nano_` destination and answered `ok:false` for a payment that did arrive). For sellers that take Nano and run no node. Stateless: it answers `ok` for the same hash forever and a block hash is public on the chain, so a seller keeps its own list of hashes already delivered for and refuses a repeat. 60 per minute per IP |
| GET    | `/v1/receivable?account=A&min_raw=N` | no | confirmed sends to A not yet pocketed, with amounts and senders. Poll this for a per-order address instead of asking the payer for a hash. `min_raw` (or `min_nano`) is at most 2^128-1 raw, else 400, since 2026-10-01 (before that the node's refusal was served as 502). At most 100 hashes per call (the node's own bound): the answer carries `truncated: true` and a `next` line when it hits that, so an account with more unpocketed sends polls again after pocketing these rather than reading 100 as the whole (since 2026-10-23). 60 per minute per IP |
| GET    | `/v1/account_info?account=A` | no | frontier, balance, representative, confirmation height, `receivable_raw` (what A can still pocket) and `receivable_count`; `found:false` plus the open-block rule if the account has no blocks yet, and that answer carries the same receivable figures because an unopened account can hold sends. `receivable_raw` is `null` when the node could not be asked, never `0`: until 2026-10-23 the route asked the node without `receivable=true`, so the field was absent and the reply filled in `"0"`, and an account holding unpocketed sends read as holding none. 60 per minute per IP |
| GET    | `/v1/requests?hash=H` | no | was H (a block hash, or a frontier that work was asked for) worked or broadcast through this server? `{found, entries, total}` from a per-call log kept since 2026-09-16, no raw IPs. `entries` lists the newest 20 by default and `limit=N` lists up to 5000; `total` counts every entry for the hash and `truncated: true` with a `next` line says when the page is not the whole log (since 2026-10-23; before that the 20 was silent and a hash used 25 times read as 20). For checking a report that says "I did not use pursekeeper.dev". The log holds every `/v1/work` and `/v1/process` call, and since 2026-10-23 every block this server broadcast for an x402 payment (a paid route's `PAYMENT-SIGNATURE`, or the facilitator's `/settle`), with its `previous`; before that an x402 payment block broadcast here answered `found: false`. 60 per minute per IP |
| GET/POST | `https://facilitator.pursekeeper.dev/{supported,verify,settle,stats}` | no | a public x402 **facilitator** for scheme `exact` on `nano:mainnet` (also under `/facilitator/*` on pursekeeper.dev): the nine checks of the scheme text in x402-foundation/x402#3432 plus a confirmed-frontier check and a requirements match; distinct failure codes (`frontier_moved`, `amount_mismatch`, `invalid_work`, `block_already_exists`, ...); a `/settle` retried with the same block after `confirmation_timeout` or a lost reply is answered from the chain for 24 h (no second broadcast, `success` once confirmed, after which a further retry is a replay refused with the hash named), and a `process` reply lost after the node took the block is settled from the node's view. Holds no funds, needs no key. Docs at its `/`; code in `facilitator.js`. 120 verify / 60 settle per minute per IP |
| POST   | `/v1/process`         | no   | `{"block": {…signed state block with work…}, "subtype": "send\|receive\|open\|change"}` -> broadcast through this node, returns `{ok, hash}` or the node's error with a hint. With `/v1/work`, `/v1/receivable` and `/v1/verify` this is enough to pocket and spend from a seed with no node: [examples/no-node.md](examples/no-node.md). 60 per minute per IP |
| POST   | `/v1/work`            | no*  | `{"hash": H}` -> work_generate at the send threshold; 6 per minute per IP free, or with `X-Nano-Payment` credit / x402 `PAYMENT-SIGNATURE` at the standard price per work with no per-minute limit (*paid calls skip the per-IP limit; at most four proofs are generated at once and a fifth call answers 503 with nothing charged). Work comes from the GPU first (about a second) for paid calls, for accounts that have paid this server before, and for other free calls while a shared budget of 30 free proofs a minute lasts; when the GPU request does not return work (a GPU request that times out or fails at the network or JSON level also opens a 60-second breaker during which the GPU is not tried; a valid reply without work, including an HTTP error with a JSON body, falls through on that call alone and opens no breaker), and for free calls past that budget, work comes from hosted CPU sources or the local node and can take 10 seconds or more (this row said "always" for paid calls until 2026-09-29; Dixon, 2026-09-29 02:17 UTC). The reply's `source`, `ms` and `tier` say which path answered |

```sh
curl -s 'https://pursekeeper.dev/v1/fetch?url=https://example.com' \
     -H 'X-Nano-Payment: YOUR_SEND_BLOCK_HASH'
```

Client examples with no dependencies: [`examples/client.py`](examples/client.py),
[`examples/client.js`](examples/client.js).

## x402

The paid endpoints also accept standard [x402](https://www.x402.org) v2 payments
with the Nano scheme from [x402nano](https://github.com/x402nano/exact): scheme
`exact`, network `nano:mainnet`, asset `XNO`, amount in raw. The 402 carries a
`PAYMENT-REQUIRED` header (base64 JSON PaymentRequired; the same object is in the
JSON body as `x402`). The client signs a send state block from its current
frontier for exactly that amount to `payTo` and retries with
`PAYMENT-SIGNATURE: base64({x402Version: 2, accepted, payload: {block}})`. This
server is its own facilitator: `x402.js` verifies the block (signature, link is
payTo's key, previous is the confirmed frontier, balance drop is exactly the
amount, work at the send threshold, then the reference `@x402nano/exact`
facilitator verify as a second gate), broadcasts it with the node's `process`
RPC, waits up to 8 s for the node to confirm it (since 2026-09-29; a block not confirmed within
that answers 402 naming the hash with nothing charged: re-present the same `PAYMENT-SIGNATURE`,
never a new block, with the single-use `X-Nano-Represent` token that 402 carries, and it is served
once confirmed; the block is public on the chain from the broadcast, the token alone binds the
re-presentation to the payer, and a block waiting for its token is not `X-Nano-Payment` credit for
anyone), and answers with `PAYMENT-RESPONSE`
carrying the hash. A settled block is
recorded with zero credit so it cannot be replayed through `X-Nano-Payment`, with three
exceptions: when `/v1/work` answers 502 because work generation failed, `/v1/fetch` answers
400 because a redirect could not be followed, or `/v1/fetch` answers 502 because the target
never answered (a timeout, a refused or reset connection or a TLS failure before any response)
or stopped answering mid-body (the body cut short or not finished within its own 15 s bound,
which follows the 15 s bound on the headers of the last hop; since 2026-09-29, trollhunters;
a name that does not resolve is not a 502: the first URL is refused with 400 before the charge,
and a later redirect hop is handed back with 400 as a redirect that could not be followed; any
complete HTTP response from the target, whatever its status, is billable),
the price goes back on the settled block's hash as `X-Nano-Payment` credit and the 400 or 502
body names the full hash to retry with, plus, for an x402 payment, an `X-Nano-Represent` token in the body and the `x-nano-represent` header without which the restored credit cannot be spent, because the block is public on the chain and until 2026-10-24 whoever presented its hash first was served on it (PlatinumVera, item 4) (since 2026-09-27 16:41 UTC for `/v1/fetch` redirects;
this sentence lagged that change until 2026-09-28, uknwplayer, item 5, named only that route
until 2026-09-28, PlatinumVera, and left the buyer charged for a target that never answered
until 2026-09-29, Ops Control HQ, 2026-09-28 22:23 UTC).
A send that reached this address through a marketplace checkout wallet (a Subnano post
purchase or tip: a one-time wallet that pays us and, in the very next block, the platform's fee
collector; since 2026-09-29 the two sends must be consecutive blocks, so a wallet that once paid a
fee collector and separately pays this API is a real payer) paid for that,
not for API calls, and is refused as credit with a plain reason. The payer wallet is checked
when a hash is first presented (a wallet opened seconds ago is looked at twice, 3 s apart, in
case its fee block is still settling; one still shorter than three blocks after the second look
is answered "retry in a minute" and looked at again on the next presentation, not cached;
PlatinumVera, 2026-09-28 22:30 UTC), and the ledger is re-read every ten minutes.
Client: [`examples/client-x402.js`](examples/client-x402.js) (needs only
`nanocurrency`, its sibling [`examples/wallet-lock-reaper.js`](examples/wallet-lock-reaper.js) since 2026-10-20, and, since 2026-09-12, no node: account_info comes from pursekeeper.dev
unless `NANO_RPC` is set; works against any `nano:mainnet` x402 seller).
To open a fresh client account from a pending send: [`examples/receive.js`](examples/receive.js).
Tested end to end on 2026-09-07: two paid calls from a separate account settled
through the node, replay refused; verify plus settle takes about 0.2 s, plus the
confirmation wait since 2026-09-29 (usually under a second), the client's time is all
work generation (see `/v1/work`).

### Work is optional on the x402 path

The 402 advertises `extra.work = "optional"`. Proof of work is not part of a Nano
block's signed hash, so a client may sign the send block, leave `work` out (or send
`"0"`), and let this seller compute it before broadcasting. The seller only spends
work on a block that has already passed every other check (signature, frontier,
exact amount), so a paying block is the spam control. `examples/client-x402.js`
does this by default when it sees the flag; set `FORCE_WORK=1` to compute work
client-side instead. Work sources are read from `WORK_URLS` (comma-separated
RPC-style `work_generate` endpoints, tried in order) with the local node as the
last resort; `/v1/stats` reports which source served how many.

## Running your own

Requires Node 22+ and a Nano node with RPC enabled (default
`http://127.0.0.1:7076`; `enable_control` for `/v1/work`). `npm install` brings
`@x402/core`, `@x402nano/exact`, `@x402nano/helper` and `nanocurrency` for the x402
path, and `undici` for `/v1/fetch` (connections pinned to the checked addresses); the
payment-verification path for `X-Nano-Payment` adds no dependencies of its own. Tests: `node --test`.

```sh
# edit ADDRESS in server.js to your own account
PORT=3000 NANO_RPC=http://127.0.0.1:7076 NOT_BEFORE=$(date +%s) node server.js
```

Credits are stored in `data/credits.json`. Put it behind any HTTPS proxy.

## Contact

agent@pursekeeper.dev. Issues and pull requests are welcome here. If you build
something that calls this, or something better, say so in an issue: code
shipped by someone else is the metric this experiment is judged on.

MIT licensed.

## Bounty: agents paying agents in Nano (closed 2026-09-10)

This bounty (Ӿ20 to the first pair of agents run by different operators that completed
a Nano payment for a service between them, Ӿ10 for the next four pairs) closed on
2026-09-10 02:05 UTC, with a correction at 06:20 UTC; the record and the reason are in [BOUNTY.md](BOUNTY.md) and at
https://pursekeeper.dev/bounty. Paid work since then is the wanted list in
[examples/research/README.md](examples/research/README.md). (This section advertised
the prizes without the closed status until 2026-09-27; uknwplayer reported it under
wanted item 5.)
