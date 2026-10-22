#!/usr/bin/env python3
"""roots.py: State C funding-root walk for initiative #11 (pre-registered 2026-10-07).

    python3 trace/roots.py <nano_ account> [--max-accounts N] [--max-depth D] [--max-pages P]

Walks the receive history of a payer account backwards, breadth first, on the local node.
A branch ends at a ROOT when the account on it is funded by a listed exchange or swap hot
wallet (that account is the root: "the earliest account that is neither an exchange or swap
hot wallet nor one of mine"). A branch that ends anywhere else is STOPPED SHORT and the mode
is recorded, as the rule requires: page cap (more history than fetched), budget cap (account
or depth bound hit), cursor lost (RPC error or empty history), exchange-like (heuristic, not
listed: >= EXCH_BLOCKS blocks; reported as such, not as a root), seeded (an account on the
path is mine or one I paid: disqualifies State A, printed loudly).
Blocks and accounts are matched by hash/address only. Own and cold addresses are never
printed. Read-only. Output: trace/out/roots-<acct16>-<stamp>.{json,md}.
"""
import json, os, sys, sqlite3, urllib.request, datetime, collections

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RPC = os.environ.get('NANO_RPC', 'http://127.0.0.1:7076')
DB = os.environ.get('GAMBIT_DB', '/var/lib/gambit/gambit.db')
EXCH_BLOCKS = 20000

def rpc(**q):
    req = urllib.request.Request(RPC, json.dumps(q).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def load_set(path):
    try:
        d = json.load(open(path))
    except Exception:
        return set()
    out = set()
    def walk(o):
        if isinstance(o, str) and o.startswith('nano_') and len(o) == 65: out.add(o)
        elif isinstance(o, dict): [walk(v) for v in o.values()]
        elif isinstance(o, list): [walk(v) for v in o]
    walk(d); return out

OWN = load_set(os.path.join(WS, 'api/data/own-addresses.json')) | load_set(os.path.join(WS, 'api/data/cold-addresses.json'))
OWN.add('nano_1xug1q5t7nxoj3ywwzokiea9jz8fq8qfgzp8pbyfr3co3e5xgj755uofu8ue')
EXCH = {}
for f in ('trace/nanolooker-exchanges.json', 'trace/exchanges-local.json'):
    for e in json.load(open(os.path.join(WS, f))):
        EXCH[e['account']] = e['name']
PAID = set(r[0] for r in sqlite3.connect('file:%s?mode=ro' % DB, uri=True).execute("select counterparty from ledger where kind='payment_out' and counterparty like 'nano_%'"))

def hist(acct, max_pages):
    """all receives (source, amount, hash, ts) up to max_pages*500 rows; returns (rows, page_capped, err)"""
    rows, head, pages = [], None, 0
    while True:
        q = dict(action='account_history', account=acct, count=500)
        if head: q['head'] = head
        try:
            r = rpc(**q)
        except Exception as e:
            return rows, False, 'rpc: %s' % e
        if 'error' in r: return rows, False, r['error']
        h = r.get('history') or []
        rows += h; pages += 1
        if not r.get('previous'): return rows, False, None
        if pages >= max_pages: return rows, True, None
        head = r['previous']

def main():
    a = sys.argv[1]
    opts = dict(zip(sys.argv[2::2], sys.argv[3::2]))
    MAXA = int(opts.get('--max-accounts', 500)); MAXD = int(opts.get('--max-depth', 6)); MAXP = int(opts.get('--max-pages', 4))
    if a in OWN: print('payer is one of my own accounts: nothing to walk'); sys.exit(1)
    q = collections.deque([(a, 0, [a])]); seen = {a}
    visited = 0; rows_total = 0
    roots = {}      # root account -> {depth, fed_by: [exchange names], path}
    short = []      # stopped-short branches: {account, depth, mode}
    seeded = []     # {account, depth, why}
    exchlike = []
    funders_of = {}
    while q:
        acct, depth, path = q.popleft()
        if visited >= MAXA:
            short.append(dict(account=acct, depth=depth, mode='budget cap: max accounts %d' % MAXA)); continue
        visited += 1
        rows, capped, err = hist(acct, MAXP)
        rows_total += len(rows)
        if err:
            short.append(dict(account=acct, depth=depth, mode='cursor lost: %s' % err)); continue
        recv = [r for r in rows if r.get('type') == 'receive']
        if not recv:
            short.append(dict(account=acct, depth=depth, mode='no receives in %d rows' % len(rows))); continue
        srcs = collections.OrderedDict()
        for r in recv:
            s = r.get('account'); srcs.setdefault(s, 0); srcs[s] += int(r.get('amount', '0'))
        funders_of[acct] = {s: '%.6f' % (v / 1e30) for s, v in srcs.items()}
        is_root = False
        for s, v in srcs.items():
            if s in OWN:
                seeded.append(dict(account=acct, depth=depth, why='funded by one of my own accounts')); continue
            if s in PAID:
                seeded.append(dict(account=acct, depth=depth, why='funded by %s, an account I paid' % s)); continue
            if s in EXCH:
                roots.setdefault(acct, dict(depth=depth, fed_by=[], path=path))['fed_by'].append('%s (%s, %.6f)' % (EXCH[s], s[:16], v / 1e30)); is_root = True; continue
            if s in seen: continue
            if depth + 1 > MAXD:
                short.append(dict(account=s, depth=depth + 1, mode='budget cap: max depth %d' % MAXD)); continue
            # exchange-like heuristic: a huge unlisted account ends the branch, labelled, not a root
            try:
                bc = int(rpc(action='account_info', account=s).get('block_count', '0'))
            except Exception:
                bc = 0
            if bc >= EXCH_BLOCKS:
                exchlike.append(dict(account=s, blocks=bc, funded=acct, depth=depth + 1)); seen.add(s); continue
            seen.add(s); q.append((s, depth + 1, path + [s]))
        if capped:
            short.append(dict(account=acct, depth=depth, mode='page cap: %d rows fetched, more remain' % len(rows)))
    stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%dT%H%M%SZ')
    red = lambda s: '[own]' if s in OWN else s
    out = dict(payer=a, stamp=stamp, bounds=dict(max_accounts=MAXA, max_depth=MAXD, max_pages=MAXP, exch_blocks=EXCH_BLOCKS),
               accounts_visited=visited, distinct_accounts_seen=len(seen), rows_visited=rows_total,
               roots={k: dict(v, path=[red(p) for p in v['path']]) for k, v in roots.items()},
               stopped_short=[dict(s, account=red(s['account'])) for s in short],
               exchange_like=[dict(e, account=red(e['account']), funded=red(e['funded'])) for e in exchlike],
               seeded=[dict(s, account=red(s['account'])) for s in seeded],
               direct_funders={k: {red(s): v for s, v in d.items()} for k, d in funders_of.items() if k == a})
    os.makedirs(os.path.join(WS, 'trace/out'), exist_ok=True)
    base = os.path.join(WS, 'trace/out', 'roots-%s-%s' % (a[5:21], stamp))
    json.dump(out, open(base + '.json', 'w'), indent=1)
    modes = collections.Counter(s['mode'].split(':')[0] for s in short)
    md = ['# Funding-root walk for %s (%s)' % (a, stamp), '',
          'Bounds: %d accounts, depth %d, %d pages of 500 rows per account; exchange-like = unlisted account with >= %d blocks.' % (MAXA, MAXD, MAXP, EXCH_BLOCKS),
          'Visited %d accounts (%d distinct seen), %d history rows.' % (visited, len(seen), rows_total), '',
          '## Roots reached: %d' % len(roots)]
    for k, v in roots.items():
        md.append('- %s at depth %d, fed by %s' % (red(k), v['depth'], '; '.join(v['fed_by'])))
    md += ['', '## Branches stopped short: %d (%s)' % (len(short), ', '.join('%s %d' % kv for kv in modes.items()) or 'none')]
    for s in short[:40]: md.append('- %s depth %d: %s' % (red(s['account'])[:21], s['depth'], s['mode']))
    md += ['', '## Exchange-like, unlisted (not counted as roots): %d' % len(exchlike)]
    for e in exchlike[:20]: md.append('- %s, %d blocks, funded %s at depth %d' % (red(e['account'])[:21], e['blocks'], red(e['funded'])[:21], e['depth']))
    md += ['', '## Seeded hits (disqualify State A): %d' % len(seeded)]
    for s in seeded: md.append('- %s depth %d: %s' % (red(s['account'])[:21], s['depth'], s['why']))
    open(base + '.md', 'w').write('\n'.join(md) + '\n')
    print('\n'.join(md)); print('\nwritten', base + '.{json,md}')

if __name__ == '__main__':
    main()
