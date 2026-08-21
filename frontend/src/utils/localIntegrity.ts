import { activeBookId, activeSqlRunner, storageMode } from '@/src/db/backend';
import { SCHEMA_VERSION, V2_TABLES } from '@/src/db/schema';
import { getSettings } from '@/src/db/local';

export type LocalIntegrityResult = {
  ok: boolean;
  storage: 'sqlite' | 'async_storage';
  bookId: string;
  schemaVersion: number | null;
  checkedAt: string;
  checks: {
    settingsReadable: boolean;
    schemaCurrent: boolean;
    activeBookReadable: boolean;
    requiredTablesPresent: boolean;
    journalBalanced: boolean;
  };
  issues: string[];
};

/**
 * Validate the local book before a migration, backup restore, or private-sync
 * enrollment. This is intentionally read-only: it never repairs or mutates data.
 */
export async function checkLocalIntegrity(): Promise<LocalIntegrityResult> {
  const issues: string[] = [];
  let settingsReadable = false;
  let schemaCurrent = false;
  let activeBookReadable = false;
  let requiredTablesPresent = false;
  let journalBalanced = true;
  let schemaVersion: number | null = null;
  const bookId = activeBookId();
  const mode = storageMode();

  try {
    await getSettings();
    settingsReadable = true;
  } catch {
    issues.push('Local settings could not be read.');
  }

  const runner = activeSqlRunner();
  if (!runner) {
    // Web/local fallback uses the existing AsyncStorage-backed document store.
    // It has no SQLite schema to inspect, but settings readability is still a
    // meaningful non-destructive prerequisite check.
    if (!settingsReadable) issues.push('Local storage is unavailable.');
    return {
      ok: issues.length === 0,
      storage: mode === 'sqlite' ? 'sqlite' : 'async_storage',
      bookId,
      schemaVersion: null,
      checkedAt: new Date().toISOString(),
      checks: { settingsReadable, schemaCurrent: true, activeBookReadable: settingsReadable, requiredTablesPresent: true, journalBalanced: true },
      issues,
    };
  }

  try {
    const schemaRow = await runner.first<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'");
    schemaVersion = schemaRow?.value == null ? null : Number(schemaRow.value);
    schemaCurrent = schemaVersion === SCHEMA_VERSION;
    if (!schemaCurrent) issues.push(`SQLite schema is ${schemaVersion ?? 'unknown'}; expected ${SCHEMA_VERSION}.`);
  } catch {
    issues.push('SQLite schema version could not be read.');
  }

  try {
    const row = await runner.first<{ id: string }>('SELECT id FROM v2_books WHERE id=? LIMIT 1', [bookId]);
    activeBookReadable = !!row;
    if (!activeBookReadable) issues.push('The active V2 business book could not be read.');
  } catch {
    issues.push('The active V2 business book could not be queried.');
  }

  try {
    const names = await runner.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'v2_%'");
    const present = new Set(names.map((row) => row.name));
    const missing = V2_TABLES.filter((table) => !present.has(table));
    requiredTablesPresent = missing.length === 0;
    if (missing.length) issues.push(`Required V2 table${missing.length === 1 ? '' : 's'} missing: ${missing.join(', ')}.`);
  } catch {
    issues.push('Required V2 tables could not be inspected.');
  }

  try {
    const unbalanced = await runner.all<{ journal_id: string; difference: number }>(
      `SELECT je.id AS journal_id, ROUND(COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0), 2) AS difference
       FROM v2_journal_entries je
       LEFT JOIN v2_journal_lines jl ON jl.journal_id=je.id
       WHERE je.book_id=?
       GROUP BY je.id
       HAVING ABS(ROUND(COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0), 2)) > 0.009`,
      [bookId],
    );
    journalBalanced = unbalanced.length === 0;
    if (!journalBalanced) issues.push(`${unbalanced.length} journal entr${unbalanced.length === 1 ? 'y is' : 'ies are'} not balanced.`);
  } catch {
    journalBalanced = false;
    issues.push('Journal balance could not be verified.');
  }

  return {
    ok: issues.length === 0,
    storage: 'sqlite',
    bookId,
    schemaVersion,
    checkedAt: new Date().toISOString(),
    checks: { settingsReadable, schemaCurrent, activeBookReadable, requiredTablesPresent, journalBalanced },
    issues,
  };
}

export async function assertLocalIntegrity(): Promise<LocalIntegrityResult> {
  const result = await checkLocalIntegrity();
  if (!result.ok) throw new Error(`Local integrity check failed: ${result.issues.join(' ')}`);
  return result;
}
