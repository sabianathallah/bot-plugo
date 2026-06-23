'use client';

import { useState } from 'react';
import type { Product } from '@/lib/ws-hook';
import { StockTable } from './StockTable';
import { StockChart } from './StockChart';

interface Props {
  product: Product;
  onRemove: () => void;
}

const STATUS_MAP = {
  detecting:  { label: 'DETECTING',  color: '#FF9500' },
  monitoring: { label: 'LIVE',       color: '#C8FF00' },
  error:      { label: 'ERROR',      color: '#FF3030' },
};

export function ProductCard({ product, onRemove }: Props) {
  const [tab, setTab]           = useState<'table' | 'chart'>('table');
  const [confirming, setConfirm] = useState(false);
  const status = STATUS_MAP[product.status];

  const host = (() => { try { return new URL(product.productUrl).hostname; } catch { return product.productUrl; } })();

  return (
    <div className="rounded-lg border border-[#1E1E1E] bg-[#111111] overflow-hidden flex flex-col">

      {/* Card header */}
      <div className="px-4 pt-4 pb-3 border-b border-[#1A1A1A]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div
              className="text-[22px] leading-tight text-white truncate"
              style={{ fontFamily: 'var(--font-bebas)', letterSpacing: '0.04em' }}
              title={product.productName}
            >
              {product.productName === product.productUrl ? '…' : product.productName}
            </div>
            <div
              className="text-[11px] text-[#444] mt-0.5 truncate"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
              title={product.productUrl}
            >
              {host}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Status badge */}
            <span
              className="text-[10px] tracking-widest px-2 py-0.5 rounded-sm border"
              style={{
                fontFamily: 'var(--font-jetbrains)',
                color: status.color,
                borderColor: status.color + '44',
                background: status.color + '11',
              }}
            >
              {status.label}
            </span>

            {/* Remove button */}
            {confirming ? (
              <div className="flex gap-1">
                <button
                  onClick={() => { onRemove(); setConfirm(false); }}
                  className="text-[10px] px-2 py-0.5 rounded bg-[#FF3030]/20 text-[#FF3030] border border-[#FF3030]/30 hover:bg-[#FF3030]/30"
                  style={{ fontFamily: 'var(--font-jetbrains)' }}
                >
                  YES
                </button>
                <button
                  onClick={() => setConfirm(false)}
                  className="text-[10px] px-2 py-0.5 rounded bg-[#1E1E1E] text-[#666] border border-[#2A2A2A]"
                  style={{ fontFamily: 'var(--font-jetbrains)' }}
                >
                  NO
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirm(true)}
                className="text-[#2A2A2A] hover:text-[#FF3030] transition-colors text-lg leading-none"
                title="Remove"
              >
                ×
              </button>
            )}
          </div>
        </div>

        {/* Detecting spinner */}
        {product.status === 'detecting' && (
          <div
            className="mt-2 text-[11px] text-[#FF9500] flex items-center gap-2"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            <span className="animate-pulse-dot inline-block w-1.5 h-1.5 rounded-full bg-[#FF9500]" />
            Detecting Plugo API…
          </div>
        )}

        {/* Error message */}
        {product.status === 'error' && (
          <div
            className="mt-2 text-[11px] text-[#FF3030]"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            {product.error}
          </div>
        )}
      </div>

      {/* Tab bar (only when monitoring) */}
      {product.status === 'monitoring' && product.history.length > 1 && (
        <div className="flex border-b border-[#1A1A1A]">
          {(['table', 'chart'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-[11px] tracking-widest transition-colors ${
                tab === t
                  ? 'text-[#C8FF00] border-b-2 border-[#C8FF00] -mb-px'
                  : 'text-[#444] hover:text-[#888]'
              }`}
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 p-4">
        {product.status === 'monitoring' && product.variants.length > 0 && (
          <>
            {tab === 'table' && <StockTable product={product} />}
            {tab === 'chart' && <StockChart product={product} />}
          </>
        )}
      </div>
    </div>
  );
}
