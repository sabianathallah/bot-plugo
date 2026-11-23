import { NextRequest, NextResponse } from 'next/server';
import { botManager } from '@/lib/bot-manager.js';

type Row = Record<string, unknown>;

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: NextRequest) {
  const format = new URL(req.url).searchParams.get('format') ?? 'csv';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const summary: Row[] = botManager.getSummaryRows();
  const changes: Row[] = botManager.getExportChanges();
  const orders:  Row[] = botManager.getExportOrders();

  if (format === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const add = (name: string, cols: { header: string; key: string; width: number; fmt?: string }[], rows: Row[]) => {
      const ws = wb.addWorksheet(name);
      ws.columns = cols.map(({ header, key, width }) => ({ header, key, width }));
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      rows.forEach(r => ws.addRow(r));
      cols.forEach((c, i) => { if (c.fmt) ws.getColumn(i + 1).numFmt = c.fmt; });
    };
    const rp = '"Rp" #,##0';

    add('Ringkasan', [
      { header: 'Project', key: 'project', width: 16 },
      { header: 'Produk', key: 'product', width: 42 },
      { header: 'Harga', key: 'price', width: 14, fmt: rp },
      { header: 'Terjual (est)', key: 'sold', width: 13 },
      { header: 'Pending', key: 'pending', width: 10 },
      { header: 'Checkout keluar', key: 'out', width: 15 },
      { header: 'Balik', key: 'released', width: 10 },
      { header: 'Restock', key: 'restocked', width: 10 },
      { header: 'Omset (est)', key: 'omset', width: 18, fmt: rp },
      { header: 'Order Plugo', key: 'numOrders', width: 12 },
      { header: 'Order awal dipantau', key: 'numOrdersFirst', width: 18 },
      { header: 'Stok sekarang', key: 'stockNow', width: 13 },
      { header: 'URL', key: 'url', width: 60 },
    ], summary);

    add('Pergerakan', [
      { header: 'Waktu (UTC)', key: 'timestamp', width: 26 },
      { header: 'Project', key: 'project_name', width: 16 },
      { header: 'Produk', key: 'product_name', width: 42 },
      { header: 'Size', key: 'variant', width: 10 },
      { header: 'Stok lama', key: 'old_stock', width: 10 },
      { header: 'Stok baru', key: 'new_stock', width: 10 },
      { header: 'Delta', key: 'delta', width: 8 },
      { header: 'Tipe', key: 'change_type', width: 10 },
    ], changes);

    add('Order', [
      { header: 'Waktu (UTC)', key: 'timestamp', width: 26 },
      { header: 'Project', key: 'project_name', width: 16 },
      { header: 'Produk', key: 'product_name', width: 42 },
      { header: 'Order lama', key: 'old_orders', width: 12 },
      { header: 'Order baru', key: 'new_orders', width: 12 },
      { header: 'Delta', key: 'delta', width: 8 },
    ], orders);

    // Full snapshots only on request — they are large (one row per size per poll)
    if (new URL(req.url).searchParams.get('snapshots') === '1') {
      add('Snapshot', [
        { header: 'Waktu (UTC)', key: 'timestamp', width: 26 },
        { header: 'Project', key: 'project_name', width: 16 },
        { header: 'Produk', key: 'product_name', width: 42 },
        { header: 'Size', key: 'variant', width: 10 },
        { header: 'Stok', key: 'stock', width: 8 },
      ], botManager.getExportData());
    }

    const buffer = await wb.xlsx.writeBuffer();
    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="plugo-laporan-${ts}.xlsx"`,
      },
    });
  }

  // CSV: every stock movement
  const keys = ['timestamp', 'project_name', 'product_name', 'variant', 'old_stock', 'new_stock', 'delta', 'change_type'];
  const body = [keys.join(','), ...changes.map(r => keys.map(k => csvCell(r[k])).join(','))].join('\n');
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="plugo-pergerakan-${ts}.csv"`,
    },
  });
}
