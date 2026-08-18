import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema, type SqlRunner } from '../src/db/schema';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { persistentV2Reports } from '../src/accountingV2/persistentReports';
import { buildV2Reports } from '../src/accountingV2/reports';

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

      const result = await persistentV2Reports(runner, { bookId: book.id, from: '2026-01-01', to: '2026-02-28' });

      expect(result.source).toBe('v2');
      if (result.source !== 'v2') throw new Error('Expected V2 report');
      expect(result.report.journalCount).toBe(2);
      expect(result.report.trialBalance.totals).toEqual({ debit: 1250, credit: 1250, difference: 0 });
      expect(result.report.profitAndLoss).toEqual({ revenue: 250, expenses: 0, cogs: 0, grossProfit: 250, netProfit: 250 });
      expect(result.report.balanceSheet).toMatchObject({ assets: 1250, equity: 1000, currentEarnings: 250, balanced: true });
    } finally { close(); }
  });

  it('exposes distinct revenue/cogs/grossProfit/expenses/netProfit so the reports tab can map true fields (accrual)', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2SqlRepository(runner);
      const book = defaultBook('default', 'Accrual Shop');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'p', bookId: book.id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
      // Sale $500 on credit, COGS $300 (5000), operating expense $80 (6000).
      await repo.postJournal({ bookId: book.id, periodId: 'p', date: '2026-02-01', memo: 'Credit sale', lines: [
        { accountId: 'default:account:1100', debit: 500, credit: 0 },
        { accountId: 'default:account:4000', debit: 0, credit: 500 },
      ] });
      await repo.postJournal({ bookId: book.id, periodId: 'p', date: '2026-02-02', memo: 'COGS', lines: [
        { accountId: 'default:account:5000', debit: 300, credit: 0 },
        { accountId: 'default:account:1200', debit: 0, credit: 300 },
      ] });
      await repo.postJournal({ bookId: book.id, periodId: 'p', date: '2026-02-03', memo: 'Rent', lines: [
        { accountId: 'default:account:6000', debit: 80, credit: 0 },
        { accountId: 'default:account:1000', debit: 0, credit: 80 },
      ] });

      const result = await persistentV2Reports(runner, { bookId: book.id, from: '2026-01-01', to: '2026-12-31' });
      if (result.source !== 'v2') throw new Error('Expected V2 report');
      const pnl = result.report.profitAndLoss;
      // Engine returns REAL fields: gross = revenue − cogs; accrual expenses INCLUDE cogs; net = revenue − expenses.
      expect(pnl.revenue).toBe(500);
      expect(pnl.cogs).toBe(300);
      expect(pnl.grossProfit).toBe(200);
      expect(pnl.expenses).toBe(380); // 300 cogs + 80 operating (accrual includes cogs)
      expect(pnl.netProfit).toBe(120);
      // The reports tab renders operating expenses as gross − net; must equal expenses − cogs
      // under accrual and never double-count cogs.
      expect(pnl.grossProfit - pnl.netProfit).toBe(80);
      expect(pnl.grossProfit - pnl.netProfit).toBe(pnl.expenses - pnl.cogs);
    } finally { close(); }
  });

  it('rejects when the requested V2 book does not exist', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      await expect(persistentV2Reports(runner, { bookId: 'missing' })).rejects.toThrow(/not found/i);
    } finally { close(); }
  });

  it('surfaces a persistent report read failure instead of silently changing accounting engines', async () => {
    const broken = {
      all: async () => [],
      first: async () => { throw new Error('database unavailable'); },
      exec: async () => undefined,
      run: async () => undefined,
    } satisfies SqlRunner;
    await expect(persistentV2Reports(broken, { bookId: 'default' })).rejects.toThrow('database unavailable');
  });

  it('keeps trial balance and balance sheet cumulative as of `to` while P&L/details honor `from`', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const repo = new V2SqlRepository(runner);
      const book = defaultBook('as-of-book', 'As Of Shop');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'as-of:p', bookId: book.id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
      await repo.postJournal({ bookId: book.id, periodId: 'as-of:p', date: '2026-01-01', memo: 'Opening capital', lines: [
        { accountId: 'as-of-book:account:1000', debit: 1000, credit: 0 },
        { accountId: 'as-of-book:account:3000', debit: 0, credit: 1000 },
      ] });
      await repo.postJournal({ bookId: book.id, periodId: 'as-of:p', date: '2026-02-10', memo: 'February sale', lines: [
        { accountId: 'as-of-book:account:1000', debit: 250, credit: 0 },
        { accountId: 'as-of-book:account:4000', debit: 0, credit: 250 },
      ] });

      const result = await persistentV2Reports(runner, { bookId: book.id, from: '2026-02-01', to: '2026-02-28' });
      expect(result.report.journalCount).toBe(1);
      expect(result.report.details.map((line) => line.date)).toEqual(['2026-02-10', '2026-02-10']);
      expect(result.report.trialBalance.totals).toEqual({ debit: 1250, credit: 1250, difference: 0 });
      expect(result.report.profitAndLoss).toEqual({ revenue: 250, expenses: 0, cogs: 0, grossProfit: 250, netProfit: 250 });
      expect(result.report.balanceSheet).toMatchObject({ assets: 1250, equity: 1000, currentEarnings: 250, balanced: true });
    } finally {
      close();
    }
  });

  it('applies a negative open-period COGS estimate as a balanced inventory reversal', () => {
    const book = defaultBook('negative-cogs-book', 'Negative COGS Shop');
    const report = buildV2Reports({
      books: [book],
      accounts: defaultAccounts(book.id),
      parties: [],
      journals: [],
      sources: [],
      allocations: [],
    }, {
      bookId: book.id,
      to: '2026-12-31',
      cogsAdjustment: {
        cogsAccountId: `${book.id}:account:5000`,
        inventoryAccountId: `${book.id}:account:1200`,
        amount: -20,
      },
    });

    expect(report.trialBalance.totals).toEqual({ debit: 20, credit: 20, difference: 0 });
    expect(report.profitAndLoss).toEqual({ revenue: 0, expenses: -20, cogs: -20, grossProfit: 20, netProfit: 20 });
    expect(report.balanceSheet).toMatchObject({ assets: 20, currentEarnings: 20, balanced: true });
    expect(report.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: '5000', debit: 0, credit: 20 }),
      expect.objectContaining({ accountCode: '1200', debit: 20, credit: 0 }),
    ]));
  });
});
