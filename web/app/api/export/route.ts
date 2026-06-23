import { NextRequest, NextResponse } from 'next/server';
import { botManager } from '@/lib/bot-manager.js';

export async function GET(req: NextRequest) {
  const format = new URL(req.url).searchParams.get('format') ?? 'csv';
  const rows = botManager.getExportData();

  if (rows.length === 0) {
    return NextResponse.json({ error: 'No data to export' }, { status: 404 });
  }

  if (format === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock History');

    ws.columns = [
      { header: 'Timestamp',    key: 'timestamp',   width: 26 },
      { header: 'Product Name', key: 'productName', width: 32 },
      { header: 'Product URL',  key: 'productUrl',  width: 55 },
      { header: 'Variant',      key: 'variant',     width: 12 },
      { header: 'Stock',        key: 'stock',       width: 10 },
    ];

    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));

    const buffer = await wb.xlsx.writeBuffer();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    return new NextResponse(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="plugo-stock-${ts}.xlsx"`,
      },
    });
  }

  // CSV
  const header = 'timestamp,product_name,product_url,variant,stock';
  const body = rows
    .map(r => [r.timestamp, `"${r.productName}"`, `"${r.productUrl}"`, r.variant, r.stock].join(','))
    .join('\n');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new NextResponse(`${header}\n${body}`, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="plugo-stock-${ts}.csv"`,
    },
  });
}
