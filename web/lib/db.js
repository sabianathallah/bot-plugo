import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const DB_PATH = path.join(ROOT, 'data', 'plugo.db');
// Data is never purged unless PLUGO_RETENTION_DAYS is set (> 0).
const RETENTION_DAYS = parseInt(process.env.PLUGO_RETENTION_DAYS ?? '0', 10);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    interval_ms  INTEGER NOT NULL DEFAULT 5000,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS project_sources (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url          TEXT    UNIQUE NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'watching',
    last_scanned TEXT,
    added_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT    UNIQUE NOT NULL,
    name        TEXT,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen   TEXT
  );

  CREATE TABLE IF NOT EXISTS stock_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    recorded_at TEXT    NOT NULL,
    variant     TEXT    NOT NULL,
    stock       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS change_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    occurred_at TEXT    NOT NULL,
    variant     TEXT    NOT NULL,
    old_stock   INTEGER,
    new_stock   INTEGER NOT NULL,
    change_type TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snap_product_time ON stock_snapshots(product_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_chg_product_time  ON change_events(product_id, occurred_at);
`);

// Safe column migrations
const productCols = db.pragma('table_info(products)').map((c) => c.name);
if (!productCols.includes('project_id')) {
  db.exec(`ALTER TABLE products ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_project ON products(project_id)`);
}
const projectCols = db.pragma('table_info(projects)').map((c) => c.name);
if (!projectCols.includes('interval_ms')) {
  db.exec(`ALTER TABLE projects ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 5000`);
}
const productCols2 = db.pragma('table_info(products)').map((c) => c.name);
if (!productCols2.includes('prices_json'))      db.exec(`ALTER TABLE products ADD COLUMN prices_json TEXT`);
if (!productCols2.includes('num_orders'))       db.exec(`ALTER TABLE products ADD COLUMN num_orders INTEGER`);
if (!productCols2.includes('num_orders_first')) db.exec(`ALTER TABLE products ADD COLUMN num_orders_first INTEGER`);
db.exec(`
  CREATE TABLE IF NOT EXISTS order_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    occurred_at TEXT    NOT NULL,
    old_orders  INTEGER,
    new_orders  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_product_time ON order_events(product_id, occurred_at);
  CREATE INDEX IF NOT EXISTS idx_chg_time ON change_events(occurred_at);
`);
if (!projectCols.includes('paused')) {
  db.exec(`ALTER TABLE projects ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`);
}

// ── Migrate existing products without project_id into per-domain projects ───
(function migrate() {
  const unassigned = db.prepare(
    `SELECT id, url FROM products WHERE project_id IS NULL`
  ).all();
  if (unassigned.length === 0) return;

  const byDomain = new Map();
  for (const { id, url } of unassigned) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (!byDomain.has(host)) byDomain.set(host, []);
      byDomain.get(host).push(id);
    } catch {}
  }

  const ensureProject = db.prepare(
    `INSERT OR IGNORE INTO projects (name) VALUES (?)`
  );
  const getProject    = db.prepare(`SELECT id FROM projects WHERE name = ?`);
  const assignProject = db.prepare(`UPDATE products SET project_id = ? WHERE id = ?`);

  db.transaction(() => {
    for (const [domain, ids] of byDomain) {
      const name = domain.split('.')[0]
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      ensureProject.run(name);
      const { id: projectId } = getProject.get(name);
      for (const pid of ids) assignProject.run(projectId, pid);
      console.log(`[db] migrated ${ids.length} product(s) → project "${name}"`);
    }
  })();
})();

// ── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  // projects
  insertProject:       db.prepare(`INSERT INTO projects (name) VALUES (?) RETURNING id, name, interval_ms, created_at`),
  renameProject:       db.prepare(`UPDATE projects SET name = ? WHERE id = ?`),
  setProjectInterval:  db.prepare(`UPDATE projects SET interval_ms = ? WHERE id = ?`),
  setProjectPaused:    db.prepare(`UPDATE projects SET paused = ? WHERE id = ?`),
  deleteProject:       db.prepare(`DELETE FROM projects WHERE id = ?`),
  getAllProjects:       db.prepare(`SELECT id, name, interval_ms, paused, created_at FROM projects ORDER BY created_at`),
  getProjectById:      db.prepare(`SELECT id, name, interval_ms, created_at FROM projects WHERE id = ?`),

  // project sources (collection URLs)
  upsertSource:      db.prepare(`
    INSERT INTO project_sources (project_id, url, status)
    VALUES (@projectId, @url, @status)
    ON CONFLICT(url) DO UPDATE SET project_id = excluded.project_id, status = excluded.status
  `),
  updateSourceStatus: db.prepare(`
    UPDATE project_sources SET status = @status, last_scanned = @lastScanned WHERE url = @url
  `),
  getSourcesByProject: db.prepare(`SELECT * FROM project_sources WHERE project_id = ? ORDER BY added_at`),
  getAllSources:        db.prepare(`SELECT * FROM project_sources ORDER BY added_at`),
  deleteSource:        db.prepare(`DELETE FROM project_sources WHERE url = ?`),

  // products
  upsertProduct: db.prepare(`
    INSERT INTO products (url, name, project_id) VALUES (@url, @name, @projectId)
    ON CONFLICT(url) DO UPDATE SET name = COALESCE(excluded.name, name), last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `),
  updateProductName: db.prepare(`
    UPDATE products SET name = @name, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE url = @url
  `),
  deleteProduct:    db.prepare(`DELETE FROM products WHERE url = ?`),
  getProductId:     db.prepare(`SELECT id FROM products WHERE url = ?`),
  getAllProducts:    db.prepare(`SELECT url, name, project_id FROM products ORDER BY created_at`),
  getProductsByProject: db.prepare(`SELECT url, name FROM products WHERE project_id = ? ORDER BY created_at`),

  // snapshots
  insertSnapshot: db.prepare(`
    INSERT INTO stock_snapshots (product_id, recorded_at, variant, stock)
    VALUES (@productId, @recordedAt, @variant, @stock)
  `),
  getHistory: db.prepare(`
    SELECT recorded_at, variant, stock
    FROM   stock_snapshots
    WHERE  product_id = (SELECT id FROM products WHERE url = ?)
    ORDER  BY recorded_at ASC
  `),
  purgeOldSnapshots: db.prepare(`
    DELETE FROM stock_snapshots
    WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-${Math.max(RETENTION_DAYS, 1)} days')
  `),
  edgeSnapshot: (which) => db.prepare(`
    SELECT recorded_at, variant, stock FROM stock_snapshots
    WHERE product_id = @pid AND recorded_at = (
      SELECT ${which}(recorded_at) FROM stock_snapshots WHERE product_id = @pid)
  `),
  changesForProduct: db.prepare(`
    SELECT occurred_at, variant, old_stock, new_stock FROM change_events
    WHERE product_id = ? ORDER BY id ASC
  `),
  changeTotals: db.prepare(`
    SELECT variant,
           SUM(CASE WHEN new_stock < old_stock THEN old_stock - new_stock ELSE 0 END) AS out_units,
           SUM(CASE WHEN new_stock > old_stock THEN new_stock - old_stock ELSE 0 END) AS back_units
    FROM change_events WHERE product_id = ? AND old_stock IS NOT NULL GROUP BY variant
  `),
  getMeta: db.prepare(`SELECT prices_json, num_orders, num_orders_first FROM products WHERE url = ?`),
  setMeta: db.prepare(`
    UPDATE products SET prices_json = @prices, num_orders = @numOrders,
           num_orders_first = COALESCE(num_orders_first, @numOrders)
    WHERE url = @url
  `),
  insertOrderEvent: db.prepare(`
    INSERT INTO order_events (product_id, occurred_at, old_orders, new_orders)
    VALUES (@productId, @occurredAt, @oldOrders, @newOrders)
  `),
  recentChanges: db.prepare(`
    SELECT c.occurred_at, c.variant, c.old_stock, c.new_stock, c.change_type,
           p.url, p.name, p.project_id
    FROM change_events c JOIN products p ON p.id = c.product_id
    ORDER BY c.id DESC LIMIT ?
  `),
  recentOrders: db.prepare(`
    SELECT o.occurred_at, o.old_orders, o.new_orders, p.url, p.name, p.project_id
    FROM order_events o JOIN products p ON p.id = o.product_id
    ORDER BY o.id DESC LIMIT ?
  `),
  exportChanges: db.prepare(`
    SELECT c.occurred_at AS timestamp, pr.name AS project_name, p.name AS product_name,
           c.variant, c.old_stock, c.new_stock, c.new_stock - c.old_stock AS delta, c.change_type
    FROM change_events c JOIN products p ON p.id = c.product_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    ORDER BY c.id ASC
  `),
  exportOrders: db.prepare(`
    SELECT o.occurred_at AS timestamp, pr.name AS project_name, p.name AS product_name,
           o.old_orders, o.new_orders, o.new_orders - o.old_orders AS delta
    FROM order_events o JOIN products p ON p.id = o.product_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    ORDER BY o.id ASC
  `),

  // change events
  insertChange: db.prepare(`
    INSERT INTO change_events (product_id, occurred_at, variant, old_stock, new_stock, change_type)
    VALUES (@productId, @occurredAt, @variant, @oldStock, @newStock, @changeType)
  `),

  // export
  exportSnapshots: db.prepare(`
    SELECT s.recorded_at AS timestamp, p.name AS product_name, p.url AS product_url,
           pr.name AS project_name, s.variant, s.stock
    FROM   stock_snapshots s
    JOIN   products p  ON p.id  = s.product_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    ORDER  BY s.recorded_at DESC
  `),
};

// Batch snapshot insert
const insertSnapshotsBatch = db.transaction((productId, recordedAt, variants) => {
  for (const { label, stock } of variants) {
    stmts.insertSnapshot.run({ productId, recordedAt, variant: label, stock });
  }
});

// ── Public API ───────────────────────────────────────────────────────────────

// Projects
export function createProject(name) {
  return stmts.insertProject.get(name);
}
export function renameProject(id, name) {
  stmts.renameProject.run(name, id);
}
export function setProjectIntervalMs(id, intervalMs) {
  stmts.setProjectInterval.run(intervalMs, id);
}
export function setProjectPaused(id, paused) {
  stmts.setProjectPaused.run(paused ? 1 : 0, id);
}
export function deleteProject(id) {
  stmts.deleteProject.run(id);
}
export function getAllProjects() {
  return stmts.getAllProjects.all();
}
export function getProjectById(id) {
  return stmts.getProjectById.get(id);
}

// Sources
export function upsertSource(projectId, url, status = 'watching') {
  stmts.upsertSource.run({ projectId, url, status });
}
export function updateSourceStatus(url, status) {
  stmts.updateSourceStatus.run({ url, status, lastScanned: new Date().toISOString() });
}
export function getSourcesByProject(projectId) {
  return stmts.getSourcesByProject.all(projectId);
}
export function getAllSources() {
  return stmts.getAllSources.all();
}
export function deleteSource(url) {
  stmts.deleteSource.run(url);
}

// Products
export function saveProduct(url, name, projectId) {
  stmts.upsertProduct.run({ url, name: name ?? url, projectId: projectId ?? null });
}
export function updateProductName(url, name) {
  stmts.updateProductName.run({ url, name });
}
export function deleteProduct(url) {
  stmts.deleteProduct.run(url);
}
export function getAllProducts() {
  return stmts.getAllProducts.all();
}
export function getProductsByProject(projectId) {
  return stmts.getProductsByProject.all(projectId);
}

// Snapshots
export function saveSnapshot(url, variants, timestamp) {
  const row = stmts.getProductId.get(url);
  if (!row) return;
  const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  insertSnapshotsBatch(row.id, ts, variants);
}
export function saveChanges(url, changes, timestamp) {
  const row = stmts.getProductId.get(url);
  if (!row) return;
  const ts = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  for (const c of changes) {
    stmts.insertChange.run({
      productId:  row.id,
      occurredAt: ts,
      variant:    c.label,
      oldStock:   c.oldStock ?? null,
      newStock:   c.newStock,
      changeType: c.type,
    });
  }
}
export function getHistory(url) {
  return stmts.getHistory.all(url);
}

const firstSnap = stmts.edgeSnapshot('MIN');
const lastSnap  = stmts.edgeSnapshot('MAX');

/**
 * Compressed history: first snapshot, then one point per stock change, then
 * the latest snapshot. Cheap to build (uses change_events, not every poll).
 */
export function getCompressedHistory(url, limit = 500) {
  const row = stmts.getProductId.get(url);
  if (!row) return [];
  const first = firstSnap.all({ pid: row.id });
  if (first.length === 0) return [];

  const cur = new Map(first.map(r => [r.variant, r.stock]));
  const snap = () => [...cur].map(([label, stock]) => ({ label, stock }));
  const out = [{ timestamp: first[0].recorded_at, variants: snap() }];

  let pendingTs = null;
  for (const c of stmts.changesForProduct.all(row.id)) {
    if (c.occurred_at < first[0].recorded_at) continue;
    if (pendingTs && c.occurred_at !== pendingTs) out.push({ timestamp: pendingTs, variants: snap() });
    cur.set(c.variant, c.new_stock);
    pendingTs = c.occurred_at;
  }
  if (pendingTs) out.push({ timestamp: pendingTs, variants: snap() });

  const last = lastSnap.all({ pid: row.id });
  if (last.length) out.push({ timestamp: last[0].recorded_at, variants: last.map(r => ({ label: r.variant, stock: r.stock })) });
  return out.slice(-limit);
}

// Units that left (stock decreases) and came back (increases) per variant
export function getChangeTotals(url) {
  const row = stmts.getProductId.get(url);
  if (!row) return [];
  return stmts.changeTotals.all(row.id);
}

export function getProductChanges(url) {
  const row = stmts.getProductId.get(url);
  return row ? stmts.changesForProduct.all(row.id) : [];
}

export function getProductMeta(url) {
  const m = stmts.getMeta.get(url);
  if (!m) return null;
  let prices = {};
  try { prices = m.prices_json ? JSON.parse(m.prices_json) : {}; } catch {}
  return { prices, numOrders: m.num_orders, numOrdersFirst: m.num_orders_first };
}

export function saveProductMeta(url, prices, numOrders) {
  stmts.setMeta.run({ url, prices: JSON.stringify(prices ?? {}), numOrders: numOrders ?? null });
}

export function saveOrderEvent(url, oldOrders, newOrders, timestamp) {
  const row = stmts.getProductId.get(url);
  if (!row) return;
  stmts.insertOrderEvent.run({ productId: row.id, occurredAt: timestamp, oldOrders, newOrders });
}

export function getRecentActivity(limit = 300) {
  return { changes: stmts.recentChanges.all(limit), orders: stmts.recentOrders.all(limit) };
}

export function getExportChanges() { return stmts.exportChanges.all(); }
export function getExportOrders()  { return stmts.exportOrders.all(); }

// Purge & export
export function purgeOldData() {
  if (!(RETENTION_DAYS > 0)) return;
  const { changes } = stmts.purgeOldSnapshots.run();
  if (changes > 0) console.log(`[db] purged ${changes} old snapshot rows`);
}
export function getExportData() {
  return stmts.exportSnapshots.all();
}

// Purge job every 6 hours
setInterval(purgeOldData, 6 * 60 * 60 * 1000).unref();
purgeOldData();

export { db };
