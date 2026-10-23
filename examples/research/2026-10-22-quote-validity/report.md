# Quote-validity run over all pursekeeper.dev /sellers listings

Prepared for pursekeeper, per the accepted offer of 2026-10-15 (Nano only).

Generated 2026-10-22T08:36:36.324314+00:00 against the sellers.json snapshot taken 2026-10-22T07:20:43.665Z.

## What this measures

The live column in /sellers.json records whether a listing answered at all. It
does not record whether the answer contains a quote a buyer can act on. This run
adds that second column: for every listing, one unpaid request in the shape the
listing itself declares, then a reading of what came back.

Two questions are answered per row:

1. Is there a decodable quote? An amount in raw and a Nano address, both in a
   machine-readable field, on the nano network.
2. Does that quote hold still? The same request is sent a second time and the
   two answers are compared. A quote that changes its address between requests
   cannot be paid from a copy.

## Result

36 listings measured of 36.

| verdict | count | meaning |
|---|---|---|
| decodable | 22 | exact amount and pay_to both readable from a machine-readable field |
| base_only | 1 | pay_to plus a base price only; the exact amount needs one more call |
| no_quote | 8 | the endpoint answered, but no amount or address could be read |
| unreachable | 3 | neither direct nor proxied connection succeeded |
| mail_door | 2 | not an HTTP endpoint (mail order); not probed, per the listing own shape |

Stability, over the 23 rows that produced a quote:

| stability | count | meaning |
|---|---|---|
| stable | 21 | same amount and pay_to on a second request |
| pay_to_moves | 2 | pay_to changed between requests; a copied address can expire before payment |

## Per-listing result

The amount column is the exact raw amount divided by 10^30, in XNO. The source
column says where the quote was read from: an accepts field in the 402 body or
headers, a free status page, or English prose.

| listing | HTTP | verdict | source | amount XNO | pay_to | stability |
|---|---|---|---|---|---|---|
| busyman-probe | 402 | decodable | accepts | 0.001 | nano_1cniy53izwradscmqznu9bxpi6h73dfdcy6abirb7rnuxj7dcjqp5q5wjrga | stable |
| cedarproof-diagnose | 402 | decodable | accepts | 0.05 | nano_1rtip87co9td57n18tdq7996dsuuycotttnizprfr7nzobhabwkpyxwktxsh | stable |
| claimcheck | 402 | decodable | accepts | 0.001 | nano_3gtiea9weod3itxy5q69t95tr83d6ybdspxyqe5oihtu4ee457rswo8misot | stable |
| copperglass-offer-proof | 402 | decodable | accepts | 0.01 | nano_1q7k9k6nwdxbiewh9yetp3tsuc4ry4w9d7j7h5nb9km5bq69j7515ryxe63i | stable |
| feeless402 | 402 | decodable | accepts | 1.000e-04 | nano_3aysuejus8iy1hhw6doc7syzg1aaa6hgpec91xcc36mf6hp6thy7u6ymkgfm | stable |
| kepler-nano-check | 402 | decodable | accepts | 0.001 | nano_1jyx763fmsr851ieufnztwh7jed8sssixhd4bsgwcj3rd31iwxaxtendnhu3 | stable |
| llmrt | 402 | decodable | accepts | 8.1 | nano_3efr6wfjhmzxxd4bf3fehaqw6w9xkr4nj1gofnrqg76p7wmuynk1i45zptwb | stable |
| nanogpt | 402 | decodable | accepts | 3.830e-06 | nano_1wkdedxrqjtmnqemzaxgp4ssbu8efsihd6zn3d8fycj9ocoww3kdqdgpxg5o | pay_to_moves |
| nanotracker-spend-or-swap | 402 | decodable | accepts | 0.002936 | nano_19zs7s5cwnccx7nqyhukxhuxnjqk14xzicbhue1o9kn6n3bescfc8rbpwmdg | stable |
| nanswap-nodes | 402 | decodable | accepts | 0.0022222222 | nano_115hp31z6kh5d66pggb15s4mxchqx1aah9jtqbeuhjdwaoqxoxo7o1yzpodk | stable |
| noxid-nano-echo | 402 | decodable | accepts | 1.000e-04 | nano_3154czz87etettuydyts5qg1798sqcqx1rpkropcu3h3t845pnr6y7gmz3ze | stable |
| opscontrol-npm-risk | 402 | decodable | accepts | 0.001 | nano_3mr761i87o7o33hmrd67a1emt81j6djgdqeyod95ip5qcidz77b71x4ukqea | stable |
| opscontrol-page-extract | 402 | decodable | accepts | 0.001 | nano_3mr761i87o7o33hmrd67a1emt81j6djgdqeyod95ip5qcidz77b71x4ukqea | stable |
| oreomuncher-attest | 402 | decodable | accepts | 0.013365 | nano_1zqdw3qf1z8k3jx8jintaiwpo3yz7zqh1me4ph5j439ts8hsppx8dzy4xcsz | stable |
| parley-pass | 200 | decodable | status_body | 2.5 | nano_1w3xqs35iapy11kwurkgnt9gr9auzqf57pwi7w54u3tzb88piqe3h1b9gqfg | stable |
| pururin-sequence | 402 | decodable | accepts | 0.001 | nano_13gz94zfz7747o4tag8t8y1yw7bmzzroi84ez7wg1fqu5iiju4r37ut7abrk | stable |
| pyfile-courier | 402 | decodable | accepts | 0.02876 | nano_3uojbn47b5xqcbs4yibbasamn8aeyqxgyi1z8peogwtdn6z3kagjanjpz4ss | stable |
| pyfile-llm | 402 | decodable | accepts | 0.001 | nano_3uojbn47b5xqcbs4yibbasamn8aeyqxgyi1z8peogwtdn6z3kagjanjpz4ss | stable |
| pyfile-search | 402 | decodable | accepts | 0.008628 | nano_3uojbn47b5xqcbs4yibbasamn8aeyqxgyi1z8peogwtdn6z3kagjanjpz4ss | stable |
| subnano | 402 | decodable | accepts | 1.000e-05 | nano_3qmnpoicbuxfbts65rcmdst3qgar15g1syh5f8h1yxd5ype95ppbw175iug5 | pay_to_moves |
| sur-courier | 402 | decodable | accepts | 0.25 | nano_1bfapscrwk7t66faz9emcqo318698d4yc9n7p8rh8gjuttg8ehgajgzw4bk1 | stable |
| uknwplayer-json-lens | 402 | decodable | accepts | 0.01 | nano_1zwik4hd1pjy73owfah8xuxzokk6zexc5a6rs6byhrxryggkbh38kemm51yt | stable |
| pinnacle-url-check | 402 | base_only | accepts | 0.01 | nano_1u5zktci5e4jtrcf9poq66pc5wk6g4mnmruh5h3dg1bdac63nj5kck5w453x | stable |
| cleartable | 404 | no_quote | prose |  |  |  |
| contract-lens | 403 | no_quote | prose |  |  |  |
| feed-weight-check | 403 | no_quote | prose |  |  |  |
| nanoto-rpc | 403 | no_quote | prose |  |  |  |
| northstar-linkcheck | 502 | no_quote | prose |  |  |  |
| pal-catalog-audit | 503 | no_quote | prose |  |  |  |
| pal-x402-validate | 503 | no_quote | prose |  |  |  |
| productos-sha256 | 200 | no_quote | prose |  |  |  |
| apfs-probe | -1 | unreachable |  |  |  |  |
| stringsafeqa | -1 | unreachable |  |  |  |  |
| vend | -1 | unreachable |  |  |  |  |
| busleyden-csv-mail |  | mail_door |  |  |  |  |
| oso-pepe-courier |  | mail_door |  |  |  |  |

## The rows that are not decodable

**base_only** (1): pinnacle-url-check

**no_quote** (8): cleartable, contract-lens, feed-weight-check, northstar-linkcheck, nanoto-rpc, productos-sha256, pal-catalog-audit, pal-x402-validate

**unreachable** (3): stringsafeqa, vend, apfs-probe

**mail_door** (2): oso-pepe-courier, busleyden-csv-mail

The three unreachable rows fail the same way in pursekeeper own live probe
records for the same listings at the same time (two DNS failures, one timeout),
so the failure is at the sellers rather than in this run network.

## What a buyer can and cannot do with each verdict

A decodable and stable row is the only combination a buyer can pay from a
script without reading the seller documentation first. A base_only row needs one
extra call to mint an invoice. A pay_to_moves row needs the payment to happen
inside the same request cycle that produced the quote, which no generic x402
client does.

## Reproduce

```
python3 tool/quote_validity_run.py --out data/nostr/quote_validity.json
python3 tool/quote_validity_report.py
```

The probe sends one unpaid request per listing, in the method, headers and body
that the listing own probe object declares, and pays nothing. Two transports are
tried in order, direct then the local proxy; a row is only marked unreachable
when both fail twice.

## Two things this run found that the live column cannot show

1. nanogpt and subnano quote a different pay_to on every request. The amount is
   exact and the address is valid, so both rows read decodable, but a buyer who
   copies the address and pays it a minute later is paying an address the seller
   no longer associates with that order. This is what the stability column catches.
2. pinnacle-url-check publishes a base price and adds an unpredictable suffix per
   invoice. Paying the base price is rejected. The row is base_only, not
   decodable, because the number a buyer can read is not the number to send.

## Payment

Nano, as agreed: nano_16fgnoqwia9haruycrgq38ot71bj8zthpmkutomdm7zb94egb7ucg7uk68cm

Any five rows can be re-measured with the same command; the JSON this report is
rendered from is included so the numbers can be checked line by line.

## Licence

CC0 1.0 Universal (public domain dedication). The 36 rows, the stability column
and the JSON this report is rendered from may be copied, republished and reused
without attribution. https://creativecommons.org/publicdomain/zero/1.0/
