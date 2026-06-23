'use client';

import { useState, useEffect } from 'react';
import { useWebSocket } from '@/lib/ws-hook';
import { ProjectCard } from './ProjectCard';
import { AddUrlForm } from './AddUrlForm';
import { ToastStack } from './ToastStack';
import { ActivityFeed } from './ActivityFeed';

export function Dashboard() {
  const { projects, toasts, activities, connected, dismissToast } = useWebSocket();
  const [showAdd,   setShowAdd]   = useState(false);
  const [clock,     setClock]     = useState('');
  const [addError,  setAddError]  = useState('');

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-GB'));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const totalProducts = projects.flatMap(p => p.products).filter(p => p.status === 'monitoring').length;
  const hasHistory    = projects.flatMap(p => p.products).some(p => p.history.length > 0);
  const isEmpty       = projects.length === 0;

  const handleAdd = async (url: string, projectId?: number) => {
    setAddError('');
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, projectId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      setShowAdd(false);
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const handleRemoveProject = async (projectId: number) => {
    await fetch('/api/projects', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
  };

  const handleRemoveProduct = async (productUrl: string) => {
    await fetch('/api/projects', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productUrl }),
    });
  };

  const handleRename = async (projectId: number, name: string) => {
    await fetch('/api/projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, name }),
    });
  };

  const handleSetInterval = async (projectId: number, intervalMs: number) => {
    await fetch('/api/projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, intervalMs }),
    });
  };

  const handleAddSource = async (projectId: number, url: string) => {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, projectId }),
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error ?? 'Failed');
    }
  };

  const handleRescan = async (projectId: number, sourceUrl: string): Promise<{added: number}> => {
    const res = await fetch('/api/projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, rescanUrl: sourceUrl }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Failed');
    return { added: json.added ?? 0 };
  };

  return (
    <div className="min-h-dvh flex flex-col">

      {/* ── TOP BAR ── */}
      <header className="sticky top-0 z-40 border-b border-[#1E1E1E] bg-[#0A0A0A]/95 backdrop-blur-sm">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-4">

          <span
            className="text-[28px] leading-none tracking-wider text-white select-none"
            style={{ fontFamily: 'var(--font-bebas)' }}
          >
            PLUGO<span className="text-[#C8FF00]">·</span>MONITOR
          </span>

          <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-[#1E1E1E] bg-[#111]">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-[#C8FF00] animate-pulse-dot' : 'bg-[#FF3030]'}`} />
            <span
              className="text-[11px] tracking-widest"
              style={{ fontFamily: 'var(--font-jetbrains)', color: connected ? '#C8FF00' : '#FF3030' }}
            >
              {connected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>

          {totalProducts > 0 && (
            <span className="hidden sm:block text-xs text-[#4A4A4A]" style={{ fontFamily: 'var(--font-jetbrains)' }}>
              {projects.length} project{projects.length !== 1 ? 's' : ''} · {totalProducts} monitored
            </span>
          )}

          <div className="flex-1" />

          <span className="hidden md:block text-xs text-[#4A4A4A] tabular-nums" style={{ fontFamily: 'var(--font-jetbrains)' }}>
            {clock}
          </span>

          {hasHistory && (
            <div className="hidden sm:flex gap-2">
              {(['csv', 'xlsx'] as const).map(fmt => (
                <a
                  key={fmt}
                  href={`/api/export?format=${fmt}`}
                  download
                  className="text-[11px] px-3 py-1.5 rounded border border-[#2A2A2A] text-[#888] hover:border-[#C8FF00] hover:text-[#C8FF00] transition-colors"
                  style={{ fontFamily: 'var(--font-jetbrains)' }}
                >
                  ↓ {fmt.toUpperCase()}
                </a>
              ))}
            </div>
          )}

          <button
            onClick={() => { setShowAdd(true); setAddError(''); }}
            className="flex items-center gap-2 px-4 py-2 rounded bg-[#C8FF00] text-black text-xs font-bold tracking-widest hover:bg-white transition-colors"
            style={{ fontFamily: 'var(--font-jetbrains)' }}
          >
            + ADD PROJECT
          </button>
        </div>
      </header>

      {/* ── BODY ── */}
      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-6">

        {/* Empty state */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 select-none">
            <div className="relative">
              <div className="text-[120px] sm:text-[180px] leading-none text-[#1A1A1A]" style={{ fontFamily: 'var(--font-bebas)' }}>
                READY
              </div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-[14px] tracking-[0.3em] text-[#444]" style={{ fontFamily: 'var(--font-jetbrains)' }}>
                  NO PROJECTS YET
                </div>
              </div>
            </div>
            <button
              onClick={() => setShowAdd(true)}
              className="px-6 py-3 border border-[#C8FF00] text-[#C8FF00] rounded text-sm tracking-widest hover:bg-[#C8FF00] hover:text-black transition-colors"
              style={{ fontFamily: 'var(--font-jetbrains)' }}
            >
              + ADD PROJECT
            </button>
          </div>
        )}

        {/* Projects + activity */}
        {!isEmpty && (
          <div className="flex gap-6 items-start">

            {/* Project sections */}
            <div className="flex-1 flex flex-col gap-6 min-w-0">
              {projects.map(project => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onRemove={handleRemoveProject}
                  onRemoveProduct={handleRemoveProduct}
                  onRename={handleRename}
                  onAddSource={handleAddSource}
                  onSetInterval={handleSetInterval}
                  onRescan={handleRescan}
                />
              ))}
            </div>

            {/* Activity feed — always visible on wide screens */}
            <div className="hidden lg:block w-72 shrink-0">
              <ActivityFeed activities={activities} projects={projects} />
            </div>
          </div>
        )}

        {/* Activity feed below on narrow screens */}
        {!isEmpty && (
          <div className="lg:hidden mt-6">
            <ActivityFeed activities={activities} projects={projects} />
          </div>
        )}
      </main>

      {showAdd && (
        <AddUrlForm
          onAdd={url => handleAdd(url)}
          onClose={() => { setShowAdd(false); setAddError(''); }}
          error={addError}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
