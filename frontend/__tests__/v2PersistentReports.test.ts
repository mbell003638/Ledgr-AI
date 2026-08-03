import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema, type SqlRunner } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { persistentV2ReportsOrFallback } from '../src/accountingV2/persistentReports';

describe('persistent V2 reports', () => {
  it('derives trial balance, P&L and balance sheet from persisted journal lines in the requested range', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2SqlRepository(runner);
      const book = defaultBook('default', 'Journal Shop');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'p', bookId: book.id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
      await repo.postJournal({ bookId: book.id, periodId: 'p', date: '2026-01-05', memo: 'Opening capital', lines: [
        { accountId: 'default:account:1000', debit: 1000, credit: 0 },
        { accountId: 'default:account:3000', debit: 0, credit: 1000 },
      ] });
      await repo.postJournal({ bookId: book.id, periodId: 'p', date: '2026-02-10', memo: 'Sale', lines: [
        { accountId: 'default:account:1000', debit: 250, credit: 0 },
        { accountId: 'default:account:4000', debit: 0, credit: 250 },
      ] });
      await repo.postJournal({ bookId: book.id, periodId: 'p', date: '2026-03-10', memo: 'Outside range', lines: [
        { accountId: 'default:account:1000', debit: 50, credit: 0 },
        { accountId: 'default:account:4000', debit: 0, credit: 50 },
      ] });

      const fallback = jest.fn();
      const result = await persistentV2ReportsOrFallback(runner, { bookId: book.id, from: '2026-01-01', to: '2026-02-28' }, fallback);

      expect(result.source).toBe('v2');
      if (result.source !== 'v2') throw new Error('Expected V2 report');
      expect(result.report.journalCount).toBe(2);
      expect(result.report.trialBalance.totals).toEqual({ debit: 1250, credit: 1250, difference: 0 });
      expect(result.report.profitAndLoss).toEqual({ revenue: 250, expenses: 0, cogs: 0, grossProfit: 250, netProfit: 250 });
      expect(result.report.balanceSheet).toMatchObject({ assets: 1250, equity: 1000, currentEarnings: 250, balanced: true });
      expect(fallback).not.toHaveBeenCalled();
    } finally { close(); }
  });

  it('uses the legacy fallback when SQLite is unavailable or the active V2 book does not exist', async () => {
    const legacy = { legacy: true };
    const noSqlFallback = jest.fn(async () => legacy);
    await expect(persistentV2ReportsOrFallback(null, { bookId: 'default' }, noSqlFallback)).resolves.toEqual({ source: 'legacy', report: legacy });

    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const missingBookFallback = jest.fn(async () => legacy);
      await expect(persistentV2ReportsOrFallback(runner, { bookId: 'missing' }, missingBookFallback)).resolves.toEqual({ source: 'legacy', report: legacy });
      expect(missingBookFallback).toHaveBeenCalledTimes(1);
    } finally { close(); }
  });

  it('safely falls back when a persistent report read fails', async () => {
    const broken = {
      all: async () => { throw new Error('database unavailable'); },
      first: async () => null,
      exec: async () => undefined,
      run: async () => undefined,
    } satisfies SqlRunner;
    const fallback = jest.fn(async () => 'legacy report');

    await expect(persistentV2ReportsOrFallback(broken, { bookId: 'default' }, fallback)).resolves.toEqual({ source: 'legacy', report: 'legacy report' });
  });
});
