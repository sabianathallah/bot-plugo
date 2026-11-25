#!/usr/bin/env python3
"""Full drop logger for a Plugo shop: every INTERVAL s, logs per-size stock +
numOrders for ALL products in the shop to data/backup-<domain>.jsonl.
Usage: python3 -I scripts/plugo-logger.py <domain> <shopId> [intervalSec]
"""
import json, re, sys, time, urllib.request, datetime, os, concurrent.futures as cf
DOMAIN, SHOP = sys.argv[1], sys.argv[2]
INTERVAL = float(sys.argv[3]) if len(sys.argv) > 3 else 5
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', f'backup-{DOMAIN}.jsonl')
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

def get(u):
    req = urllib.request.Request(u, headers={'User-Agent': UA, 'Cache-Control': 'no-cache'})
    return urllib.request.urlopen(req, timeout=20).read().decode()

def product(pid):
    h = get(f'https://www.{DOMAIN}/products/{pid}?_={int(time.time()*1000)}')
    a = json.loads(re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', h, re.S).group(1))
    def r(v, d=0):
        if d > 8: return None
        if isinstance(v, int) and not isinstance(v, bool) and 0 <= v < len(a): v = a[v]
        else: return v
        if isinstance(v, dict): return {k: r(x, d+1) for k, x in v.items()}
        if isinstance(v, list):
            if v and v[0] in ('Reactive', 'ShallowReactive', 'Ref', 'ShallowRef'): return r(v[1], d+1)
            return [r(x, d+1) for x in v]
        return v
    o = next(r(i) for i, x in enumerate(a)
             if isinstance(x, dict) and 'productVariations' in x and 'outOfStock' in x and r(x['id']) == pid)
    vs = []
    for v in o['productVariations']:
        lab = '/'.join(str(d['value']) for d in (v.get('details') or [])) or v['product'].get('productCode')
        inv = v.get('inventories') or []
        vs.append({'label': lab, 'qty': (inv[0]['quantity'] if inv else None), 'price': v['price']})
    return {'id': pid, 'name': o['name'].strip(), 'release': o['releaseDate'],
            'numOrders': o['numOrders'], 'oos': o['outOfStock'], 'variants': vs}

def write(rec):
    with open(OUT, 'a') as f: f.write(json.dumps(rec) + '\n')

print(f'[logger] {DOMAIN} shop {SHOP} every {INTERVAL}s -> {OUT}', flush=True)
write({'t': datetime.datetime.now().astimezone().isoformat(timespec='seconds'), 'event': 'logger_start', 'interval': INTERVAL})
def notify(msg):
    os.system(f'osascript -e \'display notification "{msg}" with title "Plugo logger" sound name "Basso"\' >/dev/null 2>&1')

fails = 0
with cf.ThreadPoolExecutor(8) as ex:
    while True:
        start = time.time()
        t = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
        try:
            lst, off = [], 0
            while True:   # paginate: drops can have > 100 products
                page = json.loads(get(f'https://api.plugo.world/v1/shop/{SHOP}/products?limit=100&offset={off}'))['data'] or []
                lst += page; off += 100
                if len(page) < 100: break
            if not lst: write({'t': t, 'event': 'empty'})   # shop has no products yet (pre-drop) — heartbeat only
            if fails >= 6: notify(f'Koneksi pulih — {DOMAIN} tercatat lagi')
            fails = 0
            futs = {p['id']: (p, ex.submit(product, p['id'])) for p in lst}
            for pid, (p, f) in futs.items():
                try: write({'t': t, 'event': 'stock', 'listOrders': p.get('numOrders'), **f.result()})
                except Exception as e: write({'t': t, 'event': 'stock_error', 'id': pid, 'error': str(e)})
        except Exception as e:
            write({'t': t, 'event': 'scan_error', 'error': str(e)})
            fails += 1
            if fails == 6: notify(f'DATA TERPUTUS: {DOMAIN} gagal 30 detik — cek internet!')
        time.sleep(max(0.5, INTERVAL - (time.time() - start)))
