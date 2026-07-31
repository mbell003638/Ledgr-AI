import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { resetAllV2AccountingData, resetV2AccountingData } from '../src/accountingV2/resetBook';

describe('V2 accounting reset', () => {
  it('clears ledger activity while preserving book configuration and a usable open period', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'reset-book', name: 'Configured Business', style: 'retail_partnership' },
        period: { id: 'old-period', startDate: '2026-01-01', endDate: '2026-12-31' },
        personas: ['retail', 'custom'],
        members: [{ name: 'Amit', openingContribution: 100, profitSharePct: 50 }],
      });
      const service = new V2AppService(runner);
      await service.createSale({ date: '2026-07-01', amount: 25 });
      await service.createInvoice({ date: '2026-07-02', total: 40, clientName: 'Customer' });

      await resetV2AccountingData(runner, 'reset-book', '2026-07-31');

      expect(await runner.first('SELECT name,style FROM v2_books WHERE id=?', ['reset-book'])).toEqual({
        name: 'Configured Business', style: 'retail_partnership',
      });
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_accounts WHERE book_id=?', ['reset-book']))?.n)).toBeGreaterThan(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_personas WHERE book_id=?', ['reset-book']))?.n)).toBe(2);
      expect(await runner.first('SELECT opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=?', ['reset-book'])).toEqual({
        opening_contribution: 0, current_capital: 0, profit_share_pct: 50,
      });
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', ['reset-book']))?.n)).toBe(0);
      expect(await service.activeContext('2026-08-01')).toEqual({
        bookId: 'reset-book', periodId: 'reset-book:period:2026-07-31',
      });
      await expect(service.createSale({ date: '2026-08-01', amount: 10 })).resolves.toMatchObject({
        source: { type: 'cash_sale' },
      });
    } finally { close(); }
  });

  it('rolls back rather than reporting a partial reset when recreation fails', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'reset-book', name: 'Business' },
        period: { id: 'old-period', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      await service.createSale({ date: '2026-07-01', amount: 25 });
      await runner.exec("CREATE TRIGGER reject_reset_period BEFORE INSERT ON v2_periods BEGIN SELECT RAISE(ABORT, 'period rejected'); END;");
      await expect(resetV2AccountingData(runner, 'reset-book', '2026-07-31')).rejects.toThrow(/period rejected/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', ['reset-book']))?.n)).toBe(1);
    } finally { close(); }
  });
  it('clears activity from every V2 book while preserving book identities and the active selection', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      for (const id of ['book-a', 'book-b']) {
        await initializeV2Book(runner, {
          book: { id, name: `Business ${id}` },
          period: { id: `${id}-period`, startDate: '2026-01-01', endDate: '2026-12-31' },
        });
        await new V2AppService(runner).createSale({ date: '2026-07-01', amount: 25 });
      }
      await runner.run("UPDATE meta SET value='book-a' WHERE key='v2_active_book_id'");

      await resetAllV2AccountingData(runner, '2026-07-31');

      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_books'))?.n)).toBe(2);
      expect(await runner.first("SELECT value FROM meta WHERE key='v2_active_book_id'")).toEqual({ value: 'book-a' });
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_periods WHERE status='open'"))?.n)).toBe(2);
    } finally { close(); }
  });
});
