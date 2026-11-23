'use client';

import { useEffect, useRef, useState } from 'react';
import type { Product } from '@/lib/ws-hook';
import { rupiah, rupiahShort } from '@/lib/format';

export type Totals = {
  omset: number; sold: number; pending: number; out: number; released: number; restocked: number;
  orders: number; ordersDelta: number; hasOrders: boolean; unpriced: boolean;
};

export function sumStats(products: Product[]): Totals {
  const t: Totals = { omset: 0, sold: 0, pending: 0, out: 0, released: 0, restocked: 0, orders: 0, ordersDelta: 0, hasOrders: false, unpriced: false };
  for (const p of products) {
    const s = p.stats;
    if (!s) continue;
    t.omset += s.omset; t.sold += s.sold; t.pending += s.pending; t.out += s.out;
    t.released += s.released; t.restocked += s.restocked;
    if (!s.priced) t.unpriced = true;
    if (s.numOrders != null) {
      t.hasOrders = true;
      t.orders += s.numOrders;
      t.ordersDelta += s.numOrders - (s.numOrdersFirst ?? s.numOrders);
    }
  }
  return t;
}

/** Number that glows briefly whenever its value changes */
export function Ticking({ value, className, style }: { value: string; className?: string; style?: React.CSSProperties }) {
  const [k, setK] = useState(0);
  const prev = useRef(value);
  useEffect(() => { if (prev.current !== value) { prev.current = value; setK(x => x + 1); } }, [value]);
  return <span key={k} className={`${k ? 'tick' : ''} ${className ?? ''}`} style={style}>{value}</span>;
}

function Cell({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div className="px-4 py-3 bg-[var(--panel)] min-w-0" title={hint}>
      <div className="lbl truncate">{label}</div>
      <Ticking value={value} className="display tnum block text-[26px] leading-none mt-1.5" style={{ color: color ?? 'var(--ink)' }} />
    </div>
  );
}

export function SalesBand({ products }: { products: Product[] }) {
  const t = sumStats(products);
  const ranked = products
    .filter(p => (p.stats?.sold ?? 0) > 0 || (p.stats?.numOrders ?? 0) > 0)
    .sort((a, b) => (b.stats?.omset ?? 0) - (a.stats?.omset ?? 0) || (b.stats?.numOrders ?? 0) - (a.stats?.numOrders ?? 0))
    .slice(0, 5);
  const maxOmset = Math.max(1, ...ranked.map(p => p.stats?.omset ?? 0));

  return (
    <div className="border-b border-[var(--line)] bg-[var(--panel)]">
      <div className="grid lg:grid-cols-[minmax(260px,1.1fr)_2fr]">

        {/* Hero: omset */}
        <div className="relative px-5 py-5 grid-hair overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-[var(--panel)] via-[var(--panel)]/80 to-transparent" />
          <div className="relative">
            <div className="flex items-center gap-2">
              <span className="lbl" style={{ color: 'var(--signal)' }}>Omset estimasi</span>
              <MethodNote />
            </div>
            <Ticking
              value={t.unpriced && t.omset === 0 ? '—' : rupiah(t.omset)}
              className="display tnum block text-[46px] sm:text-[56px] leading-[0.9] mt-2 text-[var(--ink)]"
            />
            <div className="mono text-[11px] text-[var(--ink-2)] mt-2">
              {t.sold.toLocaleString('id-ID')} unit terjual
              {t.pending > 0 && <span className="text-[var(--down)]"> · {t.pending} masih di-hold</span>}
              {t.unpriced && <span className="text-[var(--muted)]"> · sebagian harga belum terbaca</span>}
            </div>
          </div>
        </div>

        {/* Movement cells */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-px bg-[var(--line)] border-t lg:border-t-0 lg:border-l border-[var(--line)]">
          <Cell label="Terjual" value={t.sold.toLocaleString('id-ID')} color="var(--signal)" hint="Checkout yang tidak kembali ke stok" />
          <Cell label="Pending" value={t.pending.toLocaleString('id-ID')} color="var(--down)" hint="Checkout < 25 menit — bisa masih lepas" />
          <Cell label="Checkout ▼" value={t.out.toLocaleString('id-ID')} color="var(--down)" hint="Total unit stok turun" />
          <Cell label="Balik ▲" value={t.released.toLocaleString('id-ID')} color="var(--up)" hint="Checkout tidak dibayar yang lepas lagi" />
          <Cell label="Restock" value={t.restocked.toLocaleString('id-ID')} color="var(--ink-2)" hint="Kenaikan stok di luar jendela checkout" />
          <Cell
            label="Order Plugo"
            value={t.hasOrders ? `${t.orders.toLocaleString('id-ID')}` : '—'}
            color="var(--order)"
            hint={t.hasOrders ? `+${t.ordersDelta} sejak dipantau · termasuk checkout yang tidak dibayar` : 'Belum terbaca'}
          />
        </div>
      </div>

      {/* Leaderboard */}
      {ranked.length > 0 && (
        <div className="border-t border-[var(--line)] px-5 py-3 grid gap-1.5">
          {ranked.map((p, i) => {
            const s = p.stats!;
            const w = Math.max(2, (s.omset / maxOmset) * 100);
            return (
              <div key={p.productUrl} className="grid grid-cols-[18px_minmax(0,1fr)_auto] sm:grid-cols-[18px_minmax(0,220px)_1fr_auto] items-center gap-3">
                <span className="mono text-[10px] text-[var(--faint)] tnum">{String(i + 1).padStart(2, '0')}</span>
                <span className="mono text-[11px] text-[var(--ink-2)] truncate" title={p.productName}>{p.productName}</span>
                <div className="hidden sm:block h-[6px] bg-[var(--panel-2)] rounded-sm overflow-hidden">
                  <div className="h-full rounded-sm transition-[width] duration-700" style={{ width: `${w}%`, background: 'linear-gradient(90deg, rgba(200,255,0,.35), var(--signal))' }} />
                </div>
                <span className="mono text-[11px] tnum text-right whitespace-nowrap">
                  <span className="text-[var(--ink)]">{s.priced ? rupiahShort(s.omset) : '—'}</span>
                  <span className="text-[var(--muted)]"> · {s.sold}u</span>
                  {s.numOrders != null && <span className="text-[var(--order)]"> · {s.numOrders} ord</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MethodNote() {
  return (
    <details className="relative group">
      <summary className="list-none cursor-pointer mono text-[10px] w-4 h-4 grid place-items-center rounded-full border border-[var(--line-2)] text-[var(--muted)] hover:text-[var(--ink)] hover:border-[var(--muted)]">?</summary>
      <div className="absolute z-30 left-0 top-6 w-[300px] p-3 rounded-md border border-[var(--line-2)] bg-[#101010] shadow-2xl mono text-[11px] leading-relaxed text-[var(--ink-2)]">
        Estimasi dari pergerakan stok, bukan data order toko.<br />
        <span className="text-[var(--down)]">▼ Stok turun</span> = checkout (di-hold).<br />
        <span className="text-[var(--up)]">▲ Naik ≤25 mnt</span> setelah hold = checkout tak dibayar lepas.<br />
        Naik di luar itu = restock.<br />
        <span className="text-[var(--signal)]">Terjual</span> = hold yang tidak balik. Omset = terjual × harga size.<br />
        <span className="text-[var(--muted)]">Penjualan sebelum bot mulai memantau dan saat koneksi putus tidak terhitung. Order Plugo menghitung semua checkout termasuk yang batal — pakai sebagai batas atas.</span>
      </div>
    </details>
  );
}
