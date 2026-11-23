'use client';

import { useState } from 'react';
import type { Product } from '@/lib/ws-hook';
import { StockTable } from './StockTable';
import { StockChart } from './StockChart';
import { rupiah, rupiahShort, usePersistentState } from '@/lib/format';
import { Ticking } from './SalesBand';

interface Props {
  product: Product;
  onRemove: () => void;
  index?: number;
}

const STATUS_MAP = {
  detecting:  { label: 'DETECTING', color: 'var(--down)' },
  monitoring: { label: 'LIVE',      color: 'var(--signal)' },
  error:      { label: 'ERROR',     color: 'var(--out)' },
  paused:     { label: 'PAUSED',    color: 'var(--muted)' },
};

type Tab = 'stok' | 'grafik' | 'penjualan';

export function ProductCard({ product, onRemove, index = 0 }: Props) {
  const [tab, setTab]            = usePersistentState<Tab>(`pm:tab:${product.productUrl}`, 'stok');
  const [confirming, setConfirm] = useState(false);
  const status = STATUS_MAP[product.status] ?? STATUS_MAP.detecting;
  const s = product.stats;
  const ready = (product.status === 'monitoring' || product.status === 'paused') && product.variants.length > 0;
  const totalStock = product.variants.reduce((a, v) => a + v.stock, 0);
  const price = s?.price ?? product.variants.find(v => v.price != null)?.price ?? null;
  const productId = (product.productUrl.match(/\/products\/(\d+)/) ?? [])[1];

  return (
    <article
      className="rise rounded-md border border-[var(--line)] bg-[var(--panel)] overflow-hidden flex flex-col hover:border-[var(--line-2)] transition-colors"
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      {/* Header */}
      <header className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <a
              href={product.productUrl}
              target="_blank"
              rel="noreferrer"
              className="display block text-[21px] leading-[1.05] text-[var(--ink)] hover:text-[var(--signal)] transition-colors line-clamp-2"
              title={product.productName}
            >
              {product.productName === product.productUrl ? '…' : product.productName}
            </a>
            <div className="mono text-[10.5px] text-[var(--muted)] mt-1 flex gap-2 flex-wrap">
              {productId && <span>#{productId}</span>}
              {price != null && <span className="text-[var(--ink-2)]">{rupiah(price)}</span>}
              {ready && <span>stok {totalStock}</span>}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className="mono text-[9.5px] tracking-[0.14em] px-1.5 py-0.5 rounded-sm border flex items-center gap-1"
              style={{ color: status.color, borderColor: `color-mix(in srgb, ${status.color} 35%, transparent)` }}
            >
              {product.status === 'monitoring' && <span className="w-1 h-1 rounded-full animate-pulse-dot" style={{ background: status.color }} />}
              {status.label}
            </span>
            {confirming ? (
              <span className="flex gap-1">
                <button onClick={() => { onRemove(); setConfirm(false); }} className="mono text-[10px] px-1.5 py-0.5 rounded-sm text-[var(--out)] border border-[var(--out)]/40 hover:bg-[var(--out)]/15">HAPUS</button>
                <button onClick={() => setConfirm(false)} className="mono text-[10px] px-1.5 py-0.5 rounded-sm text-[var(--muted)] border border-[var(--line-2)]">BATAL</button>
              </span>
            ) : (
              <button onClick={() => setConfirm(true)} className="text-[var(--faint)] hover:text-[var(--out)] transition-colors text-lg leading-none" title="Hapus produk" aria-label="Hapus produk">×</button>
            )}
          </div>
        </div>

        {/* Sales strip */}
        {s && (s.out > 0 || s.numOrders != null) && (
          <div className="mt-3 grid grid-cols-3 gap-px bg-[var(--line)] rounded-sm overflow-hidden">
            <Mini label="Terjual" value={`${s.sold}${s.pending ? ` +${s.pending}` : ''}`} color="var(--signal)" hint={s.pending ? `${s.pending} unit masih di-hold (<25 mnt)` : undefined} />
            <Mini label="Omset est." value={s.priced ? rupiahShort(s.omset) : '—'} color="var(--ink)" />
            <Mini
              label="Order"
              value={s.numOrders != null ? String(s.numOrders) : '—'}
              color="var(--order)"
              hint={s.numOrders != null ? `+${s.numOrders - (s.numOrdersFirst ?? s.numOrders)} sejak dipantau` : undefined}
            />
          </div>
        )}

        {product.status === 'detecting' && (
          <div className="mono mt-2 text-[11px] text-[var(--down)] flex items-center gap-2">
            <span className="animate-pulse-dot inline-block w-1.5 h-1.5 rounded-full bg-[var(--down)]" />
            Membaca data Plugo…
          </div>
        )}
        {product.status === 'error' && (
          <div className="mono mt-2 text-[11px] text-[var(--out)] break-words">{product.error}</div>
        )}
      </header>

      {ready && (
        <>
          <nav className="flex border-y border-[var(--line)]" role="tablist">
            {(['stok', 'grafik', 'penjualan'] as const).map(t => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 mono text-[10.5px] tracking-[0.14em] uppercase transition-colors ${
                  tab === t ? 'text-[var(--signal)] bg-[var(--panel-2)] shadow-[inset_0_-2px_0_var(--signal)]' : 'text-[var(--muted)] hover:text-[var(--ink-2)]'
                }`}
              >
                {t}
              </button>
            ))}
          </nav>
          <div className="flex-1 p-4">
            {tab === 'stok'      && <StockTable product={product} />}
            {tab === 'grafik'    && <StockChart product={product} />}
            {tab === 'penjualan' && <SalesTable product={product} />}
          </div>
        </>
      )}
    </article>
  );
}

function Mini({ label, value, color, hint }: { label: string; value: string; color: string; hint?: string }) {
  return (
    <div className="bg-[var(--panel-2)] px-2.5 py-2 min-w-0" title={hint}>
      <div className="lbl text-[9px]">{label}</div>
      <Ticking value={value} className="display tnum block text-[19px] leading-none mt-1 truncate" style={{ color }} />
    </div>
  );
}

function SalesTable({ product }: { product: Product }) {
  const s = product.stats;
  if (!s || s.perVariant.length === 0) {
    return <div className="mono text-[11px] text-[var(--muted)] py-8 text-center tracking-widest">BELUM ADA PERGERAKAN STOK</div>;
  }
  const rows = [...s.perVariant].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  const head = ['Size', 'Chk ▼', 'Balik ▲', 'Restock', 'Terjual', 'Omset'];
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full mono text-[12px] tnum">
        <thead>
          <tr>{head.map((h, i) => <th key={h} className={`lbl text-[9px] pb-2 px-1 ${i ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(v => (
            <tr key={v.label} className="border-t border-[var(--line)]">
              <td className="py-2 px-1 font-bold text-[var(--ink)]">{v.label}</td>
              <td className="py-2 px-1 text-right text-[var(--down)]">{v.out}</td>
              <td className="py-2 px-1 text-right text-[var(--up)]">{v.released}</td>
              <td className="py-2 px-1 text-right text-[var(--ink-2)]">{v.restocked}</td>
              <td className="py-2 px-1 text-right text-[var(--signal)]">{v.sold}{v.pending ? <span className="text-[var(--down)]"> +{v.pending}</span> : null}</td>
              <td className="py-2 px-1 text-right text-[var(--ink)] whitespace-nowrap">{v.price == null ? '—' : rupiahShort(v.sold * v.price)}</td>
            </tr>
          ))}
          <tr className="border-t border-[var(--line-2)]">
            <td className="py-2 px-1 lbl">Total</td>
            <td className="py-2 px-1 text-right text-[var(--down)]">{s.out}</td>
            <td className="py-2 px-1 text-right text-[var(--up)]">{s.released}</td>
            <td className="py-2 px-1 text-right text-[var(--ink-2)]">{s.restocked}</td>
            <td className="py-2 px-1 text-right text-[var(--signal)] font-bold">{s.sold}</td>
            <td className="py-2 px-1 text-right text-[var(--ink)] font-bold whitespace-nowrap">{rupiahShort(s.omset)}</td>
          </tr>
        </tbody>
      </table>
      {s.numOrders != null && (
        <p className="mono text-[10.5px] text-[var(--muted)] mt-3 leading-relaxed">
          Order Plugo: <span className="text-[var(--order)]">{s.numOrders}</span>
          {s.numOrdersFirst != null && <> (awal dipantau {s.numOrdersFirst}, +{s.numOrders - s.numOrdersFirst})</>}
          {' '}· termasuk checkout yang tidak dibayar.
        </p>
      )}
    </div>
  );
}
