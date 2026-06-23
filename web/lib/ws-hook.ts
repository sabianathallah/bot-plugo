'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type Variant      = { label: string; stock: number };
export type ChangeType   = 'restock' | 'soldout' | 'change' | 'new';
export type Change       = { label: string; oldStock: number | null; newStock: number; type: ChangeType };
export type HistoryEntry = { timestamp: string; variants: Variant[] };

export type Product = {
  productUrl:  string;
  productName: string;
  variants:    Variant[];
  history:     HistoryEntry[];
  status:      'detecting' | 'monitoring' | 'error';
  error?:      string | null;
};

export type ToastKind = 'restock' | 'soldout' | 'info' | 'error';
export type Toast = {
  id:          string;
  kind:        ToastKind;
  title:       string;
  body:        string;
  productUrl:  string;
  exiting?:    boolean;
};

export type Activity = {
  id:          string;
  timestamp:   string;
  productName: string;
  productUrl:  string;
  changes:     Change[];
};

export function useWebSocket() {
  const [products,   setProducts]   = useState<Product[]>([]);
  const [toasts,     setToasts]     = useState<Toast[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [connected,  setConnected]  = useState(false);
  const ws        = useRef<WebSocket | null>(null);
  const retryRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushToast = useCallback((t: Omit<Toast, 'id' | 'exiting'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev.slice(-4), { ...t, id }]);
    setTimeout(() => {
      setToasts(prev => prev.map(x => x.id === id ? { ...x, exiting: true } : x));
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 350);
    }, 4800);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.map(x => x.id === id ? { ...x, exiting: true } : x));
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 350);
  }, []);

  const connect = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock  = new WebSocket(`${proto}//${window.location.host}/ws`);
    ws.current  = sock;

    sock.onopen  = () => setConnected(true);
    sock.onclose = () => {
      setConnected(false);
      retryRef.current = setTimeout(connect, 3000);
    };

    sock.onmessage = ({ data }) => {
      const msg = JSON.parse(data as string);

      switch (msg.type) {
        case 'init':
          setProducts(msg.products ?? []);
          break;

        case 'product:detecting':
          setProducts(prev =>
            prev.find(p => p.productUrl === msg.productUrl)
              ? prev
              : [...prev, { productUrl: msg.productUrl, productName: msg.productUrl, variants: [], history: [], status: 'detecting' }]
          );
          break;

        case 'product:added':
          setProducts(prev => prev.map(p =>
            p.productUrl === msg.productUrl
              ? { ...p, productName: msg.productName, variants: msg.variants, history: msg.history ?? [], status: 'monitoring', error: null }
              : p
          ));
          pushToast({ kind: 'info', title: 'ADDED', body: msg.productName, productUrl: msg.productUrl });
          break;

        case 'product:removed':
          setProducts(prev => prev.filter(p => p.productUrl !== msg.productUrl));
          break;

        case 'product:error':
          setProducts(prev => prev.map(p =>
            p.productUrl === msg.productUrl ? { ...p, status: 'error', error: msg.error } : p
          ));
          pushToast({ kind: 'error', title: 'ERROR', body: msg.error, productUrl: msg.productUrl });
          break;

        case 'stock:update':
          setProducts(prev => prev.map(p => {
            if (p.productUrl !== msg.productUrl) return p;
            return {
              ...p,
              productName: msg.productName,
              variants:    msg.variants,
              history:     [...p.history.slice(-199), { timestamp: msg.timestamp, variants: msg.variants }],
            };
          }));

          if ((msg.changes as Change[])?.length > 0) {
            const id = Math.random().toString(36).slice(2);
            setActivities(prev => [{ id, timestamp: msg.timestamp, productName: msg.productName, productUrl: msg.productUrl, changes: msg.changes }, ...prev.slice(0, 79)]);

            for (const c of msg.changes as Change[]) {
              if (c.type === 'restock') pushToast({ kind: 'restock', title: '▲ RESTOCK', body: `${msg.productName} · ${c.label}  ${c.oldStock} → ${c.newStock}`, productUrl: msg.productUrl });
              if (c.type === 'soldout') pushToast({ kind: 'soldout', title: '▼ SOLD OUT', body: `${msg.productName} · ${c.label}`, productUrl: msg.productUrl });
            }
          }
          break;
      }
    };
  }, [pushToast]);

  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      ws.current?.close();
    };
  }, [connect]);

  return { products, toasts, activities, connected, dismissToast };
}
