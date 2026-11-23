'use client';

import { useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, Legend,
} from 'recharts';
import type { Product } from '@/lib/ws-hook';

const PALETTE = ['#C8FF00', '#7DB4FF', '#FF9F1C', '#3DFF8F', '#FF5FA2', '#E8E8E2', '#B48CFF'];

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
};

interface Props { product: Product }

export function StockChart({ product }: Props) {
  const labels = useMemo(
    () => [...new Set(product.variants.map(v => v.label))],
    [product.variants]
  );

  const data = useMemo(() =>
    product.history.map(h => {
      const point: Record<string, number> = { t: Date.parse(h.timestamp) };
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
        MENGUMPULKAN DATA…
      </div>
    );
  }

  return (
    <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            {labels.map((label, i) => (
              <linearGradient key={label} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.25} />
                <stop offset="95%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          <CartesianGrid strokeDasharray="3 3" stroke="#171717" />

          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtTime}
            tick={{ fill: '#7C7C78', fontSize: 9, fontFamily: 'var(--font-jetbrains)' }}
            tickLine={false}
            axisLine={{ stroke: '#1D1D1D' }}
            minTickGap={40}
          />
          <YAxis
            tick={{ fill: '#7C7C78', fontSize: 9, fontFamily: 'var(--font-jetbrains)' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={30}
          />

          <Tooltip
            labelFormatter={(v) => new Date(Number(v)).toLocaleString('en-GB')}
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
              type="stepAfter"
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
