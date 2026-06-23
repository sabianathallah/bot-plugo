import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const DB_PATH = path.join(ROOT, 'data', 'plugo.db');

const RETENTION_DAYS = 7;

// ── Open & configure ────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');   // concurrent reads while writing
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL'); // safe + fast enough

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
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

// ── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  upsertProduct: db.prepare(`
    INSERT INTO products (url, name) VALUES (@url, @name)
    ON CONFLICT(url) DO UPDATE SET name = excluded.name, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `),

  updateProductName: db.prepare(`
    UPDATE products SET name = @name, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE url = @url
  `),

  deleteProduct: db.prepare(`DELETE FROM products WHERE url = ?`),

  getProductId: db.prepare(`SELECT id FROM products WHERE url = ?`),

  getAllProducts: db.prepare(`SELECT url, name FROM products ORDER BY created_at`),

  insertSnapshots: db.prepare(`
    INSERT INTO stock_snapshots (product_id, recorded_at, variant, stock)
    VALUES (@productId, @recordedAt, @variant, @stock)
  `),

  insertChange: db.prepare(`
    INSERT INTO change_events (product_id, occurred_at, variant, old_stock, new_stock, change_type)
    VALUES (@productId, @occurredAt, @variant, @oldStock, @newStock, @changeType)
  `),

  getHistory: db.prepare(`
    SELECT recorded_at, variant, stock
    FROM   stock_snapshots
    WHERE  product_id = (SELECT id FROM products WHERE url = ?)
    ORDER  BY recorded_at ASC
  `),

  purgeOldSnapshots: db.prepare(`
    DELETE FROM stock_snapshots
    WHERE  recorded_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-${RETENTION_DAYS} days')
  `),

  exportAll: db.prepare(`
    SELECT
      s.recorded_at  AS timestamp,
      p.name         AS product_name,
      p.url          AS product_url,
      s.variant,
      s.stock
    FROM   stock_snapshots s
    JOIN   products p ON p.id = s.product_id
    ORDER  BY s.recorded_at DESC
  `),

  exportChanges: db.prepare(`
    SELECT
      c.occurred_at  AS timestamp,
      p.name         AS product_name,
      p.url          AS product_url,
      c.variant,
      c.old_stock,
      c.new_stock,
      c.change_type
    FROM   change_events c
    JOIN   products p ON p.id = c.product_id
    ORDER  BY c.occurred_at DESC
  `),
};

// ── Batch snapshot insert (transaction) ─────────────────────────────────────
const insertSnapshotsBatch = db.transaction((productId, recordedAt, variants) => {
  for (const { label, stock } of variants) {
    stmts.insertSnapshots.run({ productId, recordedAt, variant: label, stock });
  }
});

// ── Public API ───────────────────────────────────────────────────────────────
export function saveProduct(url, name) {
  stmts.upsertProduct.run({ url, name: name ?? url });
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

export function purgeOldData() {
  const { changes } = stmts.purgeOldSnapshots.run();
  if (changes > 0) console.log(`[db] purged ${changes} old snapshot rows`);
}

export function getExportData() {
  return stmts.exportAll.all();
}

export function getChangeEvents() {
  return stmts.exportChanges.all();
}

// ── Daily purge job ──────────────────────────────────────────────────────────
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
setInterval(purgeOldData, PURGE_INTERVAL_MS).unref();
purgeOldData(); // run once on startup

export { db };
