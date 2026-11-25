"""Chambre de la Vain x Tiroceli (CHMB) drop 24/11/2026 19:00 WIB — PDF + Excel report.
Source: data/backup-chambredelavain.com.jsonl (bot first look 19:00:21)
Usage: python3 chmb-report.py <out_dir>
"""
import json, sys, os, sqlite3, datetime as dt
from collections import defaultdict

ROOT = '/Users/mac/Downloads/bot-plugo'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1]
WIB = dt.timezone(dt.timedelta(hours=7))
RELEASE = dt.datetime(2026, 11, 24, 19, 0, tzinfo=WIB)
SKU = {}

def parse(t):
    return dt.datetime.fromisoformat(t).astimezone(WIB).replace(microsecond=0)

# ── Load all observations ────────────────────────────────────────────────────
obs = []  # (t, pid, name, orders, {size: qty}, {size: price})
for line in open(f'{ROOT}/data/backup-chambredelavain.com.jsonl'):
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
def rp(n): return ('-' if n < 0 else '') + 'Rp' + f'{abs(int(round(n))):,}'.replace(',', '.') if n is not None else '-'

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

first_up = None
for pid, rows in tl.items():
    for (ta, _, a), (tb, _, b) in zip(rows, rows[1:]):
        if total(b) > total(a):
            first_up = tb if first_up is None or tb < first_up else first_up
            break
summary.sort(key=lambda s: (-s['omset'], -s['orders_last'], s['name']))
sold_rows = [s for s in summary if s['released']]
idle_rows = [s for s in summary if not s['released']]
changes.sort(key=lambda c: (c['t'], c['name'], c['size']))
order_changes.sort(key=lambda c: (c['t'], c['name']))

# ── Periods ─────────────────────────────────────────────────────────────────
D = lambda d, h, mi=0: dt.datetime(2026, 11, d, h, mi, tzinfo=WIB)
bounds = [RELEASE, T0, D(24, 19, 15), D(24, 19, 30), D(24, 20), D(24, 21), D(24, 22), D(25, 12), TEND]
bounds += [x for g in gaps if (g[1] - g[0]).total_seconds() >= 600 for x in g]
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
    if a == RELEASE: return f"{left} - {b.strftime('%H:%M:%S')}"
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
    s['first_out_label'] = ('sebelum 19:00:21' if s['first_out'] and s['first_out'] == s['first_t']
                            else (fmt_t(s['first_out']) if s['first_out'] else 'tidak habis'))
short = lambda n: ' '.join(n.replace('Collaboration ', '').replace('Tiroceli CHMB - ', '').split())
pids = [s['pid'] for s in sold_rows]
pct_of = lambda a, b: (a / b * 100) if b else 0
ranked = sorted(sold_rows, key=lambda s: -s['sold'])
big_gaps = [g for g in gaps if (g[1] - g[0]).total_seconds() >= 600]

# column = (header, type, pdf width mm). types: txt, int, rp, pct
SECTIONS = []
def section(key, title, cols, rows, total=None, note=None, bold=(), sheet=None):
    SECTIONS.append(dict(key=key, title=title, cols=cols, rows=rows, total=total, note=note, bold=set(bold), sheet=sheet))
T0L = fmt_t(T0)
OUTS = [s for s in sold_rows if s['first_out']]
gap_txt = '; '.join(f"{fmt_t(a, True)} - {fmt_t(b, True)} ({(b - a).total_seconds() / 3600:.1f} jam)" for a, b in big_gaps)
by_order = sorted(sold_rows, key=lambda s: -s['omset'])

section('ringkasan', 'Ringkasan',
    [('Stok awal est.', 'int', 30), ('Terjual est.', 'int', 30), ('% terjual', 'pct', 30),
     ('Estimasi sales', 'rp', 34), ('Sisa stok', 'int', 28), ('Order gagal bayar/batal', 'int', 30)],
    [[TOT['init_est'], TOT['sold'], pct_of(TOT['sold'], TOT['init_est']), TOT['omset'], TOT['stock_last'], TOT['failed']]],
    note=(f"Stok awal est. = stok terbaca {T0L} + {TOT['orders_first']} order Plugo yang sudah ada saat itu. "
          "Gagal bayar / checkout yang stoknya balik tidak dihitung sebagai penjualan. Semua angka dari data yang direkam bot."))

# ── 1. Stok awal per size & terjual
rows, bold = [], []
for s in by_order:
    pid, price = s['pid'], s['price'] or 0
    for k, x in enumerate([x for x in per_size if x['pid'] == pid]):
        net = x['first'] - x['last']
        rows.append([short(s['name']) if k == 0 else '', x['size'], x['first'], x['last'], net, net * price])
    if s['orders_first']:
        rows.append(['', f"+ order sebelum {T0L} (size tidak terbaca)", s['orders_first'], None, s['orders_first'], s['orders_first'] * price])
    if s['pending']:
        rows.append(['', '- belum dibayar (25 mnt terakhir)', None, None, -s['pending'], -s['pending'] * price])
    rows.append([f"Total {short(s['name'])}", '', s['init_est'], s['stock_last'], s['sold'], s['omset']])
    bold.append(len(rows) - 1)
section('size', '1. Stok Awal per Size & Terjual',
    [('Produk', 'txt', 52), ('Size', 'txt', 50), ('Stok awal', 'int', 18), ('Stok akhir', 'int', 18), ('Terjual', 'int', 18), ('Estimasi sales', 'rp', 26)],
    rows, ['TOTAL', '', TOT['init_est'], TOT['stock_last'], TOT['sold'], TOT['omset']], bold=bold,
    note=(f"Stok awal per size = stok terbaca bot {T0L}. Terjual per size = stok awal - stok akhir (net: checkout yang gagal bayar dan stoknya balik tidak terhitung). "
          f"Order Plugo yang sudah ada saat {T0L} hanya tercatat per produk, jadi ukurannya tidak diketahui; ditambahkan di baris tersendiri. Asumsi 1 unit per order."))

# ── 2. Estimasi sales per produk
section('sales', '2. Estimasi Sales per Produk',
    [('#', 'int', 8), ('Produk', 'txt', 60), ('Harga satuan', 'rp', 24), ('Terjual', 'int', 18), ('% terjual', 'pct', 18), ('Estimasi sales', 'rp', 30), ('Sisa stok', 'int', 24)],
    [[i + 1, short(s['name']), s['price'], s['sold'], s['pct'], s['omset'], s['stock_last']] for i, s in enumerate(by_order)],
    [None, 'TOTAL', None, TOT['sold'], pct_of(TOT['sold'], TOT['init_est']), TOT['omset'], TOT['stock_last']],
    note='Estimasi sales = terjual x harga satuan, sebelum diskon/ongkir.')

# ── 3. Pergerakan singkat
period_rows = [[period_label(p), sum(p['units'].values()), sum(p['orders'].values()),
                sum(p['units'][x] * (meta[x]['price'] or 0) for x in pids),
                'jeda data (bot di-pause)' if p['gap'] >= 10 and p['a'] != RELEASE else ('sebelum bacaan pertama bot' if p['a'] == RELEASE else '')] for p in periods]
if TOT['pending']:
    period_rows.append(['Belum dibayar (akhir)', -TOT['pending'], None, -sum(s['pending'] * (s['price'] or 0) for s in sold_rows), 'bisa masih gagal bayar'])
first15 = sum(sum(p['units'].values()) for p in periods if p['b'] <= RELEASE + dt.timedelta(minutes=15))
returns = [p for p in periods if sum(p['units'].values()) < 0]
top = by_order[0]
section('gerak', '3. Pergerakan Singkat',
    [('Periode (WIB)', 'txt', 50), ('Terjual net', 'int', 24), ('Order baru', 'int', 24), ('Estimasi sales', 'rp', 34), ('Catatan', 'txt', 50)],
    period_rows, ['TOTAL', TOT['sold'], TOT['orders_last'], TOT['omset'], ''])
bullets = [
    f"Ramai di awal: {first15} unit keluar di 15 menit pertama (19:00-19:15), sebagian lalu kembali karena gagal bayar (lihat baris berikut).",
    *(f"{period_label(p)}: stok bertambah {-sum(p['units'].values())} unit - checkout yang tidak dibayar dilepas kembali." for p in returns),
    "Setelah 19:30 penjualan pelan: hanya beberapa unit per jam.",
    f"Terlaris: {short(top['name'])} ({top['sold']} unit, {rp(top['omset'])}); persentase tertinggi: "
    + (lambda b: f"{short(b['name'])} ({b['pct']:.0f}% stok terjual).")(max(sold_rows, key=lambda s: s['pct'])),
    ('Tidak ada produk/size yang sold out.' if not OUTS else f"{len(OUTS)} produk sempat habis."),
    f"Total {TOT['up']} unit stok sempat kembali (gagal bayar) selama dipantau; {TOT['failed']} order Plugo tidak berakhir jadi penjualan.",
] + ([f"Jeda data {gap_txt}: monitoring sengaja di-pause malam hari; yang terjual di jeda itu hanya diketahui totalnya."] if big_gaps else []) + [
    f"Data s/d {fmt_t(TEND, True)} WIB (monitoring dihentikan). Dibuat {fmt_t(generated, True)} WIB."]

# ═════════════════════════════════ EXCEL ═════════════════════════════════════
# Same sections as the PDF (same numbers), then the raw data the bot recorded.
from openpyxl import Workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

wb = Workbook(); wb.remove(wb.active)
BOLD = Font(bold=True); THIN = Side(style='thin', color='000000'); BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
GREY = PatternFill('solid', fgColor='EEEEEE')
XL_FMT = {'rp': '"Rp"#,##0;-"Rp"#,##0', 'pct': '0.0%', 'int': '#,##0'}
xl_val = lambda v, t: (v / 100 if (t == 'pct' and isinstance(v, (int, float))) else v)
naive = lambda t: t.replace(tzinfo=None) if t else None

for n, sec in enumerate(SECTIONS):
    ws = wb.create_sheet(f"{n}. {sec['title'].split('. ', 1)[-1]}"[:31])
    ws.cell(row=1, column=1, value=sec['title']).font = Font(bold=True, size=12)
    for j, (h, _, w) in enumerate(sec['cols'], 1):
        c = ws.cell(row=2, column=j, value=h); c.font = BOLD; c.border = BOX; c.alignment = Alignment(wrap_text=True, vertical='center')
        ws.column_dimensions[get_column_letter(j)].width = max(10, w * 0.7)
    body = sec['rows'] + ([sec['total']] if sec['total'] else [])
    for i, r in enumerate(body):
        for j, ((_, t, _), v) in enumerate(zip(sec['cols'], r), 1):
            c = ws.cell(row=3 + i, column=j, value=xl_val(v, t)); c.border = BOX
            if t in XL_FMT and isinstance(v, (int, float)): c.number_format = XL_FMT[t]
            if (sec['total'] and i == len(body) - 1) or i in sec.get('bold', ()): c.font = BOLD
            if i in sec.get('bold', ()): c.fill = GREY
    row = 3 + len(body) + 1
    notes = ([sec['note']] if sec['note'] else []) + (bullets if sec['key'] == 'gerak' else [])
    for note in notes:
        c = ws.cell(row=row, column=1, value=note); c.alignment = Alignment(wrap_text=True, vertical='top')
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=max(len(sec['cols']), 5))
        ws.row_dimensions[row].height = 15 * (1 + len(note) // 110); row += 1
    ws.freeze_panes = 'A3'

def raw_sheet(title, headers, rows, widths, fmts=None):
    ws = wb.create_sheet(title); ws.append(headers)
    for c in ws[1]: c.font = BOLD; c.alignment = Alignment(wrap_text=True)
    for r in rows: ws.append(r)
    for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
    for col, f in (fmts or {}).items():
        for cell in ws[col][1:]: cell.number_format = f
    ws.freeze_panes = 'A2'

TS = {'A': 'dd/mm/yyyy hh:mm:ss'}
raw_sheet('Data - Per Size', ['Produk', 'Size', 'Stok awal (bacaan pertama)', 'Stok tertinggi', 'Stok akhir', 'Total turun', 'Total naik'],
      [[x['name'], x['size'], x['first'], x['max'], x['last'], x['down'], x['up']] for x in per_size], [48, 10, 14, 13, 11, 12, 12])
raw_sheet('Data - Pergerakan Stok', ['Waktu (WIB)', 'Produk', 'Size', 'Stok lama', 'Stok baru', 'Delta', 'Catatan'],
      [[naive(c['t']), c['name'], c['size'], c['old'], c['new'], c['delta'], c['note']] for c in changes], [20, 48, 10, 10, 10, 8, 28], TS)
raw_sheet('Data - Order Plugo', ['Waktu (WIB)', 'Produk', 'Order lama', 'Order baru', 'Delta', 'Catatan'],
      [[naive(c['t']), c['name'], c['old'], c['new'], c['delta'], c['note']] for c in order_changes], [20, 48, 11, 11, 8, 28], TS)
raw_sheet('Data - Jeda', ['Mulai (data terakhir)', 'Selesai (data berikutnya)', 'Durasi (menit)'],
      [[naive(a), naive(b), round((b - a).total_seconds() / 60, 1)] for a, b in gaps], [22, 22, 14], {'A': TS['A'], 'B': TS['A']})
xlsx_path = os.path.join(OUT, 'Data Chambre de la Vain x Tiroceli - Drop 24 Nov 2026.xlsx')
wb.save(xlsx_path)

# ═════════════════════════════════ PDF ═══════════════════════════════════════
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

pdf_path = os.path.join(OUT, 'Laporan Chambre de la Vain x Tiroceli - Drop 24 Nov 2026.pdf')
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
    for i in sec.get('bold', ()): st += [('FONT', (0, i + 1), (-1, i + 1), 'Helvetica-Bold', 7.5), ('BACKGROUND', (0, i + 1), (-1, i + 1), colors.HexColor('#EEEEEE'))]
    t.setStyle(TableStyle(st)); return t

story = [Paragraph('Laporan Drop Chambre de la Vain x Tiroceli (CHMB) - 24 November 2026', H1),
         Paragraph(f'Sumber: bot stock monitor (cek tiap 5-10 detik) + counter order Plugo. Rilis 24/11/2026 19:00 WIB. '
                   f'Bacaan pertama bot {fmt_t(T0)} WIB. Data s/d {fmt_t(TEND, True)} WIB. '
                   f'Dibuat {fmt_t(generated, True)} WIB.', P), Spacer(1, 4)]
for sec in SECTIONS:
    story += [Paragraph(sec['title'], H2), pdf_table(sec)]
    if sec['note']: story += [Spacer(1, 2), Paragraph(sec['note'], SM)]
story += [Spacer(1, 4)] + [Paragraph('&bull; ' + b, P) for b in bullets]

SimpleDocTemplate(pdf_path, pagesize=A4, leftMargin=14*mm, rightMargin=14*mm, topMargin=14*mm, bottomMargin=14*mm,
                  title='Laporan Drop Chambre de la Vain x Tiroceli 24 Nov 2026').build(story)

print('OK', T0, TEND, f'gaps {gap_min / 60:.1f}h', TOT)
for s in sold_rows: print(f"  {s['name'][:40]:40} init {s['init_est']:4} last {s['stock_last']:3} sold {s['sold']:4} orders {s['orders_first']}->{s['orders_last']} omset {rp(s['omset'])}")
print(xlsx_path, pdf_path, sep='\n')
