import { createWriteStream } from 'fs';
import { format as formatCsv } from 'fast-csv';
import path from 'path';

/**
 * Exports accumulated stock-change events to a timestamped CSV file.
 *
 * @param {Array<{
 *   timestamp: Date,
 *   productUrl: string,
 *   productName: string,
 *   variant: string,
 *   oldStock: number|null,
 *   newStock: number,
 *   changeType: string
 * }>} events
 * @returns {Promise<string>} path to the written file
 */
export async function exportToCsv(events) {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  const filename = `plugo-stock-${ts}.csv`;
  const filepath = path.resolve(process.cwd(), filename);

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filepath);
    const csvStream = formatCsv({ headers: true, delimiter: ',' });

    ws.on('finish', () => resolve(filepath));
    ws.on('error', reject);
    csvStream.pipe(ws);

    for (const e of events) {
      csvStream.write({
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp,
        product_url: e.productUrl,
        product_name: e.productName,
        variant: e.variant,
        old_stock: e.oldStock ?? '',
        new_stock: e.newStock,
        change_type: e.changeType,
      });
    }

    csvStream.end();
  });
}
