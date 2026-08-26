import type { SqlRunner } from '../src/db/schema';
import { readBookHealth } from '../src/utils/bookHealth';
import { deriveHostingMode } from '../src/utils/hostingMode';

function runnerFor(options: { imbalance?: boolean; openPeriod?: boolean } = {}) {
  const calls: { sql: string; params?: any[] }[] = [];
  const runner: SqlRunner = {
    exec: async () => {},
    run: async () => {},
    all: async () => [],
    first: async <T>(sql: string, params?: any[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM meta') && String(params?.[0] || '').startsWith('v2_book_version:')) return { value: '2' } as T;
      if (sql.includes('FROM v2_books')) return { id: 'book-a' } as T;
      if (sql.includes('FROM v2_periods')) return { count: options.openPeriod === false ? 0 : 1 } as T;
      if (sql.includes('FROM v2_journal_entries')) return (options.imbalance ? { journal_id: 'journal-1', difference: 5 } : null) as T;
      if (sql.includes('FROM v2_sources')) return { count: 0 } as T;
      return null;
    },
  };
  return { runner, calls };
}

describe('Book Health', () => {
  it('reports a healthy local-only book when ledger checks and backup are current', async () => {
    const { runner } = runnerFor();
    const health = await readBookHealth(
      runner,
      'book-a',
      { lastBackupAt: '2026-08-20T00:00:00.000Z' },
      { enabled: false, configured: false, pending: 0, retryable: 0, conflicts: 0 },
      new Date('2026-08-26T00:00:00.000Z'),
    );
    expect(health.tone).toBe('healthy');
    expect(health.checks.find((check) => check.key === 'sync')?.label).toBe('Local-only');
  });

  it('raises critical findings for an unbalanced journal and sync recovery', async () => {
    const { runner, calls } = runnerFor({ imbalance: true });
    const health = await readBookHealth(
      runner,
      'book-a',
      {},
      { enabled: false, configured: true, pending: 2, retryable: 1, conflicts: 0, recoveryRequired: true, recoveryReason: 'Snapshot mismatch' },
      new Date('2026-08-26T00:00:00.000Z'),
    );
    expect(health.tone).toBe('critical');
    expect(health.checks.find((check) => check.key === 'journals')?.tone).toBe('critical');
    expect(health.checks.find((check) => check.key === 'sync')?.label).toBe('Recovery required');
    const journalQuery = calls.find((call) => call.sql.includes('FROM v2_journal_entries'));
    expect(journalQuery?.sql).toContain('WHERE j.book_id=?');
    expect(journalQuery?.params).toEqual(['book-a']);
  });

  it('returns a visible critical result when the schema cannot be read', async () => {
    const broken: SqlRunner = {
      exec: async () => {}, run: async () => {}, all: async () => [],
      first: async () => { throw new Error('no such table: v2_books'); },
    };
    const health = await readBookHealth(
      broken,
      'book-a',
      {},
      { enabled: false, configured: false, pending: 0, retryable: 0, conflicts: 0 },
      new Date('2026-08-26T00:00:00.000Z'),
    );
    expect(health.tone).toBe('critical');
    expect(health.checks.find((check) => check.key === 'schema')?.detail).toMatch(/no such table/i);
  });
});

describe('hosting status', () => {
  it('never presents private sync as active when it is only configured', () => {
    const mode = deriveHostingMode({ enabled: false, configured: true, pending: 0, retryable: 0, conflicts: 0 });
    expect(mode.mode).toBe('local_only');
    expect(mode.label).toMatch(/paused/i);
  });
});
