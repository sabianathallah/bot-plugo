'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

export type Variant      = { label: string; stock: number; price?: number | null };
export type ChangeType   = 'restock' | 'soldout' | 'change' | 'new' | 'order' | 'gap';
export type Change       = { label: string; oldStock: number | null; newStock: number; type: ChangeType; price?: number | null };

export type VariantSales = {
  label: string; sold: number; pending: number; out: number;
  released: number; restocked: number; price: number | null;
};
export type SalesStats = {
  sold: number; pending: number; out: number; released: number; restocked: number;
  omset: number; priced: boolean; perVariant: VariantSales[];
  numOrders: number | null; numOrdersFirst: number | null; price: number | null;
  soldTracked: number; soldInitial: number;
};
export type HistoryEntry = { timestamp: string; variants: Variant[] };

export type Product = {
  productUrl:  string;
  productName: string;
  variants:    Variant[];
  history:     HistoryEntry[];
  status:      'detecting' | 'monitoring' | 'error' | 'paused';
  error?:      string | null;
  stats?:      SalesStats;
};

export type Source = {
  url:    string;
  status: 'watching' | 'active';
};

export type Project = {
  id:         number;
  name:       string;
  intervalMs: number;
  paused?:    boolean;
  sources:    Source[];
  products:   Product[];
};

export type ToastKind = 'restock' | 'soldout' | 'info' | 'error';
export type Toast = {
  id:         string;
  kind:       ToastKind;
  title:      string;
  body:       string;
  productUrl: string;
  exiting?:   boolean;
};

export type Activity = {
  id:          string;
  timestamp:   string;
  productName: string;
  productUrl:  string;
  projectId:   number;
  changes:     Change[];
};

const sameStock = (a: Variant[], b: Variant[]) =>
  a.length === b.length && a.every((x, i) => x.label === b[i].label && x.stock === b[i].stock);

// Mirror of the server's history compression: runs of equal stock keep only endpoints
function appendHistory(history: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const n = history.length;
  if (n >= 2 && sameStock(history[n - 1].variants, entry.variants) && sameStock(history[n - 2].variants, entry.variants)) {
    return [...history.slice(0, -1), entry];
  }
  return [...history.slice(-499), entry];
}

function upsertProduct(products: Product[], incoming: Product): Product[] {
  const idx = products.findIndex(p => p.productUrl === incoming.productUrl);
  if (idx === -1) return [...products, incoming];
  const merged = { ...products[idx], ...incoming };
  return [...products.slice(0, idx), merged, ...products.slice(idx + 1)];
}

export function useWebSocket() {
  const [projects,   setProjects]   = useState<Project[]>([]);
  const [toasts,     setToasts]     = useState<Toast[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [connected,  setConnected]  = useState(false);
  const ws       = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const updateProjectProducts = useCallback((
    projectId: number,
    updater: (products: Product[]) => Product[],
  ) => {
    setProjects(prev => prev.map(proj =>
      proj.id === projectId
        ? { ...proj, products: updater(proj.products) }
        : proj
    ));
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
        // ── Full state on connect
        case 'init':
          setProjects(msg.projects ?? []);
          setActivities(msg.activities ?? []);
          break;

        // ── Project lifecycle
        case 'project:added':
          setProjects(prev => {
            if (prev.find(p => p.id === msg.id)) return prev;
            return [...prev, { id: msg.id, name: msg.name, intervalMs: msg.intervalMs ?? 5000, sources: msg.sources ?? [], products: [] }];
          });
          break;

        case 'project:updated':
          setProjects(prev => prev.map(p => p.id === msg.id ? { ...p, ...msg } : p));
          break;

        case 'project:removed':
          setProjects(prev => prev.filter(p => p.id !== msg.projectId));
          break;

        // ── Source (collection URL) events
        case 'source:watching':
          setProjects(prev => prev.map(p => {
            if (p.id !== msg.projectId) return p;
            const sources = p.sources.map(s =>
              s.url === msg.collectionUrl ? { ...s, status: 'watching' as const } : s
            );
            return { ...p, sources };
          }));
          pushToast({ kind: 'info', title: 'WATCHING', body: `Waiting for drop at ${new URL(msg.collectionUrl).hostname}`, productUrl: msg.collectionUrl });
          break;

        case 'source:found':
          setProjects(prev => prev.map(p => {
            if (p.id !== msg.projectId) return p;
            const sources = p.sources.map(s =>
              s.url === msg.collectionUrl ? { ...s, status: 'active' as const } : s
            );
            return { ...p, sources };
          }));
          pushToast({ kind: 'info', title: '🔴 DROP DETECTED', body: `${msg.count} produk ditemukan di ${new URL(msg.collectionUrl).hostname}`, productUrl: msg.collectionUrl });
          break;

        // ── Product lifecycle
        case 'product:detecting':
          updateProjectProducts(msg.projectId, products =>
            upsertProduct(products, {
              productUrl:  msg.productUrl,
              productName: msg.productUrl,
              variants:    [],
              history:     [],
              status:      'detecting',
            })
          );
          break;

        case 'product:added':
          updateProjectProducts(msg.projectId, products =>
            upsertProduct(products, {
              productUrl:  msg.productUrl,
              productName: msg.productName,
              variants:    msg.variants,
              history:     msg.history ?? [],
              status:      'monitoring',
              error:       null,
              stats:       msg.stats,
            })
          );
          pushToast({ kind: 'info', title: 'LIVE', body: msg.productName, productUrl: msg.productUrl });
          break;

        case 'product:removed':
          updateProjectProducts(msg.projectId, products =>
            products.filter(p => p.productUrl !== msg.productUrl)
          );
          break;

        case 'product:error':
          updateProjectProducts(msg.projectId, products =>
            products.map(p =>
              p.productUrl === msg.productUrl ? { ...p, status: 'error' as const, error: msg.error } : p
            )
          );
          pushToast({ kind: 'error', title: 'ERROR', body: msg.error, productUrl: msg.productUrl });
          break;

        // ── Stock updates
        case 'stock:update':
          updateProjectProducts(msg.projectId, products =>
            products.map(p => {
              if (p.productUrl !== msg.productUrl) return p;
              return {
                ...p,
                status:      'monitoring' as const,
                error:       null,
                productName: msg.productName,
                variants:    msg.variants,
                stats:       msg.stats ?? p.stats,
                history:     appendHistory(p.history, {
                  timestamp: msg.timestamp,
                  variants:  (msg.variants as Variant[]).map(v => ({ label: v.label, stock: v.stock })),
                }),
              };
            })
          );

          {
            const feed: Change[] = [...((msg.changes as Change[]) ?? [])];
            if (msg.orderChange) feed.push({ label: 'ORDERS', oldStock: msg.orderChange.old, newStock: msg.orderChange.new, type: 'order' });
            if (feed.length > 0) {
              const id = `${msg.productUrl}|${msg.timestamp}`;
              setActivities(prev => [
                { id, timestamp: msg.timestamp, productName: msg.productName, productUrl: msg.productUrl, projectId: msg.projectId, changes: feed },
                ...prev.slice(0, 499),
              ]);
            }
          }

          if ((msg.changes as Change[])?.length > 0) {
            for (const c of msg.changes as Change[]) {
              if (c.type === 'restock') pushToast({ kind: 'restock', title: '▲ RESTOCK', body: `${msg.productName} · ${c.label}  ${c.oldStock} → ${c.newStock}`, productUrl: msg.productUrl });
              if (c.type === 'soldout') pushToast({ kind: 'soldout', title: '▼ SOLD OUT', body: `${msg.productName} · ${c.label}`, productUrl: msg.productUrl });
            }
          }
          break;
      }
    };
  }, [pushToast, updateProjectProducts]);

  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      ws.current?.close();
    };
  }, [connect]);

  return { projects, toasts, activities, connected, dismissToast };
}
