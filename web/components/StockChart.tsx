'use client';

import { useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, Legend,
} from 'recharts';
import type { Product } from '@/lib/ws-hook';

const PALETTE = ['#C8FF00', '#00FF6A', '#FF9500', '#FF3030', '#00BFFF', '#FF00FF', '#FFFFFF'];

interface Props { product: Product }

export function StockChart({ product }: Props) {
  const labels = useMemo(
    () => [...new Set(product.variants.map(v => v.label))],
    [product.variants]
  );

  const data = useMemo(() =>
    product.history.map(h => {
      const point: Record<string, number | string> = {
        time: new Date(h.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      };
      for (const v of h.variants) point[v.label] = v.stock;
      return point;
    }),
    [product.history]
  );

  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center h-40 text-[#333] text-[11px] tracking-widest"
        style={{ fontFamily: 'var(--font-jetbrains)' }}
      >
        COLLECTING DATA…
      </div>
    );
  }

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <defs>
            {labels.map((label, i) => (
              <linearGradient key={label} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.25} />
                <stop offset="95%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" />

          <XAxis
            dataKey="time"
            tick={{ fill: '#444', fontSize: 9, fontFamily: 'var(--font-jetbrains)' }}
            tickLine={false}
            axisLine={{ stroke: '#1E1E1E' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: '#444', fontSize: 9, fontFamily: 'var(--font-jetbrains)' }}
            tickLine={false}
            axisLine={false}
            width={36}
          />

          <Tooltip
            contentStyle={{
              background: '#111',
              border: '1px solid #222',
              borderRadius: '4px',
              fontSize: '11px',
              fontFamily: 'var(--font-jetbrains)',
              color: '#F0F0F0',
            }}
            labelStyle={{ color: '#C8FF00', marginBottom: 4 }}
            itemStyle={{ padding: '1px 0' }}
          />

          <Legend
            wrapperStyle={{ fontSize: '10px', fontFamily: 'var(--font-jetbrains)', color: '#666', paddingTop: 4 }}
            iconType="circle"
            iconSize={6}
          />

          {labels.map((label, i) => (
            <Area
              key={label}
              type="monotone"
              dataKey={label}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={1.5}
              fill={`url(#grad-${i})`}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
