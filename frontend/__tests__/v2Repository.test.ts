import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';

describe('V2SqlRepository — atomic journal persistence', () => {
  it('persists a balanced journal and its lines in one transaction', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2SqlRepository(runner);
      const book = defaultBook('book-v2', 'V2 Shop');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'period-1', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
      const entry = await repo.postJournal({
        bookId: book.id, periodId: 'period-1', date: '2026-07-27', memo: 'Cash sale',
        lines: [
          { accountId: `${book.id}:account:1000`, debit: 125, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 125 },
        ],
      });
      expect(entry.id).toBeTruthy();
      const row = await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE id = ?', [entry.id]);
      const lines = await runner.all<{ debit: number; credit: number }>('SELECT debit, credit FROM v2_journal_lines WHERE journal_id = ? ORDER BY id', [entry.id]);
      expect(Number(row?.n)).toBe(1);
      expect(lines).toEqual([{ debit: 125, credit: 0 }, { debit: 0, credit: 125 }]);
      await expect(repo.reconcileBook(book.id)).resolves.toMatchObject({ debit: 125, credit: 125, difference: 0, balanced: true });
    } finally { close(); }
  });

  it('rejects invalid references without persisting any journal rows', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2SqlRepository(runner);
      const book = defaultBook('book-v2', 'V2 Shop');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'period-1', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
      await expect(repo.postJournal({
        bookId: book.id, periodId: 'period-1', date: '2026-07-27', memo: 'Bad',
        lines: [
          { accountId: 'missing-account', debit: 10, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 10 },
        ],
      })).rejects.toThrow(/account/i);
      const entries = await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries');
      const lines = await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_lines');
      expect(Number(entries?.n)).toBe(0);
      expect(Number(lines?.n)).toBe(0);
    } finally { close(); }
  });

  it('rolls back the journal header when a line insert fails', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2SqlRepository(runner);
      const book = defaultBook('book-v2', 'V2 Shop');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'period-1', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
      await runner.exec(`CREATE TRIGGER fail_second_line BEFORE INSERT ON v2_journal_lines
        WHEN NEW.credit > 0 BEGIN SELECT RAISE(FAIL, 'injected line failure'); END;`);
      await expect(repo.postJournal({
        bookId: book.id, periodId: 'period-1', date: '2026-07-27', memo: 'Rollback',
        lines: [
          { accountId: `${book.id}:account:1000`, debit: 10, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 10 },
        ],
      })).rejects.toThrow(/injected line failure/);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_lines'))?.n)).toBe(0);
    } finally { close(); }
  });
});
