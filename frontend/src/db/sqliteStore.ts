/**
 * SQLite-backed collection store (Phase 2B, experimental).
 *
 * Implements the same four storage primitives local.ts already funnels through
 * — readColl / writeColl / readSettings / writeSettings — but on top of a real
 * row-per-record SQLite database instead of one JSON blob per collection.
 *
 * Because local.ts uses only those four primitives for persistence, swapping in
 * this store leaves all ~800 lines of report/accounting logic untouched.
 */

import type { SqlRunner, CollectionName } from './schema';
import { initSchema } from './schema';

/**
 * Transaction mutex. SQLite (via expo-sqlite) uses a SINGLE connection, so two
 * overlapping BEGIN…COMMIT blocks throw "cannot start a transaction within a
 * transaction". Callers like resetAll() fire many writeColl() calls through
 * Promise.all(); without serialization their BEGINs interleave and crash.
 * We chain every transactional write onto one promise so they run one-at-a-time.
 */
let txChain: Promise<any> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = txChain.then(fn, fn);
  // Keep the chain alive but swallow errors so one failure can't wedge the queue.
  txChain = next.catch(() => {});
  return next;
}

/** Read every record in a collection as parsed objects. */
export async function readColl<T = any>(db: SqlRunner, coll: CollectionName): Promise<T[]> {
  const rows = await db.all<{ data: string }>(`SELECT data FROM ${coll}`);
  const out: T[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.data) as T);
    } catch {
      // A single corrupt row is skipped rather than poisoning the whole read —
      // this row-level resilience is a core reason for moving off the JSON blob.
    }
  }
  return out;
}

/**
 * Replace the entire contents of a collection with `arr`, atomically.
 * Mirrors writeColl(coll, arr) semantics from the AsyncStorage layer (full
 * overwrite), but wrapped in a transaction so a mid-write failure can't leave
 * the table half-updated. Serialized via runExclusive so concurrent callers
 * (e.g. resetAll's Promise.all) never nest BEGIN statements.
 */
export async function writeColl<T = any>(db: SqlRunner, coll: CollectionName, arr: T[]): Promise<void> {
  return runExclusive(async () => {
    await db.exec('BEGIN');
    try {
      await db.run(`DELETE FROM ${coll}`);
      for (const item of arr) {
        const rec: any = item;
        const id = rec?.id != null ? String(rec.id) : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const date = rec?.date != null ? String(rec.date) : (rec?.created_at != null ? String(rec.created_at) : null);
        await db.run(`INSERT INTO ${coll}(id, date, data) VALUES(?, ?, ?)`, [id, date, JSON.stringify(rec)]);
      }
      await db.exec('COMMIT');
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  });
}

/**
 * Collection overwrite WITHOUT its own BEGIN/COMMIT — for use INSIDE an existing
 * outer transaction (see withImportTransaction). writeColl() opens its own
 * transaction and cannot be nested; this variant assumes the caller already
 * holds one, so a multi-collection restore is a single atomic unit. Not
 * serialized via runExclusive: the caller's transaction is the serialization
 * boundary and nesting runExclusive inside it would deadlock the chain.
 */
export async function writeCollInTxn<T = any>(db: SqlRunner, coll: CollectionName, arr: T[]): Promise<void> {
  await db.run(`DELETE FROM ${coll}`);
  for (const item of arr) {
    const rec: any = item;
    const id = rec?.id != null ? String(rec.id) : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const date = rec?.date != null ? String(rec.date) : (rec?.created_at != null ? String(rec.created_at) : null);
    await db.run(`INSERT INTO ${coll}(id, date, data) VALUES(?, ?, ?)`, [id, date, JSON.stringify(rec)]);
  }
}

/**
 * Run `fn` inside ONE outer BEGIN/COMMIT, rolling back on any error. Serialized
 * via the same mutex writeColl uses so it never nests another top-level BEGIN.
 *
 * This is the atomicity primitive for backup import: the entire restore (all
 * legacy collections + settings + every V2 table) either fully applies or fully
 * rolls back, so a mid-restore failure can never leave a shop's books in a
 * half-imported, self-inconsistent state. [C3/H1]
 *
 * IMPORTANT: `fn` must perform only raw SQL / writeCollInTxn / writeSettingsInTxn
 * — it must NOT call writeColl or any helper that issues its own BEGIN/COMMIT,
 * or SQLite will throw "cannot start a transaction within a transaction".
 */
export async function withImportTransaction<T>(db: SqlRunner, fn: () => Promise<T>): Promise<T> {
  return runExclusive(async () => {
    await db.exec('BEGIN');
    try {
      const result = await fn();
      await db.exec('COMMIT');
      return result;
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
      throw e;
    }
  });
}

/** Settings upsert without its own transaction — for use inside withImportTransaction. */
export async function writeSettingsInTxn(db: SqlRunner, s: any): Promise<void> {
  await db.run(
    `INSERT INTO settings(key, value) VALUES('main', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(s ?? {})],
  );
}

/** Read the settings document (single JSON row under key 'main'). */
export async function readSettings(db: SqlRunner): Promise<any> {
  const row = await db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'main'`);
  if (!row) return {};
  try {
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

/** Overwrite the settings document. */
export async function writeSettings(db: SqlRunner, s: any): Promise<void> {
  await db.run(
    `INSERT INTO settings(key, value) VALUES('main', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(s ?? {})],
  );
}

/**
 * One-time, NON-DESTRUCTIVE migration from the legacy AsyncStorage layout.
 *
 * Safety properties:
 *   - Reads legacy data via the injected `legacyGet` (AsyncStorage.getItem).
 *   - Only imports a collection if the SQLite table is currently EMPTY, so it
 *     can never overwrite data already living in SQLite.
 *   - Guarded by a `migrated` flag in `meta`, so it runs at most once.
 *   - Does NOT delete anything from AsyncStorage — the old data stays intact as
 *     a fallback until you're confident the SQLite path works on-device.
 *
 * Returns a report of what was imported (for logging / verification).
 */
export async function migrateFromAsyncStorage(
  db: SqlRunner,
  legacyGet: (key: string) => Promise<string | null>,
  collections: readonly CollectionName[],
): Promise<{ migrated: boolean; imported: Record<string, number>; alreadyDone: boolean }> {
  await initSchema(db);

  const done = await db.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'migrated'`);
  if (done && done.value === 'true') {
    return { migrated: false, imported: {}, alreadyDone: true };
  }

  const imported: Record<string, number> = {};

  for (const coll of collections) {
    // Never clobber a table that already has rows.
    const existing = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${coll}`);
    if (existing && Number(existing.n) > 0) {
      imported[coll] = 0;
      continue;
    }
    const raw = await legacyGet(`ledgr:${coll}`);
    if (!raw) {
      imported[coll] = 0;
      continue;
    }
    let arr: any[];
    try {
      arr = JSON.parse(raw);
    } catch {
      imported[coll] = 0;
      continue;
    }
    if (!Array.isArray(arr) || arr.length === 0) {
      imported[coll] = 0;
      continue;
    }
    await writeColl(db, coll, arr);
    imported[coll] = arr.length;
  }

  // Settings
  const settingsRaw = await legacyGet('ledgr:settings');
  if (settingsRaw) {
    const existingSettings = await db.first<{ value: string }>(`SELECT value FROM settings WHERE key = 'main'`);
    if (!existingSettings) {
      try {
        const parsed = JSON.parse(settingsRaw);
        if (parsed && typeof parsed === 'object') await writeSettings(db, parsed);
      } catch {
        /* ignore malformed legacy settings */
      }
    }
  }

  await db.run(
    `INSERT INTO meta(key, value) VALUES('migrated', 'true')
     ON CONFLICT(key) DO UPDATE SET value = 'true'`,
  );

  return { migrated: true, imported, alreadyDone: false };
}
