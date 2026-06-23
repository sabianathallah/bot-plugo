import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const DB_PATH = path.join(ROOT, 'data', 'plugo.db');
const RETENTION_DAYS = 7;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
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

// Add project_id to products if it doesn't exist yet (safe migration)
const productCols = db.pragma('table_info(products)').map((c) => c.name);
if (!productCols.includes('project_id')) {
  db.exec(`ALTER TABLE products ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_products_project ON products(project_id)`);
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
  insertProject:  db.prepare(`INSERT INTO projects (name) VALUES (?) RETURNING id, name, created_at`),
  renameProject:  db.prepare(`UPDATE projects SET name = ? WHERE id = ?`),
  deleteProject:  db.prepare(`DELETE FROM projects WHERE id = ?`),
  getAllProjects:  db.prepare(`SELECT id, name, created_at FROM projects ORDER BY created_at`),
  getProjectById: db.prepare(`SELECT id, name, created_at FROM projects WHERE id = ?`),

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
    WHERE recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-${RETENTION_DAYS} days')
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

// Purge & export
export function purgeOldData() {
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
