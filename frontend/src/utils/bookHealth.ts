import type { SqlRunner } from '../db/schema';
import { V2_BOOK_VERSION, accountingBookVersion } from '../accountingV2/appBootstrap';
import { deriveHostingMode, type HostingStatusInput } from './hostingMode';

export type BookHealthTone = 'healthy' | 'attention' | 'critical';

export type BookHealthCheck = {
  key: 'storage' | 'book' | 'schema' | 'period' | 'journals' | 'dates' | 'backup' | 'sync';
  label: string;
  tone: BookHealthTone;
  detail: string;
};

export type BookHealth = {
  bookId: string;
  tone: BookHealthTone;
  label: 'Healthy' | 'Needs attention' | 'Action required';
  checkedAt: string;
  checks: BookHealthCheck[];
};

const overallTone = (checks: BookHealthCheck[]): BookHealthTone => checks.some((check) => check.tone === 'critical')
  ? 'critical'
  : checks.some((check) => check.tone === 'attention') ? 'attention' : 'healthy';

const summaryLabel = (tone: BookHealthTone): BookHealth['label'] => tone === 'critical' ? 'Action required' : tone === 'attention' ? 'Needs attention' : 'Healthy';

export function unavailableBookHealth(bookId: string, detail = 'SQLite accounting storage is not ready.'): BookHealth {
  const checks: BookHealthCheck[] = [{ key: 'storage', label: 'Local accounting storage', tone: 'critical', detail }];
  return { bookId, tone: 'critical', label: 'Action required', checkedAt: new Date().toISOString(), checks };
}

export async function readBookHealth(
  db: SqlRunner,
  bookId: string,
  settings: Record<string, any>,
  syncStatus: HostingStatusInput,
  now = new Date(),
): Promise<BookHealth> {
  const checks: BookHealthCheck[] = [];
  checks.push({ key: 'storage', label: 'Local accounting storage', tone: 'healthy', detail: 'SQLite accounting storage is available.' });

  let book: { id: string } | null;
  let version: number | null;
  let openPeriod: { count: number } | null;
  let imbalance: { journal_id: string; difference: number } | null;
  let missingDates: { count: number } | null;
  try {
    [book, version, openPeriod, imbalance, missingDates] = await Promise.all([
      db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [bookId]),
      accountingBookVersion(db, bookId),
      db.first<{ count: number }>("SELECT COUNT(*) AS count FROM v2_periods WHERE book_id=? AND status='open'", [bookId]),
      db.first<{ journal_id: string; difference: number }>(
        `SELECT j.id AS journal_id, ROUND(COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0),2) AS difference
         FROM v2_journal_entries j
         JOIN v2_journal_lines l ON l.journal_id=j.id
         WHERE j.book_id=?
         GROUP BY j.id
         HAVING ABS(ROUND(COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0),2)) > 0.009
         LIMIT 1`,
        [bookId],
      ),
      db.first<{ count: number }>("SELECT COUNT(*) AS count FROM v2_sources WHERE book_id=? AND (date IS NULL OR TRIM(date)='')", [bookId]),
    ]);
  } catch (error: any) {
    checks.push({
      key: 'schema', label: 'Accounting model', tone: 'critical',
      detail: `Book Health could not read the accounting schema: ${error?.message || 'unknown storage error'}`,
    });
    return { bookId, tone: 'critical', label: 'Action required', checkedAt: now.toISOString(), checks };
  }

  checks.push({
    key: 'book', label: 'Business Account', tone: book ? 'healthy' : 'critical',
    detail: book ? 'The active Business Account is readable.' : 'The active Business Account is missing from the V2 ledger.',
  });
  checks.push({
    key: 'schema', label: 'Accounting model', tone: version === V2_BOOK_VERSION ? 'healthy' : 'critical',
    detail: version === V2_BOOK_VERSION ? `V2 accounting model version ${V2_BOOK_VERSION} is current.` : `Expected V2 accounting model ${V2_BOOK_VERSION}; found ${version ?? 'none'}.`,
  });
  checks.push({
    key: 'period', label: 'Open accounting period', tone: Number(openPeriod?.count || 0) > 0 ? 'healthy' : 'critical',
    detail: Number(openPeriod?.count || 0) > 0 ? 'An open accounting period is available.' : 'No open accounting period is available for new entries.',
  });
  checks.push({
    key: 'journals', label: 'Balanced journals', tone: imbalance ? 'critical' : 'healthy',
    detail: imbalance ? `Journal ${imbalance.journal_id} is out of balance by ${Number(imbalance.difference || 0).toFixed(2)}.` : 'All posted journals in this Business Account are balanced.',
  });
  checks.push({
    key: 'dates', label: 'Transaction dates', tone: Number(missingDates?.count || 0) > 0 ? 'attention' : 'healthy',
    detail: Number(missingDates?.count || 0) > 0 ? `${Number(missingDates?.count)} source record(s) need a valid date.` : 'All source records have dates.',
  });

  const lastBackupAt = typeof settings?.lastBackupAt === 'string' ? new Date(settings.lastBackupAt) : null;
  const backupAgeDays = lastBackupAt && Number.isFinite(lastBackupAt.getTime()) ? Math.floor((now.getTime() - lastBackupAt.getTime()) / 86400000) : null;
  const backupHealthy = backupAgeDays !== null && backupAgeDays <= 30;
  checks.push({
    key: 'backup', label: 'Recent backup', tone: backupHealthy ? 'healthy' : 'attention',
    detail: backupAgeDays === null ? 'No successful backup export is recorded on this device.' : backupHealthy ? `Last backup export was ${backupAgeDays} day(s) ago.` : `Last backup export was ${backupAgeDays} days ago. Export a fresh backup.`,
  });

  const hosting = deriveHostingMode(syncStatus);
  checks.push({
    key: 'sync', label: hosting.label, tone: hosting.tone,
    detail: `${hosting.summary} ${hosting.detail}`,
  });

  const tone = overallTone(checks);
  return { bookId, tone, label: summaryLabel(tone), checkedAt: now.toISOString(), checks };
}
