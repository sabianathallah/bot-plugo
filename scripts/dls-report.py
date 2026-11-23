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

def period_label(p):
    a, b = p['a'], p['b']
    same = a.date() == b.date()
    left = a.strftime('%H:%M') if a.date() == RELEASE.date() else a.strftime('%d/%m %H:%M')
    right = b.strftime('%H:%M') if same and b.date() == RELEASE.date() else b.strftime('%d/%m %H:%M')
    return f'{left} - {right}'

TOT = {k: sum(s[k] for s in sold_rows) for k in ('init_est', 'stock_last', 'sold', 'omset', 'orders_first', 'orders_last', 'omset_upper', 'stock_first')}
generated = dt.datetime.now(WIB).replace(microsecond=0)
os.makedirs(OUT, exist_ok=True)

# ═════════════════════════════════ EXCEL ═════════════════════════════════════
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

wb = Workbook()
HFILL = PatternFill('solid', fgColor='1F1F1F'); HFONT = Font(bold=True, color='FFFFFF')
RPF = '"Rp"#,##0'

def sheet(title, headers, rows, widths, fmts=None, first=False):
    ws = wb.active if first else wb.create_sheet()
    ws.title = title
    ws.append(headers)
    for c in ws[1]: c.fill, c.font, c.alignment = HFILL, HFONT, Alignment(vertical='center', wrap_text=True)
    for r in rows: ws.append(r)
    for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
    for col, f in (fmts or {}).items():
        for cell in ws[col][1:]: cell.number_format = f
    ws.freeze_panes = 'A2'
    return ws

naive = lambda t: t.replace(tzinfo=None) if t else None
for s in summary:
    s['first_out_label'] = 'sebelum 15:12' if s['first_out'] and s['first_out'] == s['first_t'] else (fmt_t(s['first_out'], True) if s['first_out'] else '-')
ws = sheet('Ringkasan', ['Produk', 'SKU', 'Harga', 'Stok terlihat 15:12', 'Order Plugo 15:12', 'Stok awal est. 15:00',
                         'Stok akhir', 'Terjual est. (net)', '% terjual', 'Omset est.', 'Order Plugo akhir',
                         'Omset batas atas (order x harga)', 'Habis pertama (WIB)', 'Stok muncul lagi (x)'],
      [[s['name'], s['sku'], s['price'], s['stock_first'], s['orders_first'], s['init_est'], s['stock_last'], s['sold'],
        s['pct'] / 100, s['omset'], s['orders_last'], s['omset_upper'], s['first_out_label'], len(s['back'])] for s in sold_rows]
      + [['TOTAL', '', None, TOT['stock_first'], TOT['orders_first'], TOT['init_est'], TOT['stock_last'], TOT['sold'],
          TOT['sold'] / TOT['init_est'] if TOT['init_est'] else 0, TOT['omset'], TOT['orders_last'], TOT['omset_upper'], None, None]]
      + [[s['name'] + ' (belum ada stok)', s['sku'], s['price'], 0, 0, 0, 0, 0, 0, 0, s['orders_last'], 0, None, 0] for s in idle_rows],
      [44, 22, 13, 12, 12, 13, 10, 12, 10, 16, 12, 18, 18, 12],
      {'C': RPF, 'J': RPF, 'L': RPF, 'I': '0.0%'}, first=True)
ws[f'A{len(sold_rows) + 2}'].font = Font(bold=True)

sheet('Per Size', ['Produk', 'Size', 'Stok 15:12', 'Stok tertinggi', 'Stok akhir', 'Total turun', 'Total naik'],
      [[x['name'], x['size'], x['first'], x['max'], x['last'], x['down'], x['up']]
       for x in sorted(per_size, key=lambda x: (x['name'], x['size'])) if x['pid'] in {s['pid'] for s in sold_rows}],
      [44, 10, 11, 13, 11, 12, 12])

pids = [s['pid'] for s in sold_rows]
sheet('Per Periode', ['Periode (WIB)', 'Data hilang (menit)'] + [f'{meta[p]["name"][:28]} - unit' for p in pids] + ['Total unit (net)']
      + [f'{meta[p]["name"][:28]} - order' for p in pids] + ['Total order'],
      [[period_label(p) + (' *' if p['a'] == RELEASE else ''), round(p['gap'])]
       + [p['units'][x] for x in pids] + [sum(p['units'].values())]
       + [p['orders'][x] for x in pids] + [sum(p['orders'].values())] for p in periods],
      [24, 12] + [14] * (2 * len(pids) + 2))

sheet('Pergerakan Stok', ['Waktu (WIB)', 'Produk', 'Size', 'Stok lama', 'Stok baru', 'Delta', 'Catatan'],
      [[naive(c['t']), c['name'], c['size'], c['old'], c['new'], c['delta'], c['note']] for c in changes],
      [20, 44, 10, 10, 10, 8, 28], {'A': 'dd/mm/yyyy hh:mm:ss'})
sheet('Order Plugo', ['Waktu (WIB)', 'Produk', 'Order lama', 'Order baru', 'Delta', 'Catatan'],
      [[naive(c['t']), c['name'], c['old'], c['new'], c['delta'], c['note']] for c in order_changes],
      [20, 44, 11, 11, 8, 28], {'A': 'dd/mm/yyyy hh:mm:ss'})
sheet('Jeda Data', ['Mulai (data terakhir)', 'Selesai (data berikutnya)', 'Durasi (menit)'],
      [[naive(a), naive(b), round((b - a).total_seconds() / 60, 1)] for a, b in gaps],
      [22, 22, 14], {'A': 'dd/mm/yyyy hh:mm:ss', 'B': 'dd/mm/yyyy hh:mm:ss'})

ws = wb.create_sheet('Snapshot Mentah'); ws.append(['Waktu (WIB)', 'Product ID', 'Produk', 'Size', 'Stok', 'Order Plugo'])
for c in ws[1]: c.fill, c.font = HFILL, HFONT
for t, pid, name, orders, sizes, _, _ in obs:
    for size, q in sizes.items(): ws.append([naive(t), pid, name.strip(), size, q, orders])
for col, w in zip('ABCDEF', [20, 11, 44, 10, 8, 11]): ws.column_dimensions[col].width = w
for cell in ws['A'][1:]: cell.number_format = 'dd/mm/yyyy hh:mm:ss'
ws.freeze_panes = 'A2'

notes = [
    ['Metode', 'Estimasi dari stok publik dan counter order Plugo, bukan data order toko.'],
    ['Stok awal 15:00', 'Stok terlihat 15:12 + order Plugo s/d 15:12. Sebelum 15:12 belum ada checkout yang lepas (lepas 12-22 mnt), jadi stok yang hilang = checkout. Asumsi 1 unit per order.'],
    ['Terjual (net)', 'Stok awal est. - stok akhir. Tahan terhadap jeda data karena hanya butuh titik awal & akhir. Jika ada restock asli, angka ini under-estimate.'],
    ['Omset est.', 'Terjual x harga normal (sebelum diskon/ongkir).'],
    ['Batas atas', 'Order Plugo x harga. Order Plugo menghitung semua checkout termasuk yang tidak dibayar.'],
    ['Bot mulai', f'{fmt_t(T0, True)} WIB (terlambat dari rilis 15:00).'],
    ['Data sampai', f'{fmt_t(TEND, True)} WIB. Total jeda data {gap_min / 60:.1f} jam (laptop tidur / koneksi putus) - lihat sheet Jeda Data.'],
    ['Signature Knit Purple', 'Produk lama (ID lebih kecil); order Plugo bisa termasuk penjualan sebelum drop ini.'],
    ['Dibuat', f'{fmt_t(generated, True)} WIB'],
]
sheet('Catatan', ['Topik', 'Keterangan'], notes, [22, 120])
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
P = ParagraphStyle('p', parent=ss['BodyText'], fontSize=8.5, leading=11)
SM = ParagraphStyle('sm', parent=P, fontSize=7.5, leading=9.5)
CELL = ParagraphStyle('cell', parent=P, fontSize=7.5, leading=9)
HEAD = ParagraphStyle('head', parent=CELL, fontName='Helvetica-Bold')

def table(data, widths, bold_last=False, align_right_from=1):
    data = [[Paragraph(str(c), HEAD) for c in data[0]]] + \
           [[Paragraph(str(c), CELL) if isinstance(c, str) and len(c) > 26 else c for c in r] for r in data[1:]]
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [('FONT', (0, 0), (-1, -1), 'Helvetica', 7.5), ('FONT', (0, 0), (-1, 0), 'Helvetica-Bold', 7.5),
          ('GRID', (0, 0), (-1, -1), 0.4, colors.black), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
          ('ALIGN', (align_right_from, 1), (-1, -1), 'RIGHT'), ('TOPPADDING', (0, 0), (-1, -1), 2.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5)]
    if bold_last: st += [('FONT', (0, -1), (-1, -1), 'Helvetica-Bold', 7.5)]
    t.setStyle(TableStyle(st)); return t

short = lambda n: (n.replace('DLS Metal Logo - ', 'Metal Logo ').replace('Signature Knit Long-Sleeve - ', 'Sig. Knit LS ')
                    .replace('Signature Knit Long Sleeve - ', 'Sig. Knit LS ').replace('Signature Logo Hoodie - ', 'Sig. Logo Hoodie ')
                    .replace('Pullover Hoodie - Red Airbrush by DLS Concept', 'Red Airbrush Hoodie').replace('DLS X REUDE - ', 'REUDE '))
story = []
story += [Paragraph('Laporan Drop Dust La Stella - 21 November 2026', H1),
          Paragraph(f'Sumber: bot stock monitor (cek tiap 5-10 detik) + counter order Plugo. Rilis 21/11/2026 15:00 WIB. '
                    f'Bot mulai {fmt_t(T0)} WIB (terlambat 12 menit). Data s/d {fmt_t(TEND, True)} WIB. '
                    f'Dibuat {fmt_t(generated, True)} WIB.', P), Spacer(1, 4)]

story += [Paragraph('Ringkasan', H2), table([
    ['Stok awal est. (15:00)', 'Terjual est. (net)', '% terjual', 'Omset est.', 'Order Plugo', 'Omset batas atas'],
    [f"{TOT['init_est']:,}".replace(',', '.'), f"{TOT['sold']:,}".replace(',', '.'), f"{TOT['sold'] / TOT['init_est'] * 100:.1f}%",
     rp(TOT['omset']), f"{TOT['orders_last']:,}".replace(',', '.'), rp(TOT['omset_upper'])]], [30*mm] * 6, align_right_from=0),
    Paragraph(f"Dalam 12 menit pertama (15:00-15:12) sudah {TOT['orders_first']} order masuk, "
              f"{TOT['orders_first'] / TOT['init_est'] * 100:.0f}% dari estimasi stok awal. "
              f"7 produk DLS X REUDE ikut terjadwal 15:00 tapi tidak pernah diisi stok selama dipantau.", SM)]

story += [Paragraph('1. Produk & Stok Awal (estimasi 15:00)', H2), table(
    [['Produk', 'SKU', 'Harga', 'Stok 15:12', 'Order 15:12', 'Stok awal est.']]
    + [[short(s['name']), s['sku'], rp(s['price']), s['stock_first'], s['orders_first'], s['init_est']] for s in sold_rows]
    + [['TOTAL', '', '', TOT['stock_first'], TOT['orders_first'], TOT['init_est']]],
    [58*mm, 38*mm, 22*mm, 18*mm, 20*mm, 24*mm], bold_last=True, align_right_from=2),
    Paragraph('Stok awal est. = stok terlihat 15:12:20 + order Plugo saat itu. Sebelum 15:12 belum ada checkout yang sempat lepas '
              '(pada drop sebelumnya baru lepas 12-22 menit), jadi stok yang hilang = checkout. Asumsi 1 unit per order.', SM)]

story += [Paragraph('2. Output & Estimasi Sales', H2), table(
    [['Produk', 'Stok awal est.', 'Stok akhir', 'Terjual est.', '% terjual', 'Omset est.', 'Order Plugo', 'Batas atas']]
    + [[short(s['name']), s['init_est'], s['stock_last'], s['sold'], f"{s['pct']:.1f}%", rp(s['omset']), s['orders_last'], rp(s['omset_upper'])] for s in sold_rows]
    + [['TOTAL', TOT['init_est'], TOT['stock_last'], TOT['sold'], f"{TOT['sold'] / TOT['init_est'] * 100:.1f}%", rp(TOT['omset']), TOT['orders_last'], rp(TOT['omset_upper'])]],
    [48*mm, 18*mm, 15*mm, 17*mm, 15*mm, 25*mm, 17*mm, 25*mm], bold_last=True),
    Paragraph('Terjual est. = stok awal est. - stok akhir (net). Omset = terjual x harga, sebelum diskon/ongkir. '
              'Order Plugo menghitung semua checkout termasuk yang tidak dibayar, jadi "Batas atas" adalah plafon, bukan angka penjualan.', SM)]

story += [Paragraph('3. Timeline Sold Out', H2), table(
    [['Produk', 'Habis pertama', 'Stok muncul lagi', 'Pertama muncul lagi', 'Puncak stok setelah habis', 'Stok akhir']]
    + [[short(s['name']), ('sebelum 15:12' if s['first_out'] == s['first_t'] else fmt_t(s['first_out'])), f"{len(s['back'])}x",
        fmt_t(s['back'][0]) if s['back'] else '-', s['peak_after'], s['stock_last']] for s in sold_rows],
    [52*mm, 26*mm, 24*mm, 28*mm, 30*mm, 18*mm]),
    Paragraph('Purple dan Red Airbrush sempat "muncul lagi" lalu habis lagi: pola checkout yang tidak dibayar lalu stoknya dilepas. '
              'Black dan Thermal tidak pernah terlihat ada stok selama dipantau. Metal Logo Hoodie tidak pernah habis total dan masih ada stok di akhir periode.', SM)]

ranked = sorted(sold_rows, key=lambda s: -s['sold'])
story += [Paragraph('4. Ranking Produk Paling Laku', H2), table(
    [['#', 'Produk', 'Terjual est.', '% terjual', 'Omset est.', 'Sisa stok']]
    + [[i + 1, short(s['name']), s['sold'], f"{s['pct']:.1f}%", rp(s['omset']), s['stock_last']] for i, s in enumerate(ranked)],
    [8*mm, 62*mm, 22*mm, 20*mm, 30*mm, 20*mm], align_right_from=2)]

story += [Paragraph('5. Penjualan per Periode (unit net / order Plugo)', H2), table(
    [['Periode (WIB)', 'Data hilang'] + [short(meta[p]['name'])[:16] for p in pids] + ['Total unit', 'Total order']]
    + [[period_label(p) + (' *' if p['a'] == RELEASE else ''), f"{round(p['gap'])} mnt" if round(p['gap']) else '-']
       + [f"{p['units'][x]}/{p['orders'][x]}" for x in pids] + [sum(p['units'].values()), sum(p['orders'].values())] for p in periods]
    + [['TOTAL', ''] + [f"{s['sold']}/{s['orders_last']}" for s in sold_rows] + [TOT['sold'], TOT['orders_last']]],
    [37*mm, 15*mm] + [18*mm] * len(pids) + [15*mm, 15*mm], bold_last=True),
    Paragraph('Format sel: unit net / order baru. Angka negatif = stok bertambah (checkout lepas atau restock). '
              '* 15:00-15:12 sebelum bot jalan: dihitung dari order Plugo. Periode dengan "data hilang" hanya diketahui selisih totalnya.', SM)]

story += [Paragraph('6. Pergerakan Stok (gross, selama dipantau)', H2), table(
    [['Produk', 'Total stok turun', 'Total stok naik', 'Stok terendah', 'Waktu terendah']]
    + [[short(s['name']), s['down'], s['up'], s['min_stock'], fmt_t(s['min_t'], True)] for s in sold_rows],
    [60*mm, 28*mm, 28*mm, 24*mm, 30*mm]),
    Paragraph('Stok naik umumnya checkout tidak dibayar yang dilepas. Angka gross bisa lebih kecil dari aktual karena pergerakan saat jeda data '
              'tidak terlihat - karena itu angka terjual memakai selisih net.', SM)]

big_gaps = [g for g in gaps if (g[1] - g[0]).total_seconds() >= 600]
story += [Paragraph('7. Catatan & Kelengkapan Data', H2), table(
    [['Topik', 'Keterangan']] + [[a, Paragraph(b, CELL)] for a, b in [
        ('Metode', 'Estimasi dari stok publik + counter order Plugo, bukan data order toko.'),
        ('Mulai telat', 'Bot mulai 15:12:20; 15:00-15:12 diestimasi dari order Plugo (lihat bagian 1).'),
        ('Jeda data', f'Total {gap_min / 60:.1f} jam tanpa data (laptop tidur / internet putus). Jeda >= 10 menit: '
                      + '; '.join(f"{fmt_t(a, True)}-{fmt_t(b, True)}" for a, b in big_gaps) + '.'),
        ('Dampak jeda', 'Terjual net & order Plugo tetap akurat (pakai titik awal & akhir). Waktu persis dan pergerakan gross saat jeda tidak diketahui.'),
        ('Restock', 'Jika toko menambah stok asli, terjual net jadi lebih kecil dari aktual.'),
        ('Sig. Knit Purple', 'Produk lama; order Plugo-nya bisa termasuk penjualan sebelum drop ini, jadi stok awal & terjual bisa lebih tinggi dari aktual.'),
        ('REUDE', 'DLS X REUDE (7 produk: ' + ', '.join(short(s['name']).replace('REUDE ', '') for s in idle_rows if 'REUDE' in s['name']) +
                  ') stok tidak pernah diisi selama dipantau; order 0.'),
    ]], [30*mm, 150*mm], align_right_from=99)]

SimpleDocTemplate(pdf_path, pagesize=A4, leftMargin=14*mm, rightMargin=14*mm, topMargin=14*mm, bottomMargin=14*mm,
                  title='Laporan Drop Dust La Stella 21 Nov 2026').build(story)

print('OK', T0, TEND, f'gaps {gap_min / 60:.1f}h', TOT)
for s in sold_rows: print(f"  {s['name'][:40]:40} init {s['init_est']:4} last {s['stock_last']:3} sold {s['sold']:4} orders {s['orders_first']}->{s['orders_last']} omset {rp(s['omset'])}")
print(xlsx_path, db_path, pdf_path, sep='\n')
