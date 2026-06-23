import { EventEmitter } from 'events';
import { detectPlugoEndpoint } from '../../src/detector.js';
import { StockPoller } from '../../src/poller.js';
import {
  saveProduct, updateProductName, deleteProduct,
  getAllProducts, saveSnapshot, saveChanges, getHistory, getExportData,
} from './db.js';

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    // url → { productName, variants, history, status, error, poller }
    this.products = new Map();
  }

  // ── State snapshot for WebSocket init ─────────────────────────────────────
  getState() {
    return [...this.products.entries()].map(([url, p]) => ({
      productUrl:  url,
      productName: p.productName,
      variants:    p.variants,
      history:     p.history.slice(-100),
      status:      p.status,
      error:       p.error ?? null,
    }));
  }

  // ── Boot: restore saved products from DB and resume monitoring ─────────────
  async resumeFromDb() {
    const saved = getAllProducts();
    if (saved.length === 0) return;
    console.log(`[bot] Resuming ${saved.length} product(s) from DB…`);

    await Promise.allSettled(
      saved.map(({ url, name }) => {
        // Seed in-memory entry so getState() shows them immediately
        this.products.set(url, {
          productName: name ?? url,
          variants:    [],
          history:     this._loadHistory(url),
          status:      'detecting',
          error:       null,
          poller:      null,
        });
        this.emit('product:detecting', { productUrl: url });
        return this._startMonitoring(url);
      })
    );
  }

  // ── Load last 100 history entries from DB into memory ─────────────────────
  _loadHistory(url) {
    const rows = getHistory(url);
    if (rows.length === 0) return [];

    // Group by timestamp → [{timestamp, variants:[]}]
    const byTime = new Map();
    for (const { recorded_at, variant, stock } of rows) {
      if (!byTime.has(recorded_at)) byTime.set(recorded_at, []);
      byTime.get(recorded_at).push({ label: variant, stock });
    }
    return [...byTime.entries()]
      .slice(-100)
      .map(([timestamp, variants]) => ({ timestamp, variants }));
  }

  // ── Add a new product ──────────────────────────────────────────────────────
  async addProduct(productUrl) {
    if (this.products.has(productUrl)) throw new Error('Already monitoring this URL');

    saveProduct(productUrl, null);

    this.products.set(productUrl, {
      productName: productUrl,
      variants:    [],
      history:     [],
      status:      'detecting',
      error:       null,
      poller:      null,
    });
    this.emit('product:detecting', { productUrl });
    return this._startMonitoring(productUrl);
  }

  // ── Core detection + polling setup ─────────────────────────────────────────
  async _startMonitoring(productUrl) {
    try {
      const result = await detectPlugoEndpoint(productUrl, () => {});
      if (!result) throw new Error('Not a Plugo store or no stock data found');

      const entry = this.products.get(productUrl);
      if (!entry) return; // removed while detecting

      const { apiUrl, initial } = result;
      entry.productName = initial.productName;
      entry.variants    = initial.variants;
      entry.status      = 'monitoring';

      // Persist name + initial snapshot
      updateProductName(productUrl, initial.productName);
      const now = new Date().toISOString();
      saveSnapshot(productUrl, initial.variants, now);

      if (entry.history.length === 0) {
        entry.history.push({ timestamp: now, variants: initial.variants });
      }

      this.emit('product:added', {
        productUrl,
        productName: initial.productName,
        variants:    initial.variants,
        history:     entry.history,
      });

      const poller = new StockPoller({ productUrl, apiUrl, initial, intervalMs: 5000 });

      poller.on('update', ({ data, changes, timestamp }) => {
        const e = this.products.get(productUrl);
        if (!e) return;

        const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        e.productName = data.productName;
        e.variants    = data.variants;
        e.history.push({ timestamp: ts, variants: data.variants });
        if (e.history.length > 200) e.history = e.history.slice(-200);

        // Persist to DB
        saveSnapshot(productUrl, data.variants, ts);
        if (changes.length > 0) saveChanges(productUrl, changes, ts);

        this.emit('stock:update', {
          productUrl,
          productName: data.productName,
          variants:    data.variants,
          changes,
          timestamp:   ts,
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

  // ── Remove a product ───────────────────────────────────────────────────────
  removeProduct(productUrl) {
    const entry = this.products.get(productUrl);
    if (!entry) return;
    entry.poller?.stop();
    this.products.delete(productUrl);
    deleteProduct(productUrl); // removes from DB + cascades history
    this.emit('product:removed', { productUrl });
  }

  // ── Export helpers ─────────────────────────────────────────────────────────
  getExportData() {
    // Pull from DB (includes historical data, not just in-memory)
    return getExportData();
  }
}

// Persist singleton across Next.js HMR reloads in dev
const g = globalThis;
if (!g._botManager) {
  g._botManager = new BotManager();
  // Auto-resume saved products on first load
  g._botManager.resumeFromDb().catch(e => console.error('[bot] resume error:', e));
}

export const botManager = g._botManager;
