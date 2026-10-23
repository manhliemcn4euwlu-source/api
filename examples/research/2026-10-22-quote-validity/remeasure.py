#!/usr/bin/env python3
"""Re-measure N listings of pursekeeper.dev/sellers.json the way the quote-validity run declares:
one unpaid request in the listing's own probe shape, twice; read any decodable quote
(PAYMENT-REQUIRED header base64 JSON, or body accepts) and compare pay_to between the two answers."""
import sys, json, base64, urllib.request, urllib.error, socket, time, datetime as dt
ids = sys.argv[1:]
S = json.load(urllib.request.urlopen('https://pursekeeper.dev/sellers.json', timeout=20))
S = S.get('sellers', S)
def one(x):
    p = x.get('probe') or {}
    url = p.get('url') or x.get('endpoint') or x.get('url')
    req = urllib.request.Request(url, method=p.get('method','GET'),
        data=(p.get('body') or '').encode() if p.get('body') else None,
        headers={**{'user-agent':'pursekeeper-remeasure/1'}, **(p.get('headers') or {})})
    try:
        r = urllib.request.urlopen(req, timeout=20); status=r.status; hdr=dict(r.headers); body=r.read(20000)
    except urllib.error.HTTPError as e:
        status=e.code; hdr=dict(e.headers); body=e.read(20000)
    except Exception as e:
        return {'status':-1,'error':type(e).__name__+': '+str(e)[:80]}
    q = None; src=None
    pr = hdr.get('PAYMENT-REQUIRED') or hdr.get('Payment-Required') or hdr.get('payment-required')
    if pr:
        try: q = json.loads(base64.b64decode(pr + '=' * (-len(pr) % 4))); src='header'
        except Exception as e: q = {'undecodable': str(e)[:60]}
    if q is None:
        try:
            j = json.loads(body.decode('utf-8','replace'))
            if isinstance(j, dict) and ('accepts' in j or 'payTo' in j or 'pay_to' in j or 'address' in j): q = j; src='body'
        except Exception: pass
    acc = None
    if isinstance(q, dict):
        a = q.get('accepts')
        if isinstance(a, list) and a: acc = a[0]
        elif 'payTo' in q or 'pay_to' in q or 'address' in q: acc = q
    out = {'status':status,'source':src}
    if acc:
        out['pay_to'] = acc.get('payTo') or acc.get('pay_to') or acc.get('address')
        out['amount'] = acc.get('amount') or acc.get('maxAmountRequired') or acc.get('amount_raw') or acc.get('price')
        out['network'] = acc.get('network'); out['extra_keys'] = sorted(k for k in acc.keys() if k in ('base_price_raw','basePriceRaw','invoice','nonce','memo'))
    return out
for x in S:
    if x['id'] not in ids: continue
    a = one(x); time.sleep(1.0); b = one(x)
    stab = None
    if a.get('pay_to') and b.get('pay_to'):
        stab = 'stable' if (a['pay_to']==b['pay_to'] and str(a.get('amount'))==str(b.get('amount'))) else ('pay_to_moves' if a['pay_to']!=b['pay_to'] else 'amount_moves')
    print(json.dumps({'id':x['id'],'t':dt.datetime.now(dt.timezone.utc).strftime('%H:%M:%SZ'),'first':a,'second':b,'stability':stab}, default=str))
