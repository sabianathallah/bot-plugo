import { EventEmitter } from 'events';
import { detectPlugoEndpoint, isCollectionUrl, scanCollectionPage } from '../../src/detector.js';
import { StockPoller } from '../../src/poller.js';
import {
  createProject, renameProject as dbRenameProject, deleteProject as dbDeleteProject,
  setProjectIntervalMs as dbSetInterval, setProjectPaused as dbSetPaused,
  getAllProjects, getProjectById, getProductsByProject,
  upsertSource, updateSourceStatus, getSourcesByProject, getAllSources, deleteSource,
  saveProduct, updateProductName, deleteProduct,
  getAllProducts, saveSnapshot, saveChanges, getExportData,
  getCompressedHistory, getProductChanges, getLastSnapshot, getProductMeta, saveProductMeta, saveOrderEvent,
  getRecentActivity, getExportChanges, getExportOrders,
} from './db.js';
import { SalesTracker } from './sales.js';

const HISTORY_MAX = 500;
const stripVariants = (vs) => (vs ?? []).map(v => ({ label: v.label, stock: v.stock }));
const sameStock = (a, b) => !!a && !!b && a.length === b.length &&
  a.every((x, i) => x.label === b[i].label && x.stock === b[i].stock);

// Append to history, collapsing runs of identical stock into their endpoints
function pushHistory(history, timestamp, variants) {
  const v = stripVariants(variants);
  const n = history.length;
  if (n >= 2 && sameStock(history[n - 1].variants, v) && sameStock(history[n - 2].variants, v)) {
    history[n - 1] = { timestamp, variants: v };
  } else {
    history.push({ timestamp, variants: v });
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  }
}

// Poll collection for NEW products (drops). Override with WATCHER_INTERVAL_MS env.
const WATCHER_INTERVAL_MS = parseInt(process.env.WATCHER_INTERVAL_MS ?? '5000', 10);

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);

    // projectId → { id, name, intervalMs, sources: [{url, status}], products: Map<url, ProductEntry> }
    this.projects = new Map();

    // flat url → projectId (for quick lookup)
    this._urlToProject = new Map();

    // collection url → intervalId (pre-drop watchers)
    this._watchers = new Map();
  }

  // ── Serialise state for WS init ───────────────────────────────────────────
  getState() {
    return {
      activities: this._recentActivities(),
      projects: [...this.projects.values()].map(p => this._serializeProject(p)),
    };
  }

  _recentActivities(limit = 300) {
    const { changes, orders } = getRecentActivity(limit);
    const groups = new Map(); // `${url}|${ts}` → activity
    const add = (url, name, projectId, ts, change) => {
      const key = `${url}|${ts}`;
      if (!groups.has(key)) groups.set(key, { id: key, timestamp: ts, productName: name, productUrl: url, projectId, changes: [] });
      groups.get(key).changes.push(change);
    };
    for (const c of changes) {
      const price = this._priceOf(c.url, c.variant);
      add(c.url, c.name, c.project_id, c.occurred_at,
        { label: c.variant, oldStock: c.old_stock, newStock: c.new_stock, type: c.change_type, price });
    }
    for (const o of orders) {
      add(o.url, o.name, o.project_id, o.occurred_at,
        { label: 'ORDERS', oldStock: o.old_orders, newStock: o.new_orders, type: 'order' });
    }
    return [...groups.values()]
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, limit);
  }

  _priceOf(url, label) {
    const projectId = this._urlToProject.get(url);
    const e = projectId != null ? this.projects.get(projectId)?.products.get(url) : null;
    return e?.prices?.[label] ?? null;
  }

  // ── Boot: restore everything from DB ─────────────────────────────────────
  async resumeFromDb() {
    const dbProjects = getAllProjects();
    if (dbProjects.length === 0) return;

    console.log(`[bot] Resuming ${dbProjects.length} project(s) from DB…`);

    for (const dbProject of dbProjects) {
      const project = this._initProject(dbProject.id, dbProject.name, dbProject.interval_ms ?? 5000);
      project.paused = !!dbProject.paused;

      const sources  = getSourcesByProject(dbProject.id);
      const products = getProductsByProject(dbProject.id);

      // Seed sources
      for (const src of sources) {
        project.sources.push({ url: src.url, status: src.status });
      }

      // Seed products
      const monitoringPromises = [];
      for (const { url, name } of products) {
        this._seedProduct(url, name, dbProject.id, project);
        if (project.paused) { // paused: show data, don't poll
          const e = project.products.get(url);
          if (e) { e.status = 'paused'; e.variants = e.history.at(-1)?.variants ?? []; }
          continue;
        }
        this.emit('product:detecting', { projectId: dbProject.id, productUrl: url });
        monitoringPromises.push(this._startMonitoring(url, dbProject.id));
      }
      await Promise.allSettled(monitoringPromises);

      if (project.paused) {
        console.log(`[bot] Project "${dbProject.name}" is paused — not polling`);
        continue;
      }

      // Always watch every source for newly launched products
      for (const src of sources) {
        this._startWatcher(src.url, dbProject.id);
      }
    }
  }

  // ── Create or find a project by collection URL (main entry point from UI) ─
  async addCollectionToProject(collectionUrl, existingProjectId = null) {
    const url = collectionUrl.trim();

    // Determine project
    let projectId = existingProjectId;
    let project;

    if (projectId && this.projects.has(projectId)) {
      project = this.projects.get(projectId);
    } else {
      // Check if a project for this domain already exists
      const host = new URL(url).hostname.replace(/^www\./, '');
      const existing = [...this.projects.values()].find(p =>
        p.sources.some(s => new URL(s.url).hostname.replace(/^www\./, '') === host)
      );

      if (existing) {
        project   = existing;
        projectId = existing.id;
      } else {
        // Auto-create project from domain
        const name = host.split('.')[0]
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        const dbProject = createProject(name);
        projectId = dbProject.id;
        project   = this._initProject(projectId, name, dbProject.interval_ms ?? 5000);
        this.emit('project:added', { id: projectId, name, sources: [], products: [] });
      }
    }

    // Register source
    upsertSource(projectId, url, 'watching');
    if (!project.sources.find(s => s.url === url)) {
      project.sources.push({ url, status: 'watching' });
    }
    this.emit('project:updated', this._serializeProject(project));

    // Try scanning now
    const found = await this._scanAndAdd(url, projectId, project);

    // Always keep watching for new products (drops), even if some already exist
    this._startWatcher(url, projectId);

    return { projectId, found };
  }

  // ── Scan a collection URL and add all products found ──────────────────────
  async _scanAndAdd(collectionUrl, projectId, project) {
    let productUrls;
    try {
      productUrls = await scanCollectionPage(collectionUrl);
    } catch (err) {
      this.emit('source:error', { projectId, collectionUrl, error: err.message });
      return 0;
    }

    const src = project.sources.find(s => s.url === collectionUrl);

    if (productUrls.length === 0) {
      // Only notify once when entering 'watching' state (avoid toast spam)
      if (src && src.status !== 'watching') {
        src.status = 'watching';
        updateSourceStatus(collectionUrl, 'watching');
      }
      if (!this._watchers.has(collectionUrl)) {
        this.emit('source:watching', { projectId, collectionUrl });
      }
      return 0;
    }

    if (!src || src.status !== 'active') {
      updateSourceStatus(collectionUrl, 'active');
      if (src) src.status = 'active';
    }

    // Dedupe by Plugo product id — the same product can appear under different slugs
    const pid = (u) => (u.match(/\/products\/(\d+)/) ?? [])[1];
    const knownIds = new Set([...this._urlToProject.keys()].map(pid).filter(Boolean));

    let added = 0;
    for (const url of productUrls) {
      const id = pid(url);
      if (id && knownIds.has(id)) continue;
      if (id) knownIds.add(id);
      if (!this._urlToProject.has(url)) {
        saveProduct(url, null, projectId);
        this._seedProduct(url, url, projectId, project);
        this.emit('product:detecting', { projectId, productUrl: url });
        this._startMonitoring(url, projectId).catch(() => {});
        added++;
      }
    }
    if (added > 0) {
      this.emit('source:found', { projectId, collectionUrl, count: added });
    }
    return added;
  }

  // ── Re-scan a source URL and add any new products found ──────────────────
  async rescanSource(projectId, collectionUrl) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');
    const added = await this._scanAndAdd(collectionUrl, projectId, project);
    this.emit('project:updated', this._serializeProject(project));
    return { added };
  }

  // ── Pre-drop watcher — poll collection URL every 30s until products appear─
  _startWatcher(collectionUrl, projectId) {
    if (this._watchers.has(collectionUrl)) return;
    console.log(`[bot] Watching ${collectionUrl} for drop…`);

    let busy = false;
    const timer = setInterval(async () => {
      const project = this.projects.get(projectId);
      if (!project || !project.sources.some(s => s.url === collectionUrl)) {
        clearInterval(timer); this._watchers.delete(collectionUrl); return;
      }
      if (busy) return; // skip tick if previous scan still running
      busy = true;
      try {
        const found = await this._scanAndAdd(collectionUrl, projectId, project);
        if (found > 0) {
          console.log(`[bot] Drop detected at ${collectionUrl} — ${found} new product(s) added`);
          this.emit('project:updated', this._serializeProject(project));
        }
      } catch (err) {
        console.error(`[bot] watcher error ${collectionUrl}:`, err.message);
      } finally {
        busy = false;
      }
    }, WATCHER_INTERVAL_MS);

    this._watchers.set(collectionUrl, timer);
  }

  // ── Single product monitoring ─────────────────────────────────────────────
  async _startMonitoring(productUrl, projectId) {
    try {
      const result = await detectPlugoEndpoint(productUrl, () => {});
      if (!result) throw new Error('Not a Plugo store or no stock data found');

      const project = this.projects.get(projectId);
      if (!project) return;
      const entry = project.products.get(productUrl);
      if (!entry) return;
      if (project.paused) return; // paused while detecting

      const { apiUrl, initial } = result;
      entry.productName = initial.productName;
      entry.variants    = initial.variants;
      entry.status      = 'monitoring';
      this._updateMeta(productUrl, entry, initial, new Date().toISOString());

      updateProductName(productUrl, initial.productName);
      const now = new Date().toISOString();
      // Resume after a pause/restart: record what moved while we were not polling,
      // otherwise the first poll silently becomes the new baseline.
      const before = new Map(getLastSnapshot(productUrl).map(r => [r.variant, r.stock]));
      const gap = before.size === 0 ? [] : initial.variants
        .filter(v => before.has(v.label) && before.get(v.label) !== v.stock)
        .map(v => ({ label: v.label, oldStock: before.get(v.label), newStock: v.stock, type: 'gap' }));
      if (gap.length) {
        saveChanges(productUrl, gap, now);
        for (const c of gap) entry.sales.applyGap(c.label, c.oldStock, c.newStock);
        console.log(`[bot] ${initial.productName}: ${gap.length} variant(s) moved during the gap`);
      }
      saveSnapshot(productUrl, initial.variants, now);
      pushHistory(entry.history, now, initial.variants);

      this.emit('product:added', {
        projectId,
        productUrl,
        productName: initial.productName,
        variants:    initial.variants,
        history:     entry.history,
        stats:       this._stats(entry),
      });

      const intervalMs = this.projects.get(projectId)?.intervalMs ?? 5000;
      const poller = new StockPoller({ productUrl, apiUrl, initial, intervalMs });

      poller.on('update', ({ data, changes, timestamp }) => {
        const proj = this.projects.get(projectId);
        if (!proj) return;
        const e = proj.products.get(productUrl);
        if (!e) return;

        const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
        e.productName = data.productName;
        e.variants    = data.variants;
        e.error       = null;
        pushHistory(e.history, ts, data.variants);

        saveSnapshot(productUrl, data.variants, ts);
        if (changes.length > 0) saveChanges(productUrl, changes, ts);
        for (const c of changes) e.sales.apply(c.label, c.oldStock, c.newStock, ts);
        const orderChange = this._updateMeta(productUrl, e, data, ts);

        const priced = changes.map(c => ({ ...c, price: e.prices?.[c.label] ?? null }));
        this.emit('stock:update', {
          projectId, productUrl, productName: data.productName, variants: data.variants,
          changes: priced, orderChange, timestamp: ts, stats: this._stats(e),
        });
      });

      poller.on('error', ({ error }) => {
        const e = project?.products.get(productUrl);
        if (e) e.error = error;
        this.emit('product:error', { projectId, productUrl, error });
      });

      poller.start();
      entry.poller = poller;

    } catch (err) {
      const project = this.projects.get(projectId);
      const entry   = project?.products.get(productUrl);
      if (entry) { entry.status = 'error'; entry.error = err.message; }
      this.emit('product:error', { projectId, productUrl, error: err.message });
    }
  }

  // ── Project management ────────────────────────────────────────────────────
  setProjectInterval(projectId, intervalMs) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');
    dbSetInterval(projectId, intervalMs);
    project.intervalMs = intervalMs;
    // Apply to all running pollers immediately
    for (const entry of project.products.values()) {
      entry.poller?.setIntervalMs(intervalMs);
    }
    this.emit('project:updated', this._serializeProject(project));
  }

  // Pause: stop all pollers + watchers but keep data. Persisted across restarts.
  setProjectPaused(projectId, paused) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');
    dbSetPaused(projectId, paused);
    project.paused = !!paused;
    if (paused) {
      for (const entry of project.products.values()) {
        entry.poller?.stop(); entry.poller = null; entry.status = 'paused';
      }
      for (const src of project.sources) {
        const timer = this._watchers.get(src.url);
        if (timer) { clearInterval(timer); this._watchers.delete(src.url); }
      }
    } else {
      for (const url of project.products.keys()) this._startMonitoring(url, projectId);
      for (const src of project.sources) this._startWatcher(src.url, projectId);
    }
    this.emit('project:updated', this._serializeProject(project));
  }

  renameProject(projectId, name) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');
    dbRenameProject(projectId, name);
    project.name = name;
    this.emit('project:updated', this._serializeProject(project));
  }

  removeProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    // Stop all pollers
    for (const entry of project.products.values()) {
      entry.poller?.stop();
    }

    // Stop all watchers for this project's sources
    for (const src of project.sources) {
      const timer = this._watchers.get(src.url);
      if (timer) { clearInterval(timer); this._watchers.delete(src.url); }
    }

    // Clean up maps
    for (const url of project.products.keys()) {
      this._urlToProject.delete(url);
      deleteProduct(url);
    }
    for (const src of project.sources) deleteSource(src.url);

    dbDeleteProject(projectId);
    this.projects.delete(projectId);
    this.emit('project:removed', { projectId });
  }

  removeProduct(productUrl) {
    const projectId = this._urlToProject.get(productUrl);
    const project   = projectId != null ? this.projects.get(projectId) : null;
    const entry     = project?.products.get(productUrl);

    entry?.poller?.stop();
    project?.products.delete(productUrl);
    this._urlToProject.delete(productUrl);
    deleteProduct(productUrl);

    if (project) this.emit('project:updated', this._serializeProject(project));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  _initProject(id, name, intervalMs = 5000) {
    const project = { id, name, intervalMs, sources: [], products: new Map() };
    this.projects.set(id, project);
    return project;
  }

  _seedProduct(url, name, projectId, project) {
    this._urlToProject.set(url, projectId);
    const meta  = getProductMeta(url) ?? { prices: {}, numOrders: null, numOrdersFirst: null };
    const sales = new SalesTracker();
    for (const c of getProductChanges(url)) {
      if (c.change_type === 'gap') sales.applyGap(c.variant, c.old_stock, c.new_stock);
      else sales.apply(c.variant, c.old_stock, c.new_stock, c.occurred_at);
    }
    project.products.set(url, {
      productName:    name,
      variants:       [],
      history:        getCompressedHistory(url, HISTORY_MAX),
      status:         'detecting',
      error:          null,
      poller:         null,
      prices:         meta.prices ?? {},
      numOrders:      meta.numOrders,
      numOrdersFirst: meta.numOrdersFirst,
      sales,
    });
  }

  // Persist price per variant + Plugo numOrders; returns {old,new} when orders moved
  _updateMeta(url, entry, data, ts) {
    let dirty = false;
    for (const v of data.variants ?? []) {
      if (v.price != null && entry.prices[v.label] !== v.price) { entry.prices[v.label] = v.price; dirty = true; }
    }
    let orderChange = null;
    if (typeof data.numOrders === 'number' && data.numOrders !== entry.numOrders) {
      if (entry.numOrders != null) {
        orderChange = { old: entry.numOrders, new: data.numOrders };
        saveOrderEvent(url, entry.numOrders, data.numOrders, ts);
      }
      entry.numOrders = data.numOrders;
      if (entry.numOrdersFirst == null) entry.numOrdersFirst = data.numOrders;
      dirty = true;
    }
    if (dirty) saveProductMeta(url, entry.prices, entry.numOrders);
    return orderChange;
  }

  _stats(e) {
    const s     = e.sales.summary(e.prices ?? {});
    const price = Object.values(e.prices ?? {})[0] ?? null;
    // Plugo orders already on the product at the bot's first look were holding stock
    // before we saw it: count them as sold (same as the PDF report: stock + orders).
    // Ones that fail later return stock, which the tracker already subtracts.
    const soldInitial = e.numOrdersFirst ?? 0;
    return {
      ...s,
      soldTracked:    s.sold,
      soldInitial,
      sold:           s.sold + soldInitial,
      omset:          s.omset + soldInitial * (price ?? 0),
      numOrders:      e.numOrders ?? null,
      numOrdersFirst: e.numOrdersFirst ?? null,
      price,
    };
  }

  _serializeProject(project) {
    return {
      id:         project.id,
      name:       project.name,
      intervalMs: project.intervalMs,
      paused:     !!project.paused,
      sources:    project.sources,
      products: [...project.products.entries()].map(([url, e]) => ({
        productUrl:  url,
        productName: e.productName,
        variants:    e.variants,
        history:     e.history,
        status:      e.status,
        error:       e.error ?? null,
        stats:       this._stats(e),
      })),
    };
  }

  getExportData() {
    return getExportData();
  }

  getExportChanges() { return getExportChanges(); }
  getExportOrders()  { return getExportOrders(); }

  // One row per product: sales estimate + Plugo order counter
  getSummaryRows() {
    const rows = [];
    for (const p of this.projects.values()) {
      for (const [url, e] of p.products) {
        const s = this._stats(e);
        rows.push({
          project: p.name, product: e.productName, url, price: s.price,
          sold: s.sold, pending: s.pending, out: s.out, released: s.released, restocked: s.restocked,
          omset: s.omset, numOrders: s.numOrders, numOrdersFirst: s.numOrdersFirst,
          stockNow: (e.variants ?? []).reduce((a, v) => a + (v.stock ?? 0), 0),
        });
      }
    }
    return rows;
  }
}

const g = globalThis;
if (!g._botManager) {
  g._botManager = new BotManager();
  g._botManager.resumeFromDb().catch(e => console.error('[bot] resume error:', e));
}

export const botManager = g._botManager;
