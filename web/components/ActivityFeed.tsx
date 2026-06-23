'use client';

import { useState } from 'react';
import type { Activity, Project } from '@/lib/ws-hook';

interface Props {
  activities: Activity[];
  projects:   Project[];
}

const TYPE_STYLE = {
  restock: { color: '#00FF6A', icon: '▲', label: 'RESTOCK' },
  soldout: { color: '#FF3030', icon: '▼', label: 'SOLD OUT' },
  change:  { color: '#FF9500', icon: '●', label: 'CHANGE'  },
  new:     { color: '#C8FF00', icon: '+', label: 'NEW'     },
};

export function ActivityFeed({ activities, projects }: Props) {
  const [filter, setFilter] = useState<number | null>(null); // null = ALL

  const visible = filter == null
    ? activities
    : activities.filter(a => a.projectId === filter);

  return (
    <div className="rounded-lg border border-[#1E1E1E] bg-[#111111] overflow-hidden sticky top-20">

      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1A1A1A] flex items-center justify-between">
        <span
          className="text-[13px] tracking-widest text-[#888]"
          style={{ fontFamily: 'var(--font-bebas)', letterSpacing: '0.1em' }}
        >
          ACTIVITY
        </span>
        <span className="text-[10px] text-[#333]" style={{ fontFamily: 'var(--font-jetbrains)' }}>
          {visible.length} event{visible.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Project filter tabs */}
      {projects.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-[#141414] overflow-x-auto">
          <button
            onClick={() => setFilter(null)}
            className={`shrink-0 text-[9px] px-2 py-0.5 rounded tracking-widest transition-colors ${
              filter === null
                ? 'bg-[#C8FF00] text-black'
                : 'text-[#444] hover:text-[#888]'
            }`}
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            ALL
          </button>
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => setFilter(f => f === p.id ? null : p.id)}
              className={`shrink-0 text-[9px] px-2 py-0.5 rounded tracking-widest transition-colors ${
                filter === p.id
                  ? 'bg-[#C8FF00] text-black'
                  : 'text-[#444] hover:text-[#888]'
              }`}
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              {p.name.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {/* Events list */}
      <div className="divide-y divide-[#141414] max-h-[calc(100vh-220px)] overflow-y-auto">
        {visible.length === 0 && (
          <div
            className="p-6 text-[11px] text-[#2A2A2A] tracking-widest text-center"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            NO CHANGES YET
          </div>
        )}

        {visible.map(act => (
          <div key={act.id} className="px-4 py-2.5">
            <div className="flex items-center justify-between mb-1">
              <span
                className="text-[10px] text-[#666] truncate max-w-[140px]"
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
                    <span className="text-[10px] tracking-widest" style={{ color: s.color, fontFamily: 'var(--font-jetbrains)' }}>
                      {s.label}
                    </span>
                    <span className="text-[10px] text-white font-bold" style={{ fontFamily: 'var(--font-jetbrains)' }}>
                      {c.label}
                    </span>
                    <span className="text-[10px] text-[#444]" style={{ fontFamily: 'var(--font-jetbrains)' }}>
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
