'use client';

import type { Activity } from '@/lib/ws-hook';

interface Props { activities: Activity[] }

const TYPE_STYLE = {
  restock: { color: '#00FF6A', icon: '▲', label: 'RESTOCK' },
  soldout: { color: '#FF3030', icon: '▼', label: 'SOLD OUT' },
  change:  { color: '#FF9500', icon: '●', label: 'CHANGE' },
  new:     { color: '#C8FF00', icon: '+', label: 'NEW' },
};

export function ActivityFeed({ activities }: Props) {
  return (
    <div className="rounded-lg border border-[#1E1E1E] bg-[#111111] overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1A1A1A] flex items-center justify-between">
        <span
          className="text-[13px] tracking-widest text-[#888]"
          style={{ fontFamily: 'var(--font-bebas)', letterSpacing: '0.1em' }}
        >
          ACTIVITY
        </span>
        <span
          className="text-[10px] text-[#333]"
          style={{ fontFamily: 'var(--font-jetbrains)' }}
        >
          {activities.length} event{activities.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="divide-y divide-[#141414] max-h-[420px] overflow-y-auto">
        {activities.length === 0 && (
          <div
            className="p-4 text-[11px] text-[#333] tracking-widest text-center"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            NO CHANGES YET
          </div>
        )}

        {activities.map(act => (
          <div key={act.id} className="px-4 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span
                className="text-[10px] text-[#888] truncate max-w-[140px]"
                style={{ fontFamily: 'var(--font-jetbrains)' }}
                title={act.productName}
              >
                {act.productName}
              </span>
              <span
                className="text-[10px] text-[#333] shrink-0 ml-2 tabular-nums"
                style={{ fontFamily: 'var(--font-jetbrains)' }}
              >
                {new Date(act.timestamp).toLocaleTimeString('en-GB')}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {act.changes.map((c, i) => {
                const s = TYPE_STYLE[c.type] ?? TYPE_STYLE.change;
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-[10px] w-3" style={{ color: s.color, fontFamily: 'var(--font-jetbrains)' }}>
                      {s.icon}
                    </span>
                    <span
                      className="text-[10px] tracking-widest"
                      style={{ color: s.color, fontFamily: 'var(--font-jetbrains)' }}
                    >
                      {s.label}
                    </span>
                    <span
                      className="text-[10px] text-white font-bold"
                      style={{ fontFamily: 'var(--font-jetbrains)' }}
                    >
                      {c.label}
                    </span>
                    <span
                      className="text-[10px] text-[#444]"
                      style={{ fontFamily: 'var(--font-jetbrains)' }}
                    >
                      {c.oldStock !== null ? `${c.oldStock} → ${c.newStock}` : c.newStock}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
