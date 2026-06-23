import { EventEmitter } from 'events';
import { detectPlugoEndpoint } from '../../src/detector.js';
import { StockPoller } from '../../src/poller.js';

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    // url → { productName, variants, history, status, error, poller }
    this.products = new Map();
  }

  getState() {
    return [...this.products.entries()].map(([url, p]) => ({
      productUrl: url,
      productName: p.productName,
      variants: p.variants,
      history: p.history.slice(-100),
      status: p.status,
      error: p.error ?? null,
    }));
  }

  async addProduct(productUrl) {
    if (this.products.has(productUrl)) throw new Error('Already monitoring this URL');

    this.products.set(productUrl, {
      productName: productUrl,
      variants: [],
      history: [],
      status: 'detecting',
      error: null,
      poller: null,
    });
    this.emit('product:detecting', { productUrl });

    try {
      const result = await detectPlugoEndpoint(productUrl, () => {});
      if (!result) throw new Error('Not a Plugo store or no stock data found');

      const entry = this.products.get(productUrl);
      if (!entry) return; // removed while detecting

      const { apiUrl, initial } = result;
      entry.productName = initial.productName;
      entry.variants = initial.variants;
      entry.status = 'monitoring';
      entry.history.push({ timestamp: new Date().toISOString(), variants: initial.variants });

      this.emit('product:added', {
        productUrl,
        productName: initial.productName,
        variants: initial.variants,
        history: entry.history,
      });

      const poller = new StockPoller({ productUrl, apiUrl, initial, intervalMs: 5000 });

      poller.on('update', ({ data, changes, timestamp }) => {
        const e = this.products.get(productUrl);
        if (!e) return;
        e.productName = data.productName;
        e.variants = data.variants;
        const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        e.history.push({ timestamp: ts, variants: data.variants });
        if (e.history.length > 200) e.history = e.history.slice(-200);

        this.emit('stock:update', {
          productUrl,
          productName: data.productName,
          variants: data.variants,
          changes,
          timestamp: ts,
        });
      });

      poller.on('error', ({ error }) => {
        const e = this.products.get(productUrl);
        if (e) e.error = error;
        this.emit('product:error', { productUrl, error });
      });

      poller.start();
      entry.poller = poller;

    } catch (err) {
      const entry = this.products.get(productUrl);
      if (entry) { entry.status = 'error'; entry.error = err.message; }
      this.emit('product:error', { productUrl, error: err.message });
    }
  }

  removeProduct(productUrl) {
    const entry = this.products.get(productUrl);
    if (!entry) return;
    entry.poller?.stop();
    this.products.delete(productUrl);
    this.emit('product:removed', { productUrl });
  }

  getExportData() {
    const rows = [];
    for (const [url, entry] of this.products) {
      for (const snap of entry.history) {
        for (const v of snap.variants) {
          rows.push({
            timestamp: snap.timestamp,
            productUrl: url,
            productName: entry.productName,
            variant: v.label,
            stock: v.stock,
          });
        }
      }
    }
    return rows;
  }
}

// Persist singleton across Next.js HMR reloads in dev
const g = globalThis;
if (!g._botManager) g._botManager = new BotManager();

export const botManager = g._botManager;
