"""Dust La Stella drop 21/11/2026 15:00 WIB — Excel + SQLite + PDF report.
Sources: data/dustlastella-snap-1511.json (first look 15:12) + data/backup-dustlastella.com.jsonl
Usage: venv/bin/python dls_report.py <out_dir>
"""
import json, sys, os, sqlite3, datetime as dt
from collections import defaultdict

ROOT = '/Users/mac/Downloads/bot-plugo'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
WIB = dt.timezone(dt.timedelta(hours=7))
RELEASE = dt.datetime(2026, 11, 21, 15, 0, tzinfo=WIB)
SKU = {int(k): v for k, v in json.load(open(os.path.join(HERE, 'dls-sku.json'))).items()}

def parse(t):
    return dt.datetime.fromisoformat(t).astimezone(WIB).replace(microsecond=0)

# ── Load all observations ────────────────────────────────────────────────────
obs = []  # (t, pid, name, orders, {size: qty}, {size: price})
for r in json.load(open(f'{ROOT}/data/dustlastella-snap-1511.json')):
    obs.append((parse(r['t']), r['id'], r['name'], r['numOrders'],
                {v['label']: v['qty'] or 0 for v in r['variants']},
                {v['label']: v['price'] for v in r['variants']}, r['release']))
for line in open(f'{ROOT}/data/backup-dustlastella.com.jsonl'):
    r = json.loads(line)
    if r.get('event') != 'stock':
        continue
    obs.append((parse(r['t']), r['id'], r['name'], r['numOrders'],
                {v['label']: v['qty'] or 0 for v in r['variants']},
                {v['label']: v['price'] for v in r['variants']}, r['release']))
obs.sort(key=lambda o: (o[0], o[1]))

poll_times = sorted({o[0] for o in obs})
T0, TEND = poll_times[0], poll_times[-1]

# Gaps (> 60 s without any successful poll)
gaps = [(a, b) for a, b in zip(poll_times, poll_times[1:]) if (b - a).total_seconds() > 60]
gap_min = sum((b - a).total_seconds() for a, b in gaps) / 60

# ── Per product timelines ───────────────────────────────────────────────────
tl = defaultdict(list)
meta = {}
for t, pid, name, orders, sizes, prices, release in obs:
    tl[pid].append((t, orders, sizes))
    meta[pid] = {'name': name.strip(), 'price': next((p for p in prices.values() if p), None),
                 'release': release, 'sku': SKU.get(pid, '')}

def total(sizes): return sum(sizes.values())
def fmt_t(t, day=False):
    if t is None: return '-'
    return t.strftime('%d/%m %H:%M:%S') if day or t.date() != RELEASE.date() else t.strftime('%H:%M:%S')
def rp(n): return 'Rp' + f'{int(round(n)):,}'.replace(',', '.') if n is not None else '-'

def value_at(pid, when):
    """Last observation at or before `when` (None if before first)."""
    last = None
    for t, o, s in tl[pid]:
        if t > when: break
        last = (t, o, s)
    return last or tl[pid][0]  # per-product first look can be a few seconds after T0

summary, per_size, changes, order_changes = [], [], [], []
for pid, rows in tl.items():
    m = meta[pid]
    first, last = rows[0], rows[-1]
    stock_first, orders_first = total(first[2]), first[1] or 0
    released = any(total(s) > 0 for _, _, s in rows) or orders_first > 0 or (last[1] or 0) > 0
    init_est = stock_first + orders_first
    stock_last, orders_last = total(last[2]), last[1] or 0
    sold = max(0, init_est - stock_last) if released else 0

    # sold out / back events at product level
    first_out = rows[0][0] if stock_first == 0 and released else None
    back_events, prev = [], stock_first
    min_stock, min_t, peak_after = stock_first, rows[0][0], 0
    for t, o, s in rows[1:]:
        cur = total(s)
        if first_out is None and cur == 0 and released: first_out = t
        if prev == 0 and cur > 0: back_events.append(t)
        if first_out and cur > peak_after: peak_after = cur
        if cur < min_stock: min_stock, min_t = cur, t
        prev = cur

    # per size + movement log
    sizes = list(first[2].keys())
    for size in sizes:
        series = [(t, s.get(size, 0)) for t, _, s in rows]
        down = up = 0
        for (ta, a), (tb, b) in zip(series, series[1:]):
            if a == b: continue
            gap_before = (tb - ta).total_seconds() > 60
            changes.append({'t': tb, 'pid': pid, 'name': m['name'], 'size': size, 'old': a, 'new': b,
                            'delta': b - a, 'note': 'selisih melewati jeda data' if gap_before else ''})
            if b < a: down += a - b
            else: up += b - a
        per_size.append({'pid': pid, 'name': m['name'], 'size': size, 'first': series[0][1],
                         'max': max(v for _, v in series), 'last': series[-1][1], 'down': down, 'up': up})
    for (ta, oa, _), (tb, ob, _) in zip(rows, rows[1:]):
        if oa is not None and ob is not None and oa != ob:
            order_changes.append({'t': tb, 'pid': pid, 'name': m['name'], 'old': oa, 'new': ob, 'delta': ob - oa,
                                  'note': 'selisih melewati jeda data' if (tb - ta).total_seconds() > 60 else ''})

    summary.append({
        'pid': pid, 'first_t': first[0], 'name': m['name'], 'sku': m['sku'], 'price': m['price'], 'released': released,
        'stock_first': stock_first, 'orders_first': orders_first, 'init_est': init_est,
        'stock_last': stock_last, 'orders_last': orders_last, 'sold': sold,
        'pct': (sold / init_est * 100) if init_est else 0, 'omset': sold * (m['price'] or 0),
        'omset_upper': orders_last * (m['price'] or 0), 'first_out': first_out,
        'back': back_events, 'peak_after': peak_after, 'min_stock': min_stock, 'min_t': min_t,
        'down': sum(x['down'] for x in per_size if x['pid'] == pid),
        'up': sum(x['up'] for x in per_size if x['pid'] == pid),
    })

# ── Estimation options: make sure failed payments (stock that comes back) never count as sales
HOLD_MIN = 25         # checkouts younger than this at the end of data may still fail
for s in summary:
    rows = tl[s['pid']]
    end_win = rows[-1][0] - dt.timedelta(minutes=HOLD_MIN)
    seg = [(t, total(z)) for t, _, z in rows if t >= end_win]
    s['pending'] = max(0, sum(max(0, a - b) for (_, a), (_, b) in zip(seg, seg[1:])) - sum(max(0, b - a) for (_, a), (_, b) in zip(seg, seg[1:])))
    s['A_init'], s['A_sold'] = s['init_est'], s['sold']
    s['B_sold'] = max(0, s['A_sold'] - s['pending'])
    price = s['price'] or 0
    s['A_omset'], s['B_omset'] = s['A_sold'] * price, s['B_sold'] * price
    # Only figures from our own monitoring: Opsi B is the one reported everywhere
    s['sold'], s['omset'] = s['B_sold'], s['B_omset']
    s['pct'] = s['sold'] / s['init_est'] * 100 if s['init_est'] else 0
    s['failed'] = max(0, s['orders_last'] - s['sold'])   # orders that did not end as a paid unit

summary.sort(key=lambda s: (-s['omset'], -s['orders_last'], s['name']))
sold_rows = [s for s in summary if s['released']]
idle_rows = [s for s in summary if not s['released']]
changes.sort(key=lambda c: (c['t'], c['name'], c['size']))
order_changes.sort(key=lambda c: (c['t'], c['name']))

# ── Periods ─────────────────────────────────────────────────────────────────
D = lambda d, h, mi=0: dt.datetime(2026, 11, d, h, mi, tzinfo=WIB)
bounds = [RELEASE, T0, D(21, 15, 30), D(21, 16), D(21, 17), D(21, 18), D(21, 21), D(22, 0), D(22, 1, 30), D(23, 9, 8), TEND]
bounds = sorted(set(b for b in bounds if RELEASE <= b <= TEND))

def gap_overlap(a, b):
    return sum(max(0, (min(b, gb) - max(a, ga)).total_seconds()) for ga, gb in gaps) / 60

periods = []
for a, b in zip(bounds, bounds[1:]):
    row = {'a': a, 'b': b, 'gap': gap_overlap(a, b) if a >= T0 else (b - a).total_seconds() / 60,
           'units': {}, 'orders': {}}
    for s in sold_rows:
        pid = s['pid']
        if a == RELEASE:
            row['units'][pid], row['orders'][pid] = s['orders_first'], s['orders_first']
        else:
            va, vb = value_at(pid, a), value_at(pid, b)
            row['units'][pid] = total(va[2]) - total(vb[2])
            row['orders'][pid] = (vb[1] or 0) - (va[1] or 0)
    periods.append(row)
pending_row = {'units': {s['pid']: -s['pending'] for s in sold_rows}}

def period_label(p):
    a, b = p['a'], p['b']
    same = a.date() == b.date()
    left = a.strftime('%H:%M') if a.date() == RELEASE.date() else a.strftime('%d/%m %H:%M')
    right = b.strftime('%H:%M') if same and b.date() == RELEASE.date() else b.strftime('%d/%m %H:%M')
    return f'{left} - {right}'

TOT = {k: sum(s[k] for s in sold_rows) for k in ('init_est', 'stock_last', 'sold', 'omset', 'orders_first', 'orders_last', 'omset_upper', 'stock_first',
                                                  'A_init', 'A_sold', 'B_sold', 'A_omset', 'B_omset', 'pending', 'failed', 'up')}
generated = dt.datetime.now(WIB).replace(microsecond=0)
os.makedirs(OUT, exist_ok=True)

# ═══════════════════════ REPORT SECTIONS (shared by PDF + Excel) ═══════════════════════
# Each section is defined once; the PDF and the Excel workbook are both rendered from it,
# so the two files always carry the same numbers.
for s in summary:
    s['first_out_label'] = ('sebelum 15:12' if s['first_out'] and s['first_out'] == s['first_t']
                            else (fmt_t(s['first_out']) if s['first_out'] else 'tidak habis'))
short = lambda n: (n.replace('DLS Metal Logo - ', 'Metal Logo ').replace('Signature Knit Long-Sleeve - ', 'Sig. Knit LS ')
                    .replace('Signature Knit Long Sleeve - ', 'Sig. Knit LS ').replace('Signature Logo Hoodie - ', 'Sig. Logo Hoodie ')
                    .replace('Pullover Hoodie - Red Airbrush by DLS Concept', 'Red Airbrush Hoodie').replace('DLS X REUDE - ', 'REUDE '))
pids = [s['pid'] for s in sold_rows]
pct_of = lambda a, b: (a / b * 100) if b else 0
ranked = sorted(sold_rows, key=lambda s: -s['sold'])
big_gaps = [g for g in gaps if (g[1] - g[0]).total_seconds() >= 600]

# column = (header, type, pdf width mm). types: txt, int, rp, pct
SECTIONS = []
def section(key, title, cols, rows, total=None, note=None, sheet=None):
    SECTIONS.append(dict(key=key, title=title, cols=cols, rows=rows, total=total, note=note, sheet=sheet or title[:31]))

section('ringkasan', 'Ringkasan',
    [('Stok awal est. (15:00)', 'int', 30), ('Terjual est.', 'int', 30), ('% terjual', 'pct', 30),
     ('Omset est.', 'rp', 30), ('Order Plugo', 'int', 30), ('Order gagal bayar/batal', 'int', 30)],
    [[TOT['init_est'], TOT['sold'], pct_of(TOT['sold'], TOT['init_est']), TOT['omset'], TOT['orders_last'], TOT['failed']]],
    note=(f"Angka resmi = Opsi B (lihat bagian 2b), hanya dari data yang direkam bot. Gagal bayar / checkout yang stoknya balik "
          f"tidak dihitung sebagai penjualan. Dalam 12 menit pertama sudah {TOT['orders_first']} order masuk. "
          f"7 produk DLS X REUDE ikut terjadwal 15:00 tapi tidak pernah diisi stok selama dipantau."))

section('stokawal', '1. Produk & Stok Awal (estimasi 15:00)',
    [('Produk', 'txt', 52), ('SKU', 'txt', 42), ('Harga satuan', 'rp', 22), ('Stok 15:12', 'int', 20), ('Order 15:12', 'int', 20), ('Stok awal est.', 'int', 26)],
    [[short(s['name']), s['sku'], s['price'], s['stock_first'], s['orders_first'], s['init_est']] for s in sold_rows],
    ['TOTAL', '', None, TOT['stock_first'], TOT['orders_first'], TOT['init_est']],
    note=('Stok awal est. = stok terlihat 15:12:20 + order Plugo yang terbaca bot saat itu (keduanya data asli dari website). '
          'Di data bot, stok pertama kali kembali (checkout lepas) pukul 15:18:30, jadi order s/d 15:12 dianggap masih menahan stok. '
          'Asumsi 1 unit per order.'), sheet='1 Produk & Stok Awal')

section('output', '2. Output & Estimasi Sales',
    [('Produk', 'txt', 36), ('Harga satuan', 'rp', 19), ('Stok awal est.', 'int', 15), ('Stok akhir', 'int', 13),
     ('Belum dibayar (akhir)', 'int', 16), ('Terjual est.', 'int', 14), ('% terjual', 'pct', 14), ('Omset est.', 'rp', 23),
     ('Order Plugo', 'int', 15), ('Order gagal / batal', 'int', 17)],
    [[short(s['name']), s['price'], s['init_est'], s['stock_last'], s['pending'], s['sold'], s['pct'], s['omset'], s['orders_last'], s['failed']] for s in sold_rows],
    ['TOTAL', None, TOT['init_est'], TOT['stock_last'], TOT['pending'], TOT['sold'], pct_of(TOT['sold'], TOT['init_est']), TOT['omset'], TOT['orders_last'], TOT['failed']],
    note=('Terjual est. = stok awal est. - stok akhir - checkout yang masih menahan stok di 25 menit terakhir data. '
          'Setiap checkout yang gagal bayar mengembalikan stok, sehingga otomatis tidak terhitung sebagai penjualan; kalau stok itu dibeli lagi dan dibayar, '
          'unitnya hanya terhitung sekali. Order gagal/batal = order Plugo - terjual. Omset = terjual x harga satuan, sebelum diskon/ongkir.'),
    sheet='2 Output & Estimasi Sales')

section('opsi', '2b. Opsi Estimasi (karena bot mulai 15:12)',
    [('Opsi', 'txt', 24), ('Cara hitung (semua dari data bot)', 'txt', 104), ('Terjual', 'int', 18), ('Omset est.', 'rp', 36)],
    [['A', 'Stok awal = stok 15:12 + order 15:12. Terjual = stok awal - stok akhir. Gagal bayar yang stoknya balik sudah tidak terhitung.', TOT['A_sold'], TOT['A_omset']],
     ['B (dipakai)', f"Opsi A dikurangi checkout yang masih menahan stok di 25 menit terakhir data (bisa masih gagal bayar). Saat laporan dibuat: {TOT['pending']} unit.", TOT['B_sold'], TOT['B_omset']]],
    sheet='2b Opsi Estimasi')

section('opsi_data', 'Data dasar per produk',
    [('Produk', 'txt', 34), ('Stok 15:12', 'int', 13), ('Order 15:12', 'int', 14), ('Stok akhir', 'int', 13), ('Belum dibayar (akhir)', 'int', 15),
     ('Hitungan Opsi B', 'txt', 30), ('Opsi A', 'int', 12), ('Opsi B', 'int', 12), ('Harga satuan', 'rp', 18), ('Omset Opsi B', 'rp', 21)],
    [[short(s['name']), s['stock_first'], s['orders_first'], s['stock_last'], s['pending'],
      f"{s['stock_first']} + {s['orders_first']} - {s['stock_last']} - {s['pending']} = {s['B_sold']}",
      s['A_sold'], s['B_sold'], s['price'], s['B_omset']] for s in sold_rows],
    ['TOTAL', TOT['stock_first'], TOT['orders_first'], TOT['stock_last'], TOT['pending'],
     f"{TOT['stock_first']} + {TOT['orders_first']} - {TOT['stock_last']} - {TOT['pending']} = {TOT['B_sold']}",
     TOT['A_sold'], TOT['B_sold'], None, TOT['B_omset']],
    note=('Sumber tiap kolom: Stok 15:12 & Order 15:12 = pembacaan pertama bot (15:12:20); Stok akhir = pembacaan terakhir bot; '
          'Belum dibayar = stok yang turun di 25 menit terakhir dan belum kembali. Tidak ada koreksi yang dipinjam dari toko/launching lain. '
          'Tidak dipakai: menghitung terjual dari order Plugo (727) karena angka itu ikut menghitung semua checkout yang gagal bayar. '
          'Risiko sisa: 1 order berisi >1 unit (terjual jadi kurang), restock asli dari toko (terjual jadi kurang), '
          'order lama Signature Knit Purple sebelum drop ini (terjual jadi lebih).'),
    sheet='2b Opsi Estimasi')

section('timeline', '3. Timeline Sold Out',
    [('Produk', 'txt', 50), ('Habis pertama', 'txt', 26), ('Stok muncul lagi', 'txt', 24), ('Pertama muncul lagi', 'txt', 28),
     ('Puncak stok setelah habis', 'int', 30), ('Stok akhir', 'int', 24)],
    [[short(s['name']), s['first_out_label'], f"{len(s['back'])}x", fmt_t(s['back'][0]) if s['back'] else '-', s['peak_after'], s['stock_last']] for s in sold_rows],
    note=('Purple dan Red Airbrush sempat "muncul lagi" lalu habis lagi: pola checkout yang tidak dibayar lalu stoknya dilepas. '
          'Black dan Thermal tidak pernah terlihat ada stok selama dipantau. Metal Logo Hoodie tidak pernah habis total dan masih ada stok di akhir periode.'),
    sheet='3 Timeline Sold Out')

section('ranking', '4. Ranking Produk Paling Laku',
    [('#', 'int', 8), ('Produk', 'txt', 56), ('Harga satuan', 'rp', 22), ('Terjual est.', 'int', 22), ('% terjual', 'pct', 20), ('Omset est.', 'rp', 30), ('Sisa stok', 'int', 24)],
    [[i + 1, short(s['name']), s['price'], s['sold'], s['pct'], s['omset'], s['stock_last']] for i, s in enumerate(ranked)],
    sheet='4 Ranking')

period_rows = [[period_label(p) + (' *' if p['a'] == RELEASE else ''), round(p['gap'])]
               + [f"{p['units'][x]}/{p['orders'][x]}" for x in pids] + [sum(p['units'].values()), sum(p['orders'].values())] for p in periods]
period_rows.append(['Belum dibayar (akhir)', None] + [f"{pending_row['units'][x]}/-" for x in pids] + [sum(pending_row['units'].values()), None])
section('periode', '5. Penjualan per Periode (unit net / order Plugo)',
    [('Periode (WIB)', 'txt', 37), ('Data hilang (mnt)', 'int', 15)] + [(short(meta[x]['name'])[:16], 'rtxt', 18) for x in pids]
    + [('Total unit', 'int', 15), ('Total order', 'int', 15)],
    period_rows,
    ['TOTAL', None] + [f"{s['sold']}/{s['orders_last']}" for s in sold_rows] + [TOT['sold'], TOT['orders_last']],
    note=('Format sel: unit net / order baru. Angka negatif = stok bertambah (checkout lepas atau restock). '
          '* 15:00-15:12 sebelum bot jalan: dari order Plugo yang terbaca 15:12. Periode dengan "data hilang" hanya diketahui selisih totalnya.'),
    sheet='5 Per Periode')

section('gross', '6. Pergerakan Stok (gross, selama dipantau)',
    [('Produk', 'txt', 60), ('Total stok turun', 'int', 30), ('Total stok naik', 'int', 30), ('Stok terendah', 'int', 28), ('Waktu terendah', 'txt', 34)],
    [[short(s['name']), s['down'], s['up'], s['min_stock'], fmt_t(s['min_t'], True)] for s in sold_rows],
    note=('Stok naik umumnya checkout tidak dibayar yang dilepas. Angka gross bisa lebih kecil dari aktual karena pergerakan saat jeda data '
          'tidak terlihat - karena itu angka terjual memakai selisih net.'),
    sheet='6 Pergerakan Stok')

section('catatan', '7. Catatan & Kelengkapan Data',
    [('Topik', 'txt', 30), ('Keterangan', 'txt', 152)],
    [['Metode', 'Estimasi dari stok publik + counter order Plugo, bukan data order toko. Semua angka dari data yang direkam bot sendiri.'],
     ['Mulai telat', 'Bot mulai 15:12:20; 15:00-15:12 dihitung dari stok & order Plugo yang terbaca 15:12 (lihat bagian 1).'],
     ['Jeda data', f'Total {gap_min / 60:.1f} jam tanpa data (laptop tidur / internet putus). Jeda >= 10 menit: '
                   + '; '.join(f"{fmt_t(a, True)}-{fmt_t(b, True)}" for a, b in big_gaps) + '.'],
     ['Dampak jeda', 'Terjual net & order Plugo tetap akurat (pakai titik awal & akhir). Waktu persis dan pergerakan gross saat jeda tidak diketahui.'],
     ['Restock', 'Jika toko menambah stok asli, terjual net jadi lebih kecil dari aktual.'],
     ['Sig. Knit Purple', 'Produk lama; order Plugo-nya bisa termasuk penjualan sebelum drop ini, jadi stok awal & terjual bisa lebih tinggi dari aktual.'],
     ['REUDE', 'DLS X REUDE (7 produk: ' + ', '.join(short(s['name']).replace('REUDE ', '') for s in idle_rows if 'REUDE' in s['name'])
               + ') stok tidak pernah diisi selama dipantau; order 0.'],
     ['Periode data', f'Rilis 21/11 15:00 WIB. Bot mulai {fmt_t(T0, True)}. Data s/d {fmt_t(TEND, True)} WIB. Dibuat {fmt_t(generated, True)} WIB.']],
    sheet='7 Catatan')

# ═════════════════════════════════ EXCEL ═════════════════════════════════════
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = Workbook(); wb.remove(wb.active)
BOLD = Font(bold=True); THIN = Side(style='thin', color='000000'); BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
RPF = '"Rp"#,##0'
XL_FMT = {'rp': RPF, 'pct': '0.0%', 'int': '#,##0'}
xl_val = lambda v, t: (v / 100 if (t == 'pct' and isinstance(v, (int, float))) else v)

def write_table(ws, row, sec):
    """Write one section as a bordered table starting at `row`; returns next free row."""
    ws.cell(row=row, column=1, value=sec['title']).font = Font(bold=True, size=12)
    row += 1
    for j, (h, _, _) in enumerate(sec['cols'], 1):
        c = ws.cell(row=row, column=j, value=h); c.font = BOLD; c.border = BOX
        c.alignment = Alignment(wrap_text=True, vertical='center')
    body = sec['rows'] + ([sec['total']] if sec['total'] else [])
    for i, r in enumerate(body):
        row += 1
        for j, ((_, t, _), v) in enumerate(zip(sec['cols'], r), 1):
            c = ws.cell(row=row, column=j, value=xl_val(v, t)); c.border = BOX
            if t in XL_FMT and isinstance(v, (int, float)): c.number_format = XL_FMT[t]
            if t == 'txt': c.alignment = Alignment(wrap_text=True, vertical='top')
            if t == 'rtxt': c.alignment = Alignment(horizontal='right')
            if sec['total'] and i == len(body) - 1: c.font = BOLD
    if sec['note']:
        row += 2
        c = ws.cell(row=row, column=1, value=sec['note']); c.alignment = Alignment(wrap_text=True, vertical='top')
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=max(len(sec['cols']), 6))
        ws.row_dimensions[row].height = 15 * (1 + len(sec['note']) // 140)
    return row + 3

sheets = {}
for sec in SECTIONS:
    ws = sheets.get(sec['sheet'])
    if ws is None:
        ws = sheets[sec['sheet']] = wb.create_sheet(sec['sheet']); ws._next = 1
        for j, (_, _, w) in enumerate(sec['cols'], 1):
            ws.column_dimensions[get_column_letter(j)].width = max(10, w * 0.62)
    ws._next = write_table(ws, ws._next, sec)
# wider first column for long text
for ws in wb.worksheets: ws.column_dimensions['A'].width = max(ws.column_dimensions['A'].width, 30)
wb['2b Opsi Estimasi'].column_dimensions['B'].width = 60
wb['7 Catatan'].column_dimensions['B'].width = 120

def raw_sheet(title, headers, rows, widths, fmts=None):
    ws = wb.create_sheet(title)
    ws.append(headers)
    for c in ws[1]: c.font = BOLD; c.alignment = Alignment(wrap_text=True)
    for r in rows: ws.append(r)
    for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
    for col, f in (fmts or {}).items():
        for cell in ws[col][1:]: cell.number_format = f
    ws.freeze_panes = 'A2'
    return ws

naive = lambda t: t.replace(tzinfo=None) if t else None
raw_sheet('Data - Per Size', ['Produk', 'Size', 'Stok 15:12', 'Stok tertinggi', 'Stok akhir', 'Total turun', 'Total naik'],
      [[x['name'], x['size'], x['first'], x['max'], x['last'], x['down'], x['up']]
       for x in sorted(per_size, key=lambda x: (x['name'], x['size'])) if x['pid'] in set(pids)],
      [44, 10, 11, 13, 11, 12, 12])
raw_sheet('Data - Pergerakan Stok', ['Waktu (WIB)', 'Produk', 'Size', 'Stok lama', 'Stok baru', 'Delta', 'Catatan'],
      [[naive(c['t']), c['name'], c['size'], c['old'], c['new'], c['delta'], c['note']] for c in changes],
      [20, 44, 10, 10, 10, 8, 28], {'A': 'dd/mm/yyyy hh:mm:ss'})
raw_sheet('Data - Order Plugo', ['Waktu (WIB)', 'Produk', 'Order lama', 'Order baru', 'Delta', 'Catatan'],
      [[naive(c['t']), c['name'], c['old'], c['new'], c['delta'], c['note']] for c in order_changes],
      [20, 44, 11, 11, 8, 28], {'A': 'dd/mm/yyyy hh:mm:ss'})
raw_sheet('Data - Jeda', ['Mulai (data terakhir)', 'Selesai (data berikutnya)', 'Durasi (menit)'],
      [[naive(a), naive(b), round((b - a).total_seconds() / 60, 1)] for a, b in gaps],
      [22, 22, 14], {'A': 'dd/mm/yyyy hh:mm:ss', 'B': 'dd/mm/yyyy hh:mm:ss'})
raw_sheet('Data - Snapshot Mentah', ['Waktu (WIB)', 'Product ID', 'Produk', 'Size', 'Stok', 'Order Plugo'],
      [[naive(t), pid, name.strip(), size, q, orders] for t, pid, name, orders, sizes, _, _ in obs for size, q in sizes.items()],
      [20, 11, 44, 10, 8, 11], {'A': 'dd/mm/yyyy hh:mm:ss'})
xlsx_path = os.path.join(OUT, 'Data Dust La Stella - Drop 21 Nov 2026.xlsx')
wb.save(xlsx_path)

# ════════════════════════════════ SQLITE ═════════════════════════════════════
db_path = os.path.join(OUT, 'Database Dust La Stella - Drop 21 Nov 2026.db')
if os.path.exists(db_path): os.remove(db_path)
db = sqlite3.connect(db_path)
db.executescript('''
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, sku TEXT, price INTEGER, release_at TEXT,
  stock_1511 INTEGER, orders_1511 INTEGER, stock_initial_est INTEGER, stock_last INTEGER, orders_last INTEGER,
  sold_est INTEGER, omset_est INTEGER, omset_upper INTEGER, first_sold_out TEXT, released INTEGER);
CREATE TABLE snapshots (t TEXT, product_id INTEGER, size TEXT, stock INTEGER, num_orders INTEGER);
CREATE TABLE stock_changes (t TEXT, product_id INTEGER, size TEXT, old_stock INTEGER, new_stock INTEGER, delta INTEGER, note TEXT);
CREATE TABLE order_changes (t TEXT, product_id INTEGER, old_orders INTEGER, new_orders INTEGER, delta INTEGER, note TEXT);
CREATE TABLE data_gaps (start_t TEXT, end_t TEXT, minutes REAL);
CREATE INDEX idx_snap ON snapshots(product_id, t);
''')
iso = lambda t: t.isoformat() if t else None
db.executemany('INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [(s['pid'], s['name'], s['sku'], s['price'], meta[s['pid']]['release'], s['stock_first'], s['orders_first'], s['init_est'],
      s['stock_last'], s['orders_last'], s['sold'], s['omset'], s['omset_upper'], iso(s['first_out']), int(s['released'])) for s in summary])
db.executemany('INSERT INTO snapshots VALUES (?,?,?,?,?)',
    [(iso(t), pid, size, q, orders) for t, pid, _, orders, sizes, _, _ in obs for size, q in sizes.items()])
db.executemany('INSERT INTO stock_changes VALUES (?,?,?,?,?,?,?)',
    [(iso(c['t']), c['pid'], c['size'], c['old'], c['new'], c['delta'], c['note']) for c in changes])
db.executemany('INSERT INTO order_changes VALUES (?,?,?,?,?,?)',
    [(iso(c['t']), c['pid'], c['old'], c['new'], c['delta'], c['note']) for c in order_changes])
db.executemany('INSERT INTO data_gaps VALUES (?,?,?)', [(iso(a), iso(b), round((b - a).total_seconds() / 60, 1)) for a, b in gaps])
db.commit(); db.close()

# ═════════════════════════════════ PDF ═══════════════════════════════════════
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

pdf_path = os.path.join(OUT, 'Laporan Dust La Stella - Drop 21 Nov 2026.pdf')
ss = getSampleStyleSheet()
H1 = ParagraphStyle('h1', parent=ss['Normal'], fontName='Helvetica-Bold', fontSize=13, leading=16, spaceAfter=4)
H2 = ParagraphStyle('h2', parent=ss['Normal'], fontName='Helvetica-Bold', fontSize=10, leading=13, spaceBefore=9, spaceAfter=4)
H3 = ParagraphStyle('h3', parent=H2, fontSize=8.5, spaceBefore=5)
P = ParagraphStyle('p', parent=ss['BodyText'], fontSize=8.5, leading=11)
SM = ParagraphStyle('sm', parent=P, fontSize=7.5, leading=9.5)
CELL = ParagraphStyle('cell', parent=P, fontSize=7.5, leading=9)
HEAD = ParagraphStyle('head', parent=CELL, fontName='Helvetica-Bold')

def pdf_val(v, t):
    if v is None: return ''
    if t == 'rp': return rp(v)
    if t == 'pct': return f'{v:.1f}%'
    if t == 'int' and isinstance(v, (int, float)): return f'{int(v):,}'.replace(',', '.')
    return str(v)

def pdf_table(sec):
    head = [Paragraph(h, HEAD) for h, _, _ in sec['cols']]
    body = sec['rows'] + ([sec['total']] if sec['total'] else [])
    data = [head] + [[Paragraph(pdf_val(v, t), CELL) if t == 'txt' and len(pdf_val(v, t)) > 24 else pdf_val(v, t)
                      for (_, t, _), v in zip(sec['cols'], r)] for r in body]
    t = Table(data, colWidths=[w * mm for _, _, w in sec['cols']], repeatRows=1)
    st = [('FONT', (0, 0), (-1, -1), 'Helvetica', 7.5), ('GRID', (0, 0), (-1, -1), 0.4, colors.black),
          ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('TOPPADDING', (0, 0), (-1, -1), 2.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5)]
    for j, (_, typ, _) in enumerate(sec['cols']):
        if typ != 'txt': st.append(('ALIGN', (j, 1), (j, -1), 'RIGHT'))  # rtxt = right-aligned text
    if sec['total']: st.append(('FONT', (0, -1), (-1, -1), 'Helvetica-Bold', 7.5))
    t.setStyle(TableStyle(st)); return t

story = [Paragraph('Laporan Drop Dust La Stella - 21 November 2026', H1),
         Paragraph(f'Sumber: bot stock monitor (cek tiap 5-10 detik) + counter order Plugo. Rilis 21/11/2026 15:00 WIB. '
                   f'Bot mulai {fmt_t(T0)} WIB (terlambat 12 menit). Data s/d {fmt_t(TEND, True)} WIB. '
                   f'Dibuat {fmt_t(generated, True)} WIB.', P), Spacer(1, 4)]
for sec in SECTIONS:
    story += [Paragraph(sec['title'], H3 if sec['key'] == 'opsi_data' else H2), pdf_table(sec)]
    if sec['note']: story += [Spacer(1, 2), Paragraph(sec['note'], SM)]

SimpleDocTemplate(pdf_path, pagesize=A4, leftMargin=14*mm, rightMargin=14*mm, topMargin=14*mm, bottomMargin=14*mm,
                  title='Laporan Drop Dust La Stella 21 Nov 2026').build(story)

print('OK', T0, TEND, f'gaps {gap_min / 60:.1f}h', TOT)
for s in sold_rows: print(f"  {s['name'][:40]:40} init {s['init_est']:4} last {s['stock_last']:3} sold {s['sold']:4} orders {s['orders_first']}->{s['orders_last']} omset {rp(s['omset'])}")
print(xlsx_path, db_path, pdf_path, sep='\n')
