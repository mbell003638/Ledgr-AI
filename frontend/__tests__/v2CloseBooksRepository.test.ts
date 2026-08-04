import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const base = new V2SqlRepository(node.runner);
  const book = defaultBook('retail-book', 'Retail Shop', 'retail_partnership');
  await base.createBook(book, defaultAccounts(book.id));
  await base.createPeriod({ id: 'p1', bookId: book.id, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' });
  await base.createPeriod({ id: 'p2', bookId: book.id, startDate: '2026-02-01', endDate: '2026-02-28', status: 'open' });
  const account = (code: string) => `${book.id}:account:${code}`;
  const post = (id: string, date: string, lines: { code: string; debit: number; credit: number }[]) => base.postJournal({
    id, bookId: book.id, periodId: 'p1', date, memo: id,
    lines: lines.map(({ code, debit, credit }) => ({ accountId: account(code), debit, credit })),
  });
  return { ...node, base, repo: new V2CloseBooksRepository(node.runner), book, post };
}

describe('V2CloseBooksRepository — persistent inventory and close books', () => {
  it('stores inventory counts by book and period and rejects invalid ownership', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await repo.recordInventoryCount({ id: 'opening', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      await repo.recordInventoryCount({ id: 'closing', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 250 });
      await expect(repo.recordInventoryCount({ id: 'bad', bookId: book.id, periodId: 'p2', date: '2026-01-31', value: 1 })).rejects.toThrow(/outside.*period/i);
      await expect(repo.recordInventoryCount({ id: 'negative', bookId: book.id, periodId: 'p1', date: '2026-01-15', value: -1 })).rejects.toThrow(/non-negative/i);
      await expect(repo.listInventoryCounts(book.id, 'p1')).resolves.toHaveLength(2);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_inventory_counts'))?.n)).toBe(2);
    } finally { close(); }
  });

  it('derives performance from journals, snapshots full balances, and carries member capital', async () => {
    const { runner, close, repo, book, post } = await setup();
    try {
      await repo.addMember({ id: 'm1', bookId: book.id, name: 'A', openingContribution: 100, profitSharePct: 60 });
      await repo.addMember({ id: 'm2', bookId: book.id, name: 'B', openingContribution: 200, profitSharePct: 40 });
      await repo.recordInventoryCount({ id: 'opening', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      await repo.recordInventoryCount({ id: 'closing', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 250 });
      await post('opening-balances', '2026-01-01', [
        { code: '1000', debit: 500, credit: 0 }, { code: '1010', debit: 300, credit: 0 },
        { code: '1100', debit: 200, credit: 0 }, { code: '2000', debit: 0, credit: 100 },
        { code: '2100', debit: 0, credit: 50 }, { code: '3000', debit: 0, credit: 850 },
      ]);
      await post('sale', '2026-01-10', [{ code: '1000', debit: 1000, credit: 0 }, { code: '4000', debit: 0, credit: 1000 }]);
      await post('purchase', '2026-01-15', [{ code: '1200', debit: 400, credit: 0 }, { code: '2000', debit: 0, credit: 400 }]);
      await post('expense', '2026-01-20', [{ code: '6000', debit: 50, credit: 0 }, { code: '1000', debit: 0, credit: 50 }]);
      await post('drawings', '2026-01-25', [{ code: '3100', debit: 40, credit: 0 }, { code: '1000', debit: 0, credit: 40 }]);

      const result = await repo.closeBooks({
        id: 'close-p1', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 10,
      });
      expect(result.snapshot).toEqual(expect.objectContaining({
        openingInventory: 200, closingInventory: 250, inventory: 250, purchases: 400, cogs: 350,
        sales: 1000, grossProfit: 650, commission: 65, expenses: 50, drawings: 40, netProfit: 535,
        cash: 1410, bank: 300, accountsReceivable: 200, accountsPayable: 500,
        customerAdvances: 50, liabilities: 550, memberCapital: 795,
      }));
      expect(result.snapshot.memberProfitShares).toEqual([
        { memberId: 'm1', name: 'A', profitSharePct: 60, openingCapital: 100, profitShare: 321, drawings: 24, closingCapital: 397 },
        { memberId: 'm2', name: 'B', profitSharePct: 40, openingCapital: 200, profitShare: 214, drawings: 16, closingCapital: 398 },
      ]);
      expect(await runner.all('SELECT id,current_capital FROM v2_members ORDER BY id')).toEqual([
        { id: 'm1', current_capital: 397 }, { id: 'm2', current_capital: 398 },
      ]);
      expect(await repo.listInventoryCounts(book.id, 'p2')).toEqual([
        { id: 'close-p1:inventory-carry', bookId: book.id, periodId: 'p2', date: '2026-02-01', value: 250 },
      ]);

      const retry = await repo.closeBooks({ id: 'ignored', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 99 });
      expect(retry).toEqual(result);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_close_books'))?.n)).toBe(1);
      expect(await runner.all('SELECT id,current_capital FROM v2_members ORDER BY id')).toEqual([
        { id: 'm1', current_capital: 397 }, { id: 'm2', current_capital: 398 },
      ]);
    } finally { close(); }
  });

  it('unifies COGS selection with live reports: a MID-period count closes and matches the report', async () => {
    // FIX 3: the close used to require counts dated EXACTLY on the start and close dates; a
    // mid-period count showed COGS in the live report but threw at close. Now both derive COGS
    // through the shared computePeriodicCogs path (latest in-period count is the closing), so
    // dashboard == reports == close even for a mid-period count.
    const { runner, close, repo, book, post } = await setup();
    try {
      await repo.recordInventoryCount({ id: 'opening', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      // Closing count is taken on 2026-01-20 — NOT on the 2026-01-31 close date.
      await repo.recordInventoryCount({ id: 'mid', bookId: book.id, periodId: 'p1', date: '2026-01-20', value: 250 });
      await post('sale', '2026-01-10', [{ code: '1000', debit: 1000, credit: 0 }, { code: '4000', debit: 0, credit: 1000 }]);
      await post('purchase', '2026-01-15', [{ code: '1200', debit: 400, credit: 0 }, { code: '2000', debit: 0, credit: 400 }]);
      await post('expense', '2026-01-18', [{ code: '6000', debit: 50, credit: 0 }, { code: '1000', debit: 0, credit: 50 }]);

      const live = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(live.profitAndLoss.cogs).toBe(350); // 200 + 400 − 250
      expect(live.profitAndLoss.netProfit).toBe(600); // 1000 − (350 COGS + 50 opex)

      const result = await repo.closeBooks({ id: 'close-p1', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 });
      expect(result.snapshot).toEqual(expect.objectContaining({ openingInventory: 200, closingInventory: 250, cogs: 350, grossProfit: 650, expenses: 50, netProfit: 600 }));
      // The unified number: snapshot net profit equals the live report's net profit.
      expect(result.snapshot.netProfit).toBe(live.profitAndLoss.netProfit);
    } finally { close(); }
  });

  it('rejects closing an inventory-tracking period with no closing count', async () => {
    const { close, repo, book, post } = await setup();
    try {
      // Purchases (inventory activity) but no physical count → closing stock is unknown.
      await post('purchase', '2026-01-15', [{ code: '1200', debit: 400, credit: 0 }, { code: '2000', debit: 0, credit: 400 }]);
      await expect(repo.closeBooks({ id: 'c', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 }))
        .rejects.toThrow(/inventory count within the period is required/i);
    } finally { close(); }
  });

  it('closes a zero-profit period without invalid zero-value journal lines', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await repo.addMember({ id: 'm1', bookId: book.id, name: 'Only member', openingContribution: 100, profitSharePct: 100 });
      await repo.recordInventoryCount({ id: 'opening', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 100 });
      await repo.recordInventoryCount({ id: 'closing', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 100 });
      const result = await repo.closeBooks({ id: 'zero-close', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 5 });
      expect(result.snapshot.netProfit).toBe(0);
      expect(result.snapshot.memberProfitShares[0]).toMatchObject({ profitShare: 0, closingCapital: 100 });
      expect(result.journalId).toBeNull();
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_lines'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rolls back snapshot, journal, inventory, and member capital on a late failure', async () => {
    const { runner, close, repo, book, post } = await setup();
    try {
      await repo.addMember({ id: 'm1', bookId: book.id, name: 'Only member', openingContribution: 100, profitSharePct: 100 });
      await repo.recordInventoryCount({ id: 'opening', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 100 });
      await repo.recordInventoryCount({ id: 'closing', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 80 });
      await post('sale', '2026-01-10', [{ code: '1000', debit: 100, credit: 0 }, { code: '4000', debit: 0, credit: 100 }]);
      await runner.exec(`CREATE TRIGGER fail_carry BEFORE INSERT ON v2_inventory_counts
        WHEN NEW.period_id = 'p2' BEGIN SELECT RAISE(FAIL, 'injected carry failure'); END;`);

      await expect(repo.closeBooks({ id: 'rollback-close', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 })).rejects.toThrow(/injected carry failure/);
      expect(await runner.first('SELECT status,close_snapshot FROM v2_periods WHERE id=?', ['p1'])).toEqual({ status: 'open', close_snapshot: null });
      expect(await runner.first('SELECT current_capital FROM v2_members WHERE id=?', ['m1'])).toEqual({ current_capital: 100 });
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_close_books'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_journal_entries WHERE memo='Period close'"))?.n)).toBe(0);
    } finally { close(); }
  });
});
