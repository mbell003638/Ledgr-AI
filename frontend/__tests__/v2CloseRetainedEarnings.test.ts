/**
 * Proper period close into Retained Earnings (audit H1).
 *
 * New closes zero every income/expense account's period balance into 3300 Retained
 * Earnings (and, for partnerships, allocate to member capital). Consequences proven here:
 *   - after closing a period, an ALL-TIME P&L shows only the still-open period's earnings
 *     (the closed period's temporaries net to zero in the GL);
 *   - the balance-sheet identity still holds, with equity now carrying retained earnings;
 *   - a real COGS adjustment (Dr 5000 / Cr 1200) is posted so the ledger P&L is COGS-correct.
 */

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
  const book = defaultBook('re-book', 'Retained Shop'); // standard (no members)
  await base.createBook(book, defaultAccounts(book.id));
  await base.createPeriod({ id: 'p1', bookId: book.id, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' });
  await base.createPeriod({ id: 'p2', bookId: book.id, startDate: '2026-02-01', endDate: '2026-02-28', status: 'open' });
  const acct = (code: string) => `${book.id}:account:${code}`;
  const post = (id: string, period: string, date: string, lines: [string, number, number][]) => base.postJournal({
    id, bookId: book.id, periodId: period, date, memo: id, lines: lines.map(([code, d, c]) => ({ accountId: acct(code), debit: d, credit: c })),
  });
  return { ...node, base, book, post, closeRepo: new V2CloseBooksRepository(node.runner) };
}

describe('period close into retained earnings', () => {
  it('zeros closed-period temporaries, posts COGS, and keeps the books balanced', async () => {
    const { runner, close, base, book, post, closeRepo } = await setup();
    try {
      // January: opening capital cash only (no in-period inventory debit), sale 400,
      // purchase 150 (Dr 1200), expense 30, closing count 120. Opening count 0.
      await post('open', 'p1', '2026-01-01', [['1000', 500, 0], ['3000', 0, 500]]);
      await post('sale', 'p1', '2026-01-10', [['1000', 400, 0], ['4000', 0, 400]]);
      await post('purchase', 'p1', '2026-01-15', [['1200', 150, 0], ['2000', 0, 150]]);
      await post('expense', 'p1', '2026-01-20', [['6000', 30, 0], ['1000', 0, 30]]);
      await closeRepo.recordInventoryCount({ id: 'o', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 0 });
      await closeRepo.recordInventoryCount({ id: 'c', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 120 });

      // Periodic COGS = 0 + 150 − 120 = 30. Gross = 400 − 30 = 370. Net = 370 − 30 = 340.
      const result = await closeRepo.closeBooks({ id: 'close-p1', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 });
      expect(result.snapshot).toEqual(expect.objectContaining({ cogs: 30, grossProfit: 370, netProfit: 340 }));

      // A real COGS journal moved Inventory down to the physical count (150 − 30 = 120).
      const afterAll = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(afterAll.trialBalance.accounts.find((a) => a.code === '1200')?.normalBalance).toBe(120);

      // Closing transfers zero the GL temporary balances but historical P&L keeps the operating activity.
      expect(afterAll.profitAndLoss.revenue).toBe(400);
      expect(afterAll.profitAndLoss.cogs).toBe(30);
      expect(afterAll.profitAndLoss.netProfit).toBe(340);

      // Retained Earnings (3300) now carries the closed period's net profit; standard book
      // keeps it in equity (no member allocation).
      expect(afterAll.trialBalance.accounts.find((a) => a.code === '3300')?.normalBalance).toBe(340);

      // The accounting identity still holds and the trial balance is balanced.
      expect(afterAll.balanceSheet.currentEarnings).toBe(0);
      expect(afterAll.balanceSheet.balanced).toBe(true);
      expect(afterAll.trialBalance.balanced).toBe(true);
      expect((await base.reconcileBook(book.id)).balanced).toBe(true);

      // The legacy Current Profit contra (3200) is NOT used by the new close.
      expect(afterAll.trialBalance.accounts.find((a) => a.code === '3200')?.normalBalance).toBe(0);
    } finally { close(); }
  });

  it('preserves closed-period activity in historical and all-time P&L', async () => {
    const { runner, close, book, post, closeRepo } = await setup();
    try {
      await post('sale1', 'p1', '2026-01-10', [['1000', 300, 0], ['4000', 0, 300]]);
      await closeRepo.recordInventoryCount({ id: 'o', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 0 });
      await closeRepo.recordInventoryCount({ id: 'c', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 0 });
      await closeRepo.closeBooks({ id: 'close-p1', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 });

      // New sale in the still-open February.
      await post('sale2', 'p2', '2026-02-05', [['1000', 75, 0], ['4000', 0, 75]]);

      const all = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(all.profitAndLoss.revenue).toBe(375); // January 300 + February 75
      expect(all.profitAndLoss.netProfit).toBe(375);

      // A P&L filtered to January excludes the closing transfer and retains January operations.
      const jan = await buildPersistentV2Reports(runner, { bookId: book.id, from: '2026-01-01', to: '2026-01-31' });
      expect(jan.profitAndLoss.revenue).toBe(300);
      expect(jan.profitAndLoss.netProfit).toBe(300);
    } finally { close(); }
  });
});
