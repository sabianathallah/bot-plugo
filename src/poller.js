import axios from 'axios';
import { parseStockData } from './detector.js';
import { EventEmitter } from 'events';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

export class StockPoller extends EventEmitter {
  constructor({ productUrl, apiUrl, initial, intervalMs = 5000 }) {
    super();
    this.productUrl = productUrl;
    this.apiUrl = apiUrl; // for Plugo = same as productUrl
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.errorCount = 0;
    this.lastPoll = null;
    this.currentData = initial ?? { productName: 'Unknown', variants: [] };
    this.previousData = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._scheduleNext();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setIntervalMs(ms) {
    this.intervalMs = ms;
    if (this.running) {
      clearTimeout(this.timer);
      this._scheduleNext();
    }
  }

  _scheduleNext() {
    if (!this.running) return;
    this.timer = setTimeout(() => this._poll(), this.intervalMs);
  }

  async _poll() {
    try {
      const res = await axios.get(this.apiUrl, {
        timeout: 12_000,
        headers: BROWSER_HEADERS,
        responseType: 'text',
        validateStatus: (s) => s < 500,
      });

      this.errorCount = 0;
      this.lastPoll = new Date();

      const fresh = parseStockData(res.data, this.productUrl);
      if (!fresh || fresh.variants.length === 0) {
        this.emit('error', {
          productUrl: this.productUrl,
          error: 'Could not parse stock data from page',
          count: ++this.errorCount,
        });
        return;
      }

      const changes = this._diff(this.currentData, fresh);
      this.previousData = this.currentData;
      this.currentData = fresh;

      this.emit('update', {
        productUrl: this.productUrl,
        data: fresh,
        changes,
        timestamp: this.lastPoll,
      });
    } catch (err) {
      this.errorCount++;
      this.emit('error', {
        productUrl: this.productUrl,
        error: err.message,
        count: this.errorCount,
      });
    } finally {
      this._scheduleNext();
    }
  }

  _diff(prev, next) {
    if (!prev?.variants) return [];
    const prevMap = new Map(prev.variants.map((v) => [v.label, v.stock]));
    const changes = [];

    for (const { label, stock } of next.variants) {
      const oldStock = prevMap.get(label) ?? null;
      if (oldStock === null) {
        changes.push({ label, oldStock: null, newStock: stock, type: 'new' });
      } else if (oldStock !== stock) {
        const type = stock === 0 ? 'soldout' : oldStock === 0 ? 'restock' : 'change';
        changes.push({ label, oldStock, newStock: stock, type });
      }
    }
    return changes;
  }
}
