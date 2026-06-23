import { NextRequest, NextResponse } from 'next/server';
import { botManager } from '@/lib/bot-manager.js';

// POST /api/projects — add a collection URL (creates project if needed)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { url, projectId } = body;

  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }
  try { new URL(url); } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  try {
    const result = await botManager.addCollectionToProject(url, projectId ?? null);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 409 });
  }
}

// DELETE /api/projects — remove a project or a single product
export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { projectId, productUrl } = body;

  if (projectId != null) {
    botManager.removeProject(Number(projectId));
    return NextResponse.json({ ok: true });
  }
  if (productUrl) {
    botManager.removeProduct(productUrl);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'Missing projectId or productUrl' }, { status: 400 });
}

// PATCH /api/projects — rename a project
export async function PATCH(req: NextRequest) {
  const { projectId, name } = await req.json().catch(() => ({}));
  if (!projectId || !name) {
    return NextResponse.json({ error: 'Missing projectId or name' }, { status: 400 });
  }
  try {
    botManager.renameProject(Number(projectId), name);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}
