'use client';

import { useState, useRef, useEffect } from 'react';
import type { Project, Source } from '@/lib/ws-hook';
import { ProductCard } from './ProductCard';

const INTERVAL_OPTIONS = [
  { label: '5s',  ms: 5_000  },
  { label: '10s', ms: 10_000 },
  { label: '30s', ms: 30_000 },
  { label: '1m',  ms: 60_000 },
  { label: '5m',  ms: 300_000 },
];

interface Props {
  project:         Project;
  onRemove:        (projectId: number) => void;
  onRemoveProduct: (productUrl: string) => void;
  onRename:        (projectId: number, name: string) => void;
  onAddSource:     (projectId: number, url: string) => Promise<void>;
  onSetInterval:   (projectId: number, intervalMs: number) => void;
}

function sourceStatus(sources: Source[]) {
  if (sources.length === 0) return 'waiting';
  if (sources.some(s => s.status === 'active')) return 'active';
  return 'watching';
}

export function ProjectCard({ project, onRemove, onRemoveProduct, onRename, onAddSource, onSetInterval }: Props) {
  const [expanded,     setExpanded]     = useState(true);
  const [renaming,     setRenaming]     = useState(false);
  const [nameVal,      setNameVal]      = useState(project.name);
  const [addingUrl,    setAddingUrl]    = useState(false);
  const [newUrl,       setNewUrl]       = useState('');
  const [addingLoading, setAddingLoading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) nameRef.current?.focus(); }, [renaming]);
  useEffect(() => { setNameVal(project.name); }, [project.name]);

  const liveProducts   = project.products.filter(p => p.status === 'monitoring');
  const errorProducts  = project.products.filter(p => p.status === 'error');
  const totalStock     = liveProducts.flatMap(p => p.variants).reduce((s, v) => s + v.stock, 0);
  const soldOutVariants = liveProducts.flatMap(p => p.variants).filter(v => v.stock === 0).length;
  const status         = sourceStatus(project.sources);

  const commitRename = () => {
    const trimmed = nameVal.trim();
    if (trimmed && trimmed !== project.name) onRename(project.id, trimmed);
    setRenaming(false);
  };

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) return;
    setAddingLoading(true);
    try { await onAddSource(project.id, newUrl.trim()); setNewUrl(''); setAddingUrl(false); }
    finally { setAddingLoading(false); }
  };

  return (
    <div className="rounded-lg border border-[#1E1E1E] bg-[#0A0A0A] overflow-hidden">

      {/* ── Project header ── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1A1A1A] bg-[#0E0E0E]">

        {/* Expand toggle */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-[#444] hover:text-[#888] transition-colors text-xs w-4 shrink-0"
        >
          {expanded ? '▼' : '▶'}
        </button>

        {/* Project name */}
        {renaming ? (
          <input
            ref={nameRef}
            value={nameVal}
            onChange={e => setNameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setNameVal(project.name); setRenaming(false); } }}
            className="flex-1 bg-transparent border-b border-[#C8FF00] text-white text-[18px] outline-none pb-0.5"
            style={{ fontFamily: 'var(--font-bebas)', letterSpacing: '0.05em' }}
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            className="flex-1 text-left text-white text-[18px] tracking-wide hover:text-[#C8FF00] transition-colors"
            style={{ fontFamily: 'var(--font-bebas)' }}
          >
            {project.name}
          </button>
        )}

        {/* Status badge */}
        <StatusBadge status={status} />

        {/* Stats */}
        {liveProducts.length > 0 && (
          <div className="hidden sm:flex items-center gap-3 text-[10px]" style={{ fontFamily: 'var(--font-jetbrains)' }}>
            <span className="text-[#555]">{liveProducts.length} PRODUCTS</span>
            <span className="text-[#555]">STOCK <span className="text-[#C8FF00]">{totalStock}</span></span>
            {soldOutVariants > 0 && <span className="text-[#FF3030]">{soldOutVariants} OOS</span>}
            {errorProducts.length > 0 && <span className="text-[#FF9500]">{errorProducts.length} ERR</span>}
          </div>
        )}

        {/* Interval selector */}
        <select
          value={project.intervalMs}
          onChange={e => onSetInterval(project.id, Number(e.target.value))}
          className="text-[9px] bg-[#111] border border-[#1E1E1E] text-[#444] rounded px-1.5 py-1 hover:border-[#333] hover:text-[#888] transition-colors cursor-pointer outline-none"
          style={{ fontFamily: 'var(--font-jetbrains)' }}
          title="Poll interval"
        >
          {INTERVAL_OPTIONS.map(o => (
            <option key={o.ms} value={o.ms}>{o.label}</option>
          ))}
        </select>

        {/* Add source URL */}
        <button
          onClick={() => setAddingUrl(a => !a)}
          className="text-[10px] text-[#333] hover:text-[#C8FF00] transition-colors px-2 py-1 border border-[#1E1E1E] hover:border-[#C8FF00]/30 rounded"
          style={{ fontFamily: 'var(--font-jetbrains)' }}
          title="Add collection URL"
        >
          + URL
        </button>

        {/* Remove project */}
        <button
          onClick={() => { if (confirm(`Hapus project "${project.name}" dan semua produknya?`)) onRemove(project.id); }}
          className="text-[#2A2A2A] hover:text-[#FF3030] transition-colors text-base"
        >
          ×
        </button>
      </div>

      {/* ── Add source URL input ── */}
      {addingUrl && (
        <form onSubmit={handleAddSource} className="flex gap-2 px-4 py-2 bg-[#0C0C0C] border-b border-[#1A1A1A]">
          <input
            autoFocus
            type="url"
            value={newUrl}
            onChange={e => setNewUrl(e.target.value)}
            placeholder="https://store.com/products atau /collections/..."
            className="flex-1 bg-[#151515] border border-[#222] rounded px-2.5 py-1.5 text-[11px] text-white placeholder-[#333] focus:outline-none focus:border-[#C8FF00] transition-colors"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          />
          <button
            type="submit"
            disabled={!newUrl.trim() || addingLoading}
            className="px-3 py-1.5 rounded bg-[#C8FF00] text-black text-[10px] font-bold tracking-widest disabled:opacity-40"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            {addingLoading ? '…' : 'ADD'}
          </button>
          <button type="button" onClick={() => setAddingUrl(false)} className="text-[#444] hover:text-white text-sm">×</button>
        </form>
      )}

      {/* ── Source URLs list ── */}
      {expanded && project.sources.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-[#111]">
          {project.sources.map(src => (
            <span
              key={src.url}
              className={`text-[9px] px-2 py-0.5 rounded border ${
                src.status === 'active'
                  ? 'border-[#C8FF00]/20 text-[#C8FF00]/60'
                  : 'border-[#2A2A2A] text-[#333]'
              }`}
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              {src.status === 'watching' ? '⏳ ' : '● '}{new URL(src.url).pathname}
            </span>
          ))}
        </div>
      )}

      {/* ── Watching state ── */}
      {expanded && status === 'watching' && project.products.length === 0 && (
        <div className="px-4 py-8 flex flex-col items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#FF9500] animate-pulse" />
          <p className="text-[11px] text-[#444] tracking-widest" style={{ fontFamily: 'var(--font-jetbrains)' }}>
            WAITING FOR DROP — CHECKING EVERY 30s
          </p>
        </div>
      )}

      {/* ── Products grid ── */}
      {expanded && project.products.length > 0 && (
        <div className="p-4 grid grid-cols-1 xl:grid-cols-2 gap-4">
          {project.products.map(product => (
            <ProductCard
              key={product.productUrl}
              product={product}
              onRemove={() => onRemoveProduct(product.productUrl)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'active' | 'watching' | 'waiting' }) {
  if (status === 'active') return (
    <span className="text-[9px] px-2 py-0.5 rounded bg-[#C8FF00]/10 text-[#C8FF00] border border-[#C8FF00]/20 tracking-widest" style={{ fontFamily: 'var(--font-jetbrains)' }}>
      ● LIVE
    </span>
  );
  if (status === 'watching') return (
    <span className="text-[9px] px-2 py-0.5 rounded bg-[#FF9500]/10 text-[#FF9500] border border-[#FF9500]/20 tracking-widest animate-pulse" style={{ fontFamily: 'var(--font-jetbrains)' }}>
      ⏳ WATCHING
    </span>
  );
  return null;
}
