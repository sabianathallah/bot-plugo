'use client';

import { useEffect, useRef, useState } from 'react';
import type { Product, Variant } from '@/lib/ws-hook';

interface Props { product: Product }

function stockStatus(s: number): { label: string; color: string } {
  if (s === 0) return { label: 'OUT OF STOCK', color: '#FF3030' };
  if (s <= 3)  return { label: `LOW  ·  ${s}`, color: '#FF9500' };
  return            { label: 'IN STOCK',       color: '#00FF6A' };
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

  const total = product.variants.reduce((s, v) => s + v.stock, 0);
  const outCount = product.variants.filter(v => v.stock === 0).length;

  return (
    <div>
      {/* Summary row */}
      <div className="flex gap-4 mb-3">
        <div>
          <div className="text-[10px] text-[#444] tracking-widest" style={{ fontFamily: 'var(--font-jetbrains)' }}>TOTAL STOCK</div>
          <div className="text-[22px] text-white leading-tight" style={{ fontFamily: 'var(--font-bebas)' }}>{total.toLocaleString()}</div>
        </div>
        {outCount > 0 && (
          <div>
            <div className="text-[10px] text-[#444] tracking-widest" style={{ fontFamily: 'var(--font-jetbrains)' }}>SOLD OUT</div>
            <div className="text-[22px] text-[#FF3030] leading-tight" style={{ fontFamily: 'var(--font-bebas)' }}>{outCount}</div>
          </div>
        )}
        <div>
          <div className="text-[10px] text-[#444] tracking-widest" style={{ fontFamily: 'var(--font-jetbrains)' }}>SIZES</div>
          <div className="text-[22px] text-[#888] leading-tight" style={{ fontFamily: 'var(--font-bebas)' }}>{product.variants.length}</div>
        </div>
      </div>

      {/* Table */}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[#1A1A1A]">
            {['SIZE', 'STOCK', 'STATUS'].map(h => (
              <th
                key={h}
                className="pb-2 text-left text-[10px] tracking-widest text-[#333]"
                style={{ fontFamily: 'var(--font-jetbrains)' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {product.variants.map(v => {
            const { label, color } = stockStatus(v.stock);
            const flash = flashMap[v.label];
            return (
              <tr
                key={v.label}
                className={`border-b border-[#141414] last:border-0 ${flash ? FLASH_CLASS[flash] : ''}`}
              >
                <td className="py-2.5 pr-4">
                  <span
                    className="text-sm font-bold text-white"
                    style={{ fontFamily: 'var(--font-jetbrains)' }}
                  >
                    {v.label}
                  </span>
                </td>
                <td className="py-2.5 pr-4">
                  <span
                    className="text-sm tabular-nums"
                    style={{ fontFamily: 'var(--font-jetbrains)', color: v.stock === 0 ? '#FF3030' : v.stock <= 3 ? '#FF9500' : '#C8FF00' }}
                  >
                    {v.stock}
                  </span>
                </td>
                <td className="py-2.5">
                  <span
                    className="text-[10px] tracking-wider"
                    style={{ fontFamily: 'var(--font-jetbrains)', color }}
                  >
                    {label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
