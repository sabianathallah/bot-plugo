import { NextRequest, NextResponse } from 'next/server';
import { botManager } from '@/lib/bot-manager.js';

export async function POST(req: NextRequest) {
  const { url } = await req.json().catch(() => ({}));
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }
  try {
    new URL(url); // validate
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  try {
    const result = await botManager.addProduct(url);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 409 });
  }
}

export async function DELETE(req: NextRequest) {
  const { url } = await req.json().catch(() => ({}));
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  botManager.removeProduct(url);
  return NextResponse.json({ ok: true });
}
