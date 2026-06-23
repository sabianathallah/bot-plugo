'use client';

import { useState, useRef, useEffect } from 'react';

interface Props {
  onAdd:   (url: string) => Promise<void>;
  onClose: () => void;
  error?:  string;
}

const PRODUCT_EXAMPLES = [
  'https://www.broodis.com/products/835792/ziptee-polo-shirt-dark-tones',
  'https://chambredelavain.com/products/123456/nama-produk',
];

const COLLECTION_EXAMPLES = [
  'https://chambredelavain.com/products',
  'https://www.broodis.com/collections/all',
];

function detectType(url: string): 'collection' | 'product' {
  try {
    const path = new URL(url).pathname;
    if (
      /^\/products\/?$/.test(path) ||
      /^\/collections\//.test(path) ||
      (/^\/products\//.test(path) && !/^\/products\/\d+/.test(path))
    ) return 'collection';
  } catch {}
  return 'product';
}

export function AddUrlForm({ onAdd, onClose, error }: Props) {
  const [url,     setUrl]     = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef              = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const urlType  = url.trim() ? detectType(url.trim()) : 'product';
  const isCollection = urlType === 'collection';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || loading) return;
    setLoading(true);
    try {
      await onAdd(url.trim());
    } finally {
      setLoading(false);
    }
  };

  const loadingLabel  = isCollection ? 'SCANNING…' : 'DETECTING…';
  const submitLabel   = isCollection ? 'SCAN ALL PRODUCTS' : 'START MONITOR';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-lg border border-[#2A2A2A] bg-[#0E0E0E] overflow-hidden shadow-2xl">

        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1E1E1E]">
          <span
            className="text-[20px] tracking-wider text-white"
            style={{ fontFamily: 'var(--font-bebas)' }}
          >
            {isCollection ? 'SCAN COLLECTION' : 'ADD PRODUCT URL'}
          </span>
          <button onClick={onClose} className="text-[#444] hover:text-white text-xl transition-colors">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          <div>
            <label
              className="block text-[10px] tracking-widest text-[#555] mb-2"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              {isCollection ? 'PLUGO COLLECTION / PRODUCTS PAGE URL' : 'PLUGO PRODUCT PAGE URL'}
            </label>
            <input
              ref={inputRef}
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://store.com/products/... atau /products"
              className="w-full bg-[#151515] border border-[#222] rounded px-3 py-2.5 text-sm text-white placeholder-[#333] focus:outline-none focus:border-[#C8FF00] transition-colors"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            />
          </div>

          {/* Collection hint */}
          {isCollection && (
            <div className="flex items-start gap-2 px-3 py-2 rounded bg-[#C8FF00]/5 border border-[#C8FF00]/20">
              <span className="text-[#C8FF00] text-[10px] mt-0.5">→</span>
              <p className="text-[10px] text-[#C8FF00]/70 leading-relaxed" style={{ fontFamily: 'var(--font-jetbrains)' }}>
                Halaman koleksi terdeteksi — semua produk di halaman ini akan dimonitor otomatis
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-[11px] text-[#FF3030]" style={{ fontFamily: 'var(--font-jetbrains)' }}>
              {error}
            </p>
          )}

          {/* Examples */}
          <div>
            <p className="text-[10px] text-[#333] mb-2 tracking-widest" style={{ fontFamily: 'var(--font-jetbrains)' }}>
              {isCollection ? 'CONTOH COLLECTION URL' : 'CONTOH PRODUCT URL'}
            </p>
            {(isCollection ? COLLECTION_EXAMPLES : PRODUCT_EXAMPLES).map(ex => (
              <button
                key={ex}
                type="button"
                onClick={() => setUrl(ex)}
                className="block w-full text-left text-[10px] text-[#3A3A3A] hover:text-[#C8FF00] truncate transition-colors py-0.5"
                style={{ fontFamily: 'var(--font-jetbrains)' }}
              >
                {ex}
              </button>
            ))}
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded border border-[#222] text-[#555] text-sm hover:border-[#333] hover:text-[#888] transition-colors"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={!url.trim() || loading}
              className="flex-1 py-2.5 rounded bg-[#C8FF00] text-black text-sm font-bold tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white transition-colors"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              {loading ? loadingLabel : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
