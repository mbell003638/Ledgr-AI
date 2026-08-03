/**
 * Cross-surface profit consistency (audit C1/C2).
 *
 * Seeds one ledger (opening stock, purchases, sales, expenses, a physical count)
 * and proves the four profit surfaces agree:
 *   - buildV2Reports (journal-authoritative P&L, COGS included)
 *   - getV2Dashboard
 *   - the partnership investor ledger's in-period profit basis
 *   - the period-close snapshot
 *
 * Uses the audit's known repro: opening 200, purchases 400, closing count 250,
 * sales 1000, expenses 50. Gross profit = 1000 − COGS(350) = 650.
 *  - commission 0%   → net profit 600 on every surface (incl. buildV2Reports).
 *  - commission 10%  → user-facing net profit 535 on dashboard/investor/close
 *                      (the number the audit says close must report), with reports
 *                      still exposing the COGS-aware gross (650) and pre-commission
 *                      net (600) — never the old COGS-blind 950.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import { V2InvestorLedgerService } from '../src/accountingV2/investorLedgerService';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';
import { getV2Dashboard } from '../src/accountingV2/v2Dashboard';
import { V2BookConfigRepository } from '../src/accountingV2/bookConfigRepository';

async function seed(commissionPct: number) {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const base = new V2SqlRepository(node.runner);
  const book = defaultBook('consistency', 'Consistency Shop', 'retail_partnership');
  // Create via config repo so the persona config carries the commission percentage and
  // the book is the active book (dashboard config reads commissionPct from there).
  const configRepo = new V2BookConfigRepository(node.runner);
  await configRepo.createBook(book, ['retail']);
  for (const account of defaultAccounts(book.id)) {
    await node.runner.run('INSERT INTO v2_accounts(id,book_id,code,name,type,payment_method,active) VALUES(?,?,?,?,?,?,?)',
      [account.id, book.id, account.code, account.name, account.type, account.paymentMethod || null, 1]);
  }
  await base.createPeriod({ id: 'p1', bookId: book.id, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' });
  await base.createPeriod({ id: 'p2', bookId: book.id, startDate: '2026-02-01', endDate: '2026-02-28', status: 'open' });
  const closeRepo = new V2CloseBooksRepository(node.runner);
  await configRepo.updateBookConfig(book.id, {
    style: 'retail_partnership', basis: 'accrual', selectedPersonas: ['retail'], activePersona: 'retail',
    retailPartnership: { enabled: true, commissionPct, inventoryCadence: 'monthly', members: [{ id: 'm1', name: 'Solo', openingContribution: 0, profitSharePct: 100 }] },
  });

  const acct = (code: string) => `${book.id}:account:${code}`;
  const post = (id: string, date: string, lines: [string, number, number][]) => base.postJournal({
    id, bookId: book.id, periodId: 'p1', date, memo: id,
    lines: lines.map(([code, d, c]) => ({ accountId: acct(code), debit: d, credit: c })),
  });
  // Opening inventory recorded as a physical count on the period start (opening stock 200).
  await closeRepo.recordInventoryCount({ id: 'open', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
  // A closing physical count of 250 within the period drives periodic COGS in the open period too.
  await closeRepo.recordInventoryCount({ id: 'close', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 250 });
  await post('sale', '2026-01-10', [['1000', 1000, 0], ['4000', 0, 1000]]);
  await post('purchase', '2026-01-15', [['1200', 400, 0], ['2000', 0, 400]]);
  await post('expense', '2026-01-20', [['6000', 50, 0], ['1000', 0, 50]]);

  return { ...node, base, closeRepo, book, investor: new V2InvestorLedgerService(node.runner) };
}

describe('cross-surface profit consistency', () => {
  it('agrees across reports, dashboard, investor, and close with no commission', async () => {
    const { runner, close, base, closeRepo, book, investor } = await seed(0);
    try {
      const reports = await buildPersistentV2Reports(runner, { bookId: book.id });
      // COGS is reflected in the open-period P&L.
      expect(reports.profitAndLoss.cogs).toBe(350);
      expect(reports.profitAndLoss.grossProfit).toBe(650);
      expect(reports.profitAndLoss.netProfit).toBe(600);
      expect(reports.balanceSheet.balanced).toBe(true);

      const dash = await getV2Dashboard(runner, book.id);
      expect(dash.grossProfit).toBe(650);
      expect(dash.netProfit).toBe(600);

      const detail = await investor.detail(book.id, 'Solo');
      expect(detail.profitShare).toBe(600); // 100% of 600

      const result = await closeRepo.closeBooks({ id: 'c', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 0 });
      expect(result.snapshot.netProfit).toBe(600);

      // The one unified number, everywhere.
      expect(new Set([reports.profitAndLoss.netProfit, dash.netProfit, detail.profitShare, result.snapshot.netProfit]).size).toBe(1);
    } finally { close(); }
  });

  it('reports the audit repro as 535 (not 950) on dashboard/investor/close with 10% commission', async () => {
    const { runner, close, closeRepo, book, investor } = await seed(10);
    try {
      const reports = await buildPersistentV2Reports(runner, { bookId: book.id });
      // Reports are COGS-aware; pre-commission net is 600, NEVER the old COGS-blind 950.
      expect(reports.profitAndLoss.grossProfit).toBe(650);
      expect(reports.profitAndLoss.netProfit).toBe(600);
      expect(reports.profitAndLoss.netProfit).not.toBe(950);

      const dash = await getV2Dashboard(runner, book.id);
      expect(dash.commission).toBe(65);
      expect(dash.netProfit).toBe(535);

      const detail = await investor.detail(book.id, 'Solo');
      expect(detail.profitShare).toBe(535); // 100% of 535

      const result = await closeRepo.closeBooks({ id: 'c', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-01-31', commissionPct: 10 });
      expect(result.snapshot.netProfit).toBe(535);

      // User-facing net profit agrees across dashboard, investor, and close.
      expect(new Set([dash.netProfit, detail.profitShare, result.snapshot.netProfit]).size).toBe(1);
    } finally { close(); }
  });
});
