/**
 * V2 double-entry ledger backup/restore. [C1 — the data-loss headline]
 *
 * The legacy backup (local.ts exportBackup) only ever captured the 16 legacy
 * JSON collections + settings. On a SQLite install the AUTHORITATIVE books live
 * in the normalized v2_* tables — so a "backup" silently omitted every journal
 * entry, line, party, account, period, allocation, inventory count, member and
 * close snapshot. Restoring such a backup onto a fresh device would lose the
 * real ledger. This module captures and atomically restores that V2 data.
 *
 * Design notes:
 *   - Operates on a SqlRunner directly (the same handle the app uses via
 *     activeSqlRunner()) so it is fully testable under the node:sqlite runner.
 *   - Export = SELECT * from every v2 table + the relevant meta keys.
 *   - Import = wipe (FK-safe, children-first) then re-insert (FK-safe,
 *     parents-first) then restore meta — the caller wraps this in ONE outer
 *     transaction (withImportTransaction) so it composes with the legacy import
 *     into a single all-or-nothing restore.
 *   - Import compatibility is checked before any table is wiped. Data-bearing
 *     unknown tables/columns are rejected so a newer backup can never appear to
 *     restore successfully while silently losing information.
 */

import type { SqlRunner } from './schema';
import { V2_TABLES } from './schema';

/** Schema version marker embedded in the V2 payload (independent of SQLITE SCHEMA_VERSION). */
export const V2_BACKUP_VERSION = 2 as const;

/** Tables present in the only supported legacy V2 backup schema. */
const V2_BACKUP_V1_TABLES = [
  'v2_books',
  'v2_personas',
  'v2_parties',
  'v2_accounts',
  'v2_periods',
  'v2_sources',
  'v2_journal_entries',
  'v2_journal_lines',
  'v2_invoice_allocations',
  'v2_inventory_counts',
  'v2_members',
  'v2_close_books',
] as const;

const LEGACY_FIXED_ASSET_TABLES = ['v2_fixed_assets', 'v2_asset_depreciation'] as const;

/** Meta keys that are part of the V2 ledger's identity and must round-trip. */
const V2_META_EXACT_KEYS = ['v2_active_book_id'] as const;
const V2_META_PREFIXES = ['v2_book_version:'] as const;

export type V2BackupPayload = {
  schemaVersion: number;
  tables: Record<string, any[]>;
  meta: Record<string, string>;
};

export type V2ImportResult = {
  restored: boolean;
  rowCounts: Record<string, number>;
  warnings: string[];
};

/**
 * FK-safe DELETE order (a table is wiped only after everything referencing it
 * is already gone). journal_entries.reversal_of is a self-reference, so those
 * links are nulled before the journal rows are deleted.
 */
export const DELETE_ORDER: readonly string[] = [
  'v2_payslips',
  'v2_pay_runs',
  'v2_employees',
  'v2_stock_moves',
  'v2_products',
  'v2_locations',
  'v2_journal_lines',
  'v2_invoice_allocations',
  'v2_close_books',
  'v2_inventory_counts',
  'v2_journal_entries', // self-ref cleared first (see wipeV2Tables)
  'v2_sources',
  'v2_members',
  'v2_personas',
  'v2_parties',
  'v2_accounts',
  'v2_periods',
  'v2_books',
];

/**
 * FK-safe INSERT order (parents before children). Mirrors DELETE_ORDER
 * reversed, with journal_entries inserted before its dependents.
 */
export const INSERT_ORDER: readonly string[] = [
  'v2_books',
  'v2_periods',
  'v2_personas',
  'v2_parties',
  'v2_accounts',
  'v2_sources',
  'v2_journal_entries',
  'v2_journal_lines',
  'v2_invoice_allocations',
  'v2_inventory_counts',
  'v2_members',
  'v2_close_books',
  'v2_employees',
  'v2_pay_runs',
  'v2_payslips',
  'v2_locations',
  'v2_products',
  'v2_stock_moves',
];

async function tableColumns(db: SqlRunner, table: string): Promise<string[]> {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.map((c) => c.name);
}

/**
 * Export every v2_* table (SELECT *) plus the relevant meta keys into a
 * self-describing payload.
 */
export async function exportV2Data(db: SqlRunner): Promise<V2BackupPayload> {
  // Current builds intentionally preserve these tables on upgraded databases,
  // but they are not represented by the current product model. Refuse to make
  // a backup that would silently omit user-entered legacy asset data.
  for (const table of LEGACY_FIXED_ASSET_TABLES) {
    const exists = await db.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [table],
    );
    if (!exists) continue;
    const count = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    if (Number(count?.n || 0) > 0) {
      throw new Error(
        `Backup cannot continue because legacy Fixed Asset Register data exists in ${table}. `
        + 'Export or migrate that data before creating a Ledgr backup.',
      );
    }
  }

  const tables: Record<string, any[]> = {};
  for (const table of V2_TABLES) {
    tables[table] = await db.all<any>(`SELECT * FROM ${table}`);
  }

  const meta: Record<string, string> = {};
  try {
    const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM meta');
    for (const row of rows) {
      if ((V2_META_EXACT_KEYS as readonly string[]).includes(row.key)
        || V2_META_PREFIXES.some((p) => row.key.startsWith(p))) {
        meta[row.key] = String(row.value);
      }
    }
  } catch { /* no meta table — leave meta empty */ }

  return { schemaVersion: V2_BACKUP_VERSION, tables, meta };
}

/** True when a payload actually carries V2 data (used to decide restore vs. skip). */
export function hasV2Payload(payload: any): payload is V2BackupPayload {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && !!payload.tables && typeof payload.tables === 'object' && !Array.isArray(payload.tables);
}

function isMeaningfulUnknownValue(value: any): boolean {
  return value !== null && value !== undefined && value !== '';
}

function normalizePayload(payload: V2BackupPayload): { payload: V2BackupPayload; warnings: string[] } {
  if (!hasV2Payload(payload)) throw new Error('Backup does not contain a valid V2 accounting ledger.');
  const version = Number(payload.schemaVersion);
  if (version !== 1 && version !== V2_BACKUP_VERSION) {
    throw new Error(
      `Unsupported V2 backup schema v${Number.isFinite(version) ? version : 'unknown'}. `
      + `This app supports schemas v1 and v${V2_BACKUP_VERSION}.`,
    );
  }

  const tables: Record<string, any[]> = {};
  const required = version === 1 ? V2_BACKUP_V1_TABLES : V2_TABLES;
  for (const table of required) {
    if (!Array.isArray(payload.tables[table])) {
      throw new Error(`V2 backup schema v${version} is missing required table: ${table}`);
    }
  }
  for (const table of V2_TABLES) {
    const rows = payload.tables[table];
    if (rows !== undefined && !Array.isArray(rows)) {
      throw new Error(`V2 backup table ${table} is not an array.`);
    }
    tables[table] = Array.isArray(rows) ? rows : [];
  }

  const warnings: string[] = [];
  if (version === 1) warnings.push(`Migrated V2 backup schema v1 to v${V2_BACKUP_VERSION}.`);
  const known = new Set<string>(V2_TABLES as readonly string[]);
  for (const [table, rows] of Object.entries(payload.tables)) {
    if (known.has(table)) continue;
    if (!Array.isArray(rows)) throw new Error(`Unknown V2 backup table ${table} is malformed.`);
    if (rows.length > 0) {
      throw new Error(`Cannot restore data-bearing unknown V2 backup table: ${table}. Update Ledgr first.`);
    }
    warnings.push(`Ignored empty unknown backup table: ${table}`);
  }

  return {
    payload: {
      schemaVersion: V2_BACKUP_VERSION,
      tables,
      meta: payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta)
        ? { ...payload.meta }
        : {},
    },
    warnings,
  };
}

/** Throw if a new V2_TABLES entry was added without updating wipe/restore order. */
function assertOrdersCoverSchema(): void {
  const deleteCovered = new Set(DELETE_ORDER);
  const insertCovered = new Set(INSERT_ORDER);
  const missingDelete = (V2_TABLES as readonly string[]).filter((t) => !deleteCovered.has(t));
  const missingInsert = (V2_TABLES as readonly string[]).filter((t) => !insertCovered.has(t));
  if (missingDelete.length) throw new Error(`v2Backup DELETE_ORDER is missing table(s): ${missingDelete.join(', ')}`);
  if (missingInsert.length) throw new Error(`v2Backup INSERT_ORDER is missing table(s): ${missingInsert.join(', ')}`);
}

/** Wipe every v2 table in FK-safe order. Assumes an open transaction. */
async function wipeV2Tables(db: SqlRunner): Promise<void> {
  assertOrdersCoverSchema();
  for (const table of DELETE_ORDER) {
    if (table === 'v2_journal_entries') {
      // Clear the self-referential reversal link before deleting the rows, else
      // ON DELETE RESTRICT on reversal_of would reject the wholesale delete.
      await db.run('UPDATE v2_journal_entries SET reversal_of = NULL');
    }
    await db.run(`DELETE FROM ${table}`);
  }
}

/**
 * Insert preflighted backup rows using only live columns. Any unknown columns
 * reaching this function are known to be empty and are reported as warnings.
 */
async function insertRows(
  db: SqlRunner,
  table: string,
  rows: any[],
  liveColumns: string[],
  skippedColumns: Set<string>,
): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const liveSet = new Set(liveColumns);
  let inserted = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const cols: string[] = [];
    const vals: any[] = [];
    for (const key of Object.keys(row)) {
      if (liveSet.has(key)) {
        cols.push(key);
        vals.push(row[key]);
      } else {
        skippedColumns.add(`${table}.${key}`);
      }
    }
    if (cols.length === 0) continue;
    const placeholders = cols.map(() => '?').join(',');
    const colList = cols.map((c) => `"${c}"`).join(',');
    await db.run(`INSERT INTO ${table}(${colList}) VALUES(${placeholders})`, vals);
    inserted += 1;
  }
  return inserted;
}

/**
 * Restore a V2 payload. MUST be called inside an existing transaction
 * (withImportTransaction) so it composes with the legacy import as one atomic
 * unit — this function does NOT open its own transaction.
 *
 * Order: wipe (FK-safe) → insert parents→children (FK-safe) → restore meta.
 * Empty unknown tables/columns are harmless and reported. Data-bearing unknown
 * tables/columns are rejected during preflight before the first destructive SQL.
 */
export async function importV2Data(db: SqlRunner, payload: V2BackupPayload): Promise<V2ImportResult> {
  const rowCounts: Record<string, number> = {};
  const normalized = normalizePayload(payload);
  payload = normalized.payload;
  const warnings = [...normalized.warnings];

  // Preflight every row and column before wiping anything. Unknown columns are
  // accepted only when they contain no information on every row.
  const liveColumns = new Map<string, string[]>();
  const skippedColumns = new Set<string>();
  for (const table of INSERT_ORDER) {
    const columns = await tableColumns(db, table);
    liveColumns.set(table, columns);
    const liveSet = new Set(columns);
    for (const row of payload.tables[table]) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`V2 backup table ${table} contains an invalid row.`);
      }
      for (const [key, value] of Object.entries(row)) {
        if (liveSet.has(key)) continue;
        if (isMeaningfulUnknownValue(value)) {
          throw new Error(`Cannot restore data-bearing unknown V2 backup column: ${table}.${key}. Update Ledgr first.`);
        }
        skippedColumns.add(`${table}.${key}`);
      }
    }
  }

  await wipeV2Tables(db);
  // A restore replaces V2 ledger identity as well as tables. Clear managed
  // keys first so books absent from the payload cannot leave stale pointers.
  await db.run("DELETE FROM meta WHERE key='v2_active_book_id' OR key GLOB 'v2_book_version:*'");

  for (const table of INSERT_ORDER) {
    const rows = payload.tables[table];
    if (!Array.isArray(rows) || rows.length === 0) { rowCounts[table] = 0; continue; }
    const columns = liveColumns.get(table) || [];

    let ordered = rows;
    if (table === 'v2_journal_entries') {
      // Insert base entries before reversal entries so the reversal_of FK
      // (a self-reference to another journal entry) always resolves.
      ordered = [...rows].sort((a, b) => {
        const ar = a && a.reversal_of ? 1 : 0;
        const br = b && b.reversal_of ? 1 : 0;
        return ar - br;
      });
    }
    rowCounts[table] = await insertRows(db, table, ordered, columns, skippedColumns);
  }

  for (const dropped of skippedColumns) warnings.push(`Skipped unknown column: ${dropped}`);

  // Restore the V2 meta keys (active book id, per-book versions).
  if (payload.meta && typeof payload.meta === 'object') {
    for (const [key, value] of Object.entries(payload.meta)) {
      if (!(V2_META_EXACT_KEYS as readonly string[]).includes(key)
        && !V2_META_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      await db.run(
        'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        [key, String(value)],
      );
    }
  }

  // Remove imported identity keys that do not resolve to restored books.
  const active = await db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
  if (active?.value && !(await db.first('SELECT id FROM v2_books WHERE id=?', [active.value]))) {
    await db.run("DELETE FROM meta WHERE key='v2_active_book_id'");
    warnings.push(`Removed invalid active V2 book reference: ${active.value}`);
  }
  const versionRows = await db.all<{ key: string }>("SELECT key FROM meta WHERE key GLOB 'v2_book_version:*'");
  for (const row of versionRows) {
    const bookId = row.key.slice('v2_book_version:'.length);
    if (!bookId || !(await db.first('SELECT id FROM v2_books WHERE id=?', [bookId]))) {
      await db.run('DELETE FROM meta WHERE key=?', [row.key]);
      warnings.push(`Removed invalid V2 book version reference: ${bookId || row.key}`);
    }
  }

  return { restored: true, rowCounts, warnings };
}
