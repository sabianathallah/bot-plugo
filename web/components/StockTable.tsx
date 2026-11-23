'use client';

import { useEffect, useRef, useState } from 'react';
import type { Product, Variant } from '@/lib/ws-hook';

interface Props { product: Product }

function stockStatus(s: number): { label: string; color: string } {
  if (s === 0) return { label: 'HABIS',    color: 'var(--out)' };
  if (s <= 3)  return { label: 'MENIPIS',  color: 'var(--down)' };
  return            { label: 'TERSEDIA', color: 'var(--signal)' };
}

type FlashMap = Record<string, 'restock' | 'soldout' | 'change'>;

const FLASH_CLASS: Record<string, string> = {
  restock: 'animate-flash-green',
  soldout: 'animate-flash-red',
  change:  'animate-flash-amber',
};

export function StockTable({ product }: Props) {
  const prevRef               = useRef<Variant[]>(product.variants);
  const [flashMap, setFlash]  = useState<FlashMap>({});

  useEffect(() => {
    const prev    = prevRef.current;
    const prevMap = new Map(prev.map(v => [v.label, v.stock]));
    const next: FlashMap = {};

    for (const v of product.variants) {
      const old = prevMap.get(v.label);
      if (old !== undefined && old !== v.stock) {
        next[v.label] = v.stock === 0 ? 'soldout' : old === 0 ? 'restock' : 'change';
      }
    }

    if (Object.keys(next).length > 0) {
      setFlash(next);
      const t = setTimeout(() => setFlash({}), 1400);
      return () => clearTimeout(t);
    }

    prevRef.current = product.variants;
  }, [product.variants]);

  useEffect(() => { prevRef.current = product.variants; });

  const total    = product.variants.reduce((s, v) => s + v.stock, 0);
  const outCount = product.variants.filter(v => v.stock === 0).length;
  // Scale bars against the highest stock this product has shown in its history
  const peak = Math.max(1, ...product.history.flatMap(h => h.variants.map(v => v.stock)), ...product.variants.map(v => v.stock));

  return (
    <div>
      <div className="flex items-end gap-5 mb-3">
        <Stat label="Total stok" value={total.toLocaleString('id-ID')} color="var(--ink)" />
        <Stat label="Size habis" value={`${outCount}/${product.variants.length}`} color={outCount ? 'var(--out)' : 'var(--ink-2)'} />
      </div>

      <div className="grid gap-1">
        {product.variants.map(v => {
          const { label, color } = stockStatus(v.stock);
          const flash = flashMap[v.label];
          const w = v.stock === 0 ? 0 : Math.max(3, (v.stock / peak) * 100);
          return (
            <div
              key={v.label}
              className={`grid grid-cols-[minmax(44px,auto)_36px_1fr_auto] items-center gap-3 px-2 py-1.5 rounded-sm ${flash ? FLASH_CLASS[flash] : ''}`}
            >
              <span className="mono text-[12.5px] font-bold text-[var(--ink)] truncate" title={v.label}>{v.label}</span>
              <span className="mono text-[13px] tnum text-right" style={{ color }}>{v.stock}</span>
              <span className="h-[5px] bg-[var(--panel-2)] rounded-sm overflow-hidden">
                <span className="block h-full rounded-sm transition-[width] duration-500" style={{ width: `${w}%`, background: color }} />
              </span>
              <span className="mono text-[9.5px] tracking-[0.12em] w-[74px] text-right" style={{ color }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="lbl text-[9px]">{label}</div>
      <div className="display tnum text-[24px] leading-none mt-1" style={{ color }}>{value}</div>
    </div>
  );
}
