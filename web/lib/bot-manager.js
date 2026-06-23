import { EventEmitter } from 'events';
import { detectPlugoEndpoint, isCollectionUrl, scanCollectionPage } from '../../src/detector.js';
import { StockPoller } from '../../src/poller.js';
import {
  createProject, renameProject as dbRenameProject, deleteProject as dbDeleteProject,
  setProjectIntervalMs as dbSetInterval,
  getAllProjects, getProjectById, getProductsByProject,
  upsertSource, updateSourceStatus, getSourcesByProject, getAllSources, deleteSource,
  saveProduct, updateProductName, deleteProduct,
  getAllProducts, saveSnapshot, saveChanges, getHistory, getExportData,
} from './db.js';

const WATCHER_INTERVAL_MS = 30_000; // poll collection page every 30s pre-drop

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
      projects: [...this.projects.values()].map(p => ({
        id:         p.id,
        name:       p.name,
        intervalMs: p.intervalMs,
        sources:    p.sources,
        products:   [...p.products.entries()].map(([url, e]) => ({
          productUrl:  url,
          productName: e.productName,
          variants:    e.variants,
          history:     e.history.slice(-100),
          status:      e.status,
          error:       e.error ?? null,
        })),
      })),
    };
  }

  // ── Boot: restore everything from DB ─────────────────────────────────────
  async resumeFromDb() {
    const dbProjects = getAllProjects();
    if (dbProjects.length === 0) return;

    console.log(`[bot] Resuming ${dbProjects.length} project(s) from DB…`);

    for (const dbProject of dbProjects) {
      const project = this._initProject(dbProject.id, dbProject.name, dbProject.interval_ms ?? 5000);

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
        this.emit('product:detecting', { projectId: dbProject.id, productUrl: url });
        monitoringPromises.push(this._startMonitoring(url, dbProject.id));
      }
      await Promise.allSettled(monitoringPromises);

      // Resume watchers for sources still in 'watching' state
      for (const src of sources) {
        if (src.status === 'watching') {
          this._startWatcher(src.url, dbProject.id);
        }
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
      // Auto-create project from domain
      const host = new URL(url).hostname.replace(/^www\./, '');
      const name = host.split('.')[0]
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

      const dbProject = createProject(name);
      projectId = dbProject.id;
      project   = this._initProject(projectId, name, dbProject.interval_ms ?? 5000);
      this.emit('project:added', { id: projectId, name, sources: [], products: [] });
    }

    // Register source
    upsertSource(projectId, url, 'watching');
    if (!project.sources.find(s => s.url === url)) {
      project.sources.push({ url, status: 'watching' });
    }
    this.emit('project:updated', this._serializeProject(project));

    // Try scanning now
    const found = await this._scanAndAdd(url, projectId, project);

    if (found === 0) {
      // No products yet — start pre-drop watcher
      this._startWatcher(url, projectId);
    }

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

    if (productUrls.length === 0) {
      this.emit('source:watching', { projectId, collectionUrl });
      return 0;
    }

    updateSourceStatus(collectionUrl, 'active');
    const src = project.sources.find(s => s.url === collectionUrl);
    if (src) src.status = 'active';

    this.emit('source:found', { projectId, collectionUrl, count: productUrls.length });

    let added = 0;
    for (const url of productUrls) {
      if (!this._urlToProject.has(url)) {
        saveProduct(url, null, projectId);
        this._seedProduct(url, url, projectId, project);
        this.emit('product:detecting', { projectId, productUrl: url });
        this._startMonitoring(url, projectId).catch(() => {});
        added++;
      }
    }
    return added;
  }

  // ── Pre-drop watcher — poll collection URL every 30s until products appear─
  _startWatcher(collectionUrl, projectId) {
    if (this._watchers.has(collectionUrl)) return;
    console.log(`[bot] Watching ${collectionUrl} for drop…`);

    const timer = setInterval(async () => {
      const project = this.projects.get(projectId);
      if (!project) { clearInterval(timer); this._watchers.delete(collectionUrl); return; }

      const found = await this._scanAndAdd(collectionUrl, projectId, project);
      if (found > 0) {
        console.log(`[bot] Drop detected at ${collectionUrl} — ${found} product(s) added`);
        clearInterval(timer);
        this._watchers.delete(collectionUrl);
        this.emit('project:updated', this._serializeProject(project));
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

      const { apiUrl, initial } = result;
      entry.productName = initial.productName;
      entry.variants    = initial.variants;
      entry.status      = 'monitoring';

      updateProductName(productUrl, initial.productName);
      const now = new Date().toISOString();
      saveSnapshot(productUrl, initial.variants, now);
      if (entry.history.length === 0) {
        entry.history.push({ timestamp: now, variants: initial.variants });
      }

      this.emit('product:added', {
        projectId,
        productUrl,
        productName: initial.productName,
        variants:    initial.variants,
        history:     entry.history,
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
        e.history.push({ timestamp: ts, variants: data.variants });
        if (e.history.length > 200) e.history = e.history.slice(-200);

        saveSnapshot(productUrl, data.variants, ts);
        if (changes.length > 0) saveChanges(productUrl, changes, ts);

        this.emit('stock:update', { projectId, productUrl, productName: data.productName, variants: data.variants, changes, timestamp: ts });
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
    project.products.set(url, {
      productName: name,
      variants:    [],
      history:     this._loadHistory(url),
      status:      'detecting',
      error:       null,
      poller:      null,
    });
  }

  _loadHistory(url) {
    const rows = getHistory(url);
    if (rows.length === 0) return [];
    const byTime = new Map();
    for (const { recorded_at, variant, stock } of rows) {
      if (!byTime.has(recorded_at)) byTime.set(recorded_at, []);
      byTime.get(recorded_at).push({ label: variant, stock });
    }
    return [...byTime.entries()].slice(-100).map(([timestamp, variants]) => ({ timestamp, variants }));
  }

  _serializeProject(project) {
    return {
      id:         project.id,
      name:       project.name,
      intervalMs: project.intervalMs,
      sources:    project.sources,
      products: [...project.products.entries()].map(([url, e]) => ({
        productUrl:  url,
        productName: e.productName,
        variants:    e.variants,
        history:     e.history.slice(-100),
        status:      e.status,
        error:       e.error ?? null,
      })),
    };
  }

  getExportData() {
    return getExportData();
  }
}

const g = globalThis;
if (!g._botManager) {
  g._botManager = new BotManager();
  g._botManager.resumeFromDb().catch(e => console.error('[bot] resume error:', e));
}

export const botManager = g._botManager;
