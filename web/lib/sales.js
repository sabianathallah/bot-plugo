// Sales estimate from stock movements (no access to the store's order data).
//
// Model, per variant:
//   - a stock DECREASE = units put on hold by a checkout
//   - an INCREASE within RELEASE_WINDOW of open holds = unpaid checkout released
//   - any remaining increase = restock
//   - estimated sold = held − released  (holds younger than the window are
//     still "pending": they may yet be released)
// Omset (revenue) estimate = Σ sold × variant price.

export const RELEASE_WINDOW_MS = parseInt(process.env.PLUGO_RELEASE_WINDOW_MIN ?? '25', 10) * 60_000;

export class SalesTracker {
  constructor() {
    this.variants = new Map(); // label → { out, released, restocked, holds: [{t, qty}] }
  }

  _v(label) {
    let v = this.variants.get(label);
    if (!v) { v = { out: 0, released: 0, restocked: 0, holds: [] }; this.variants.set(label, v); }
    return v;
  }

  /** Apply one movement. ts = ISO string or ms. */
  apply(label, oldStock, newStock, ts) {
    if (oldStock == null || newStock == null || oldStock === newStock) return;
    const t = typeof ts === 'number' ? ts : Date.parse(ts);
    const v = this._v(label);
    if (newStock < oldStock) {
      const qty = oldStock - newStock;
      v.out += qty;
      v.holds.push({ t, qty });
    } else {
      let inc = newStock - oldStock;
      // release the most recent open holds first, inside the window
      for (let i = v.holds.length - 1; i >= 0 && inc > 0; i--) {
        const h = v.holds[i];
        if (t - h.t > RELEASE_WINDOW_MS) break;
        const take = Math.min(h.qty, inc);
        h.qty -= take; inc -= take; v.released += take;
      }
      v.holds = v.holds.filter(h => h.qty > 0);
      v.restocked += inc;
    }
    // drop holds that are too old to be released (they are confirmed sold)
    const cutoff = t - RELEASE_WINDOW_MS;
    if (v.holds.length && v.holds[0].t < cutoff) v.holds = v.holds.filter(h => h.t >= cutoff);
  }

  /**
   * Movement that happened while we were not polling (bot paused / offline).
   * Only the net difference is known: a drop counts straight away as sold
   * (no hold: it is already older than we can judge), a rise counts as units
   * that came back (unpaid checkouts), the same net logic the PDF report uses.
   */
  applyGap(label, oldStock, newStock) {
    if (oldStock == null || newStock == null || oldStock === newStock) return;
    const v = this._v(label);
    if (newStock < oldStock) v.out += oldStock - newStock;
    else v.released += newStock - oldStock;
  }

  summary(prices = {}, now = Date.now()) {
    let sold = 0, pending = 0, out = 0, released = 0, restocked = 0, omset = 0, priced = true;
    const perVariant = [];
    for (const [label, v] of this.variants) {
      const p = v.holds.filter(h => now - h.t <= RELEASE_WINDOW_MS).reduce((s, h) => s + h.qty, 0);
      const s = v.out - v.released;
      const price = prices[label] ?? null;
      if (s > 0 && price == null) priced = false;
      sold += s; pending += p; out += v.out; released += v.released; restocked += v.restocked;
      omset += s * (price ?? 0);
      perVariant.push({ label, sold: s, pending: p, out: v.out, released: v.released, restocked: v.restocked, price });
    }
    return { sold, pending, out, released, restocked, omset, priced, perVariant };
  }
}
