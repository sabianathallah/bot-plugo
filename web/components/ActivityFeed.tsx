'use client';

import type { Activity, Change, Project } from '@/lib/ws-hook';
import { rupiahShort, timeLabel, usePersistentState } from '@/lib/format';

interface Props {
  activities: Activity[];
  projects:   Project[];
}

type Kind = 'all' | 'down' | 'up' | 'order';

const KINDS: { id: Kind; label: string; color: string }[] = [
  { id: 'all',   label: 'Semua',    color: 'var(--ink)' },
  { id: 'down',  label: '▼ Keluar', color: 'var(--down)' },
  { id: 'up',    label: '▲ Balik',  color: 'var(--up)' },
  { id: 'order', label: '◆ Order',  color: 'var(--order)' },
];

function kindOf(c: Change): Exclude<Kind, 'all'> | null {
  if (c.type === 'order') return 'order';
  if (c.oldStock == null) return null;
  return c.newStock < c.oldStock ? 'down' : c.newStock > c.oldStock ? 'up' : null;
}

function describe(c: Change) {
  if (c.type === 'order') {
    const d = c.newStock - (c.oldStock ?? c.newStock);
    return { icon: '◆', color: 'var(--order)', tag: 'ORDER', delta: `+${d}`, detail: `${c.oldStock} → ${c.newStock}`, value: null as string | null };
  }
  if (c.oldStock == null) {
    return { icon: '+', color: 'var(--signal)', tag: 'BARU', delta: '', detail: String(c.newStock), value: null };
  }
  const d = c.newStock - c.oldStock;
  const value = c.price != null ? rupiahShort(Math.abs(d) * c.price) : null;
  if (d < 0) {
    return {
      icon: '▼', color: c.newStock === 0 ? 'var(--out)' : 'var(--down)',
      tag: c.newStock === 0 ? 'HABIS' : 'KELUAR', delta: String(d), detail: `${c.oldStock} → ${c.newStock}`, value,
    };
  }
  return {
    icon: '▲', color: 'var(--up)', tag: c.oldStock === 0 ? 'MUNCUL' : 'BALIK',
    delta: `+${d}`, detail: `${c.oldStock} → ${c.newStock}`, value,
  };
}

const dayKey = (iso: string) => new Date(iso).toDateString();
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hari ini';
  if (d.toDateString() === y.toDateString()) return 'Kemarin';
  return d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' });
};

export function ActivityFeed({ activities, projects }: Props) {
  const [projectFilter, setProjectFilter] = usePersistentState<number | null>('pm:feed:project', null);
  const [kind, setKind]                   = usePersistentState<Kind>('pm:feed:kind', 'all');

  const visible = activities
    .filter(a => projectFilter == null || a.projectId === projectFilter)
    .map(a => ({ ...a, changes: kind === 'all' ? a.changes : a.changes.filter(c => kindOf(c) === kind) }))
    .filter(a => a.changes.length > 0);

  let lastDay = '';

  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--panel)] overflow-hidden lg:sticky lg:top-[72px]">
      <header className="px-4 py-3 border-b border-[var(--line)] flex items-center justify-between">
        <h2 className="display text-[18px] tracking-[0.08em] text-[var(--ink)]">Activity</h2>
        <span className="mono text-[10px] text-[var(--muted)] tnum">{visible.length} event · tersimpan</span>
      </header>

      <div className="px-3 py-2 border-b border-[var(--line)] flex flex-col gap-2">
        {projects.length > 1 && (
          <div className="flex gap-1 overflow-x-auto">
            <Chip active={projectFilter === null} onClick={() => setProjectFilter(null)}>Semua</Chip>
            {projects.map(p => (
              <Chip key={p.id} active={projectFilter === p.id} onClick={() => setProjectFilter(f => (f === p.id ? null : p.id))}>
                {p.name}
              </Chip>
            ))}
          </div>
        )}
        <div className="flex gap-1 overflow-x-auto">
          {KINDS.map(k => (
            <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)} color={k.color}>{k.label}</Chip>
          ))}
        </div>
      </div>

      <ol className="max-h-[calc(100dvh-240px)] min-h-[200px] overflow-y-auto">
        {visible.length === 0 && (
          <li className="mono p-8 text-[11px] text-[var(--faint)] tracking-[0.2em] text-center">BELUM ADA PERGERAKAN</li>
        )}

        {visible.map(act => {
          const showDay = dayKey(act.timestamp) !== lastDay;
          lastDay = dayKey(act.timestamp);
          return (
            <li key={act.id}>
              {showDay && (
                <div className="sticky top-0 z-10 px-4 py-1.5 bg-[#0B0B0B]/95 backdrop-blur border-b border-[var(--line)] lbl text-[9px]">
                  {dayLabel(act.timestamp)}
                </div>
              )}
              <div className="px-4 py-2.5 border-b border-[#141414] hover:bg-[var(--panel-2)] transition-colors">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span className="mono text-[10.5px] text-[var(--ink-2)] truncate" title={act.productName}>{act.productName}</span>
                  <span className="mono text-[10px] text-[var(--muted)] tnum shrink-0">{timeLabel(act.timestamp).split(' ').pop()}</span>
                </div>
                <div className="grid gap-0.5">
                  {act.changes.map((c, i) => {
                    const d = describe(c);
                    return (
                      <div key={i} className="mono text-[10.5px] grid grid-cols-[12px_54px_minmax(28px,auto)_1fr_auto] items-baseline gap-1.5 tnum">
                        <span style={{ color: d.color }}>{d.icon}</span>
                        <span className="tracking-[0.1em] text-[9.5px]" style={{ color: d.color }}>{d.tag}</span>
                        <span className="font-bold text-[var(--ink)] truncate">{c.type === 'order' ? '' : c.label}</span>
                        <span className="text-[var(--muted)] truncate">{d.detail}</span>
                        <span className="text-right whitespace-nowrap">
                          <span style={{ color: d.color }}>{d.delta}</span>
                          {d.value && <span className="text-[var(--muted)]"> · {d.value}</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Chip({ active, onClick, children, color }: { active: boolean; onClick: () => void; children: React.ReactNode; color?: string }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 mono text-[9.5px] px-2 py-1 rounded-sm tracking-[0.1em] uppercase border transition-colors ${
        active ? 'border-transparent text-black' : 'border-[var(--line-2)] text-[var(--muted)] hover:text-[var(--ink)]'
      }`}
      style={active ? { background: color ?? 'var(--signal)' } : undefined}
    >
      {children}
    </button>
  );
}
