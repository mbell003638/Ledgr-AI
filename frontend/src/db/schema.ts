/**
 * SQLite schema + runner contract for the Ledgr data layer (Phase 2B, experimental).
 *
 * Why an abstraction: the app runtime uses `expo-sqlite` (async API) while unit
 * tests use Node's built-in `node:sqlite` (sync API). Both implement the small
 * async `SqlRunner` interface below, so the SAME schema + queries run in both
 * places — the SQL is tested for real, not mocked.
 *
 * Storage model: one table per collection, ONE ROW PER RECORD (not a single JSON
 * blob). Each row keeps its `id` and `date` as real indexed columns for fast
 * range queries, plus the full record as JSON in `data`. This is the concrete
 * improvement over the AsyncStorage single-blob-per-collection design:
 *   - row-level integrity (a corrupt record can't poison the whole collection)
 *   - atomic multi-row writes via transactions
 *   - indexed date lookups instead of full-array scans
 */

/** Minimal async DB interface implemented by both expo-sqlite and node:sqlite adapters. */
export interface SqlRunner {
  /** Execute one or more statements with no bound params (DDL, PRAGMA, BEGIN/COMMIT). */
  exec(sql: string): Promise<void>;
  /** Run a single write statement with positional params. */
  run(sql: string, params?: any[]): Promise<void>;
  /** Return all rows for a query. */
  all<T = any>(sql: string, params?: any[]): Promise<T[]>;
  /** Return the first row for a query, or null. */
  first<T = any>(sql: string, params?: any[]): Promise<T | null>;
}

/** Collections that store a list of records (mirror KEYS in local.ts). */
export const COLLECTIONS = [
  'suppliers',
  'bills',
  'sales',
  'payments',
  'inventoryChecks',
  'periods',
  'expenses',
  'debtors',
  'invoices',
  'quotes',
  'receipts',
  'creditNotes',
  'debitNotes',
  'deliveryNotes',
  'cashEntries',
] as const;

export type CollectionName = typeof COLLECTIONS[number];

/** Current on-device schema version (bump when table shapes change). */
export const SCHEMA_VERSION = 2;

/**
 * Full DDL. Every collection table is (id, date, data) with an index on date.
 * `settings` is a single-row key/value store (one JSON document under 'main').
 * `meta` tracks schema version + whether the AsyncStorage import already ran.
 */
export function schemaSql(): string {
  const collTables = COLLECTIONS.map(
    (c) => `
    CREATE TABLE IF NOT EXISTS ${c} (
      id   TEXT PRIMARY KEY,
      date TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${c}_date ON ${c}(date);`,
  ).join('\n');

  return `
    ${collTables}
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;
}

/** Initialise the schema and stamp the version if absent. */
export async function initSchema(db: SqlRunner): Promise<void> {
  await db.exec(schemaSql());
  const row = await db.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (!row) {
    await db.run(`INSERT INTO meta(key, value) VALUES('schema_version', ?)`, [String(SCHEMA_VERSION)]);
  }
}
