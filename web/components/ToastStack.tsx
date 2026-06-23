'use client';

import type { Toast } from '@/lib/ws-hook';

interface Props {
  toasts:    Toast[];
  onDismiss: (id: string) => void;
}

const KIND_STYLE: Record<string, { border: string; accent: string; icon: string }> = {
  restock: { border: '#00FF6A33', accent: '#00FF6A', icon: '▲' },
  soldout: { border: '#FF303033', accent: '#FF3030', icon: '▼' },
  info:    { border: '#C8FF0033', accent: '#C8FF00', icon: '●' },
  error:   { border: '#FF303033', accent: '#FF3030', icon: '!' },
};

export function ToastStack({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72 pointer-events-none">
      {toasts.map(t => {
        const s = KIND_STYLE[t.kind] ?? KIND_STYLE.info;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto ${t.exiting ? 'animate-fade-out' : 'animate-slide-in'}`}
          >
            <div
              className="rounded border bg-[#0E0E0E] px-3 py-2.5 shadow-xl flex items-start gap-2.5"
              style={{ borderColor: s.border }}
            >
              <span
                className="text-sm leading-none mt-0.5 shrink-0"
                style={{ color: s.accent, fontFamily: 'var(--font-jetbrains)' }}
              >
                {s.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div
                  className="text-[10px] tracking-widest font-bold mb-0.5"
                  style={{ color: s.accent, fontFamily: 'var(--font-jetbrains)' }}
                >
                  {t.title}
                </div>
                <div
                  className="text-[11px] text-[#888] truncate"
                  style={{ fontFamily: 'var(--font-jetbrains)' }}
                >
                  {t.body}
                </div>
              </div>
              <button
                onClick={() => onDismiss(t.id)}
                className="text-[#333] hover:text-[#888] transition-colors leading-none shrink-0"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
