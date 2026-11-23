'use client';

import { useEffect, useState } from 'react';

/** Rp 1.234.567 */
export function rupiah(n: number | null | undefined): string {
  if (n == null) return '—';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

/** Rp 12,3 jt / Rp 1,2 M — for tight spaces */
export function rupiahShort(n: number | null | undefined): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `Rp ${(n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 })} M`;
  if (abs >= 1e6) return `Rp ${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (abs >= 1e3) return `Rp ${(n / 1e3).toLocaleString('id-ID', { maximumFractionDigits: 0 })} rb`;
  return `Rp ${n}`;
}

/** 14:05:09 today, otherwise 21/11 14:05:09 */
export function timeLabel(iso: string): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB');
  if (d.toDateString() === new Date().toDateString()) return t;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${t}`;
}

/** useState that survives a page refresh (per browser). Storage errors are ignored. */
export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch { /* private mode / blocked storage */ }
  }, [key]);

  const set = (v: T | ((p: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  return [value, set];
}
