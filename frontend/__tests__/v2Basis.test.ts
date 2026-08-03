/**
 * V2 accounting-basis P&L (audit M3).
 *
 * The `basis` book setting was stored but never read by buildV2Reports. These tests
 * prove it is now honored:
 *   - accrual (default): an unpaid invoice IS revenue when raised.
 *   - cash: revenue counts only cash sales + amounts received against invoices; an unpaid
 *     invoice is absent from cash revenue until a receipt lands.
 *   - the accrual balance sheet still balances regardless of the P&L basis.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { postCashSale, postInvoice, postReceipt, postExpense } from '../src/accountingV2/postings';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';

async function setup(basis: 'accrual' | 'cash') {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = { ...defaultBook('basis-book', 'Basis Shop'), basis };
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'p', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
  await repo.createParty({ id: 'cust', bookId: book.id, name: 'Customer', roles: ['customer'] });
  return { ...node, repo, book };
}

describe('V2 accounting basis — revenue recognition', () => {
  it('accrual counts an unpaid invoice as revenue', async () => {
    const { runner, close, repo, book } = await setup('accrual');
    try {
      await postCashSale(repo, { bookId: book.id, periodId: 'p', date: '2026-07-10', amount: 100, method: 'cash' });
      await postInvoice(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-10', amount: 200 });
      const reports = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(reports.profitAndLoss.revenue).toBe(300); // 100 cash + 200 invoice
      expect(reports.balanceSheet.balanced).toBe(true);
    } finally { close(); }
  });

  it('cash excludes an unpaid invoice until a receipt is recorded', async () => {
    const { runner, close, repo, book } = await setup('cash');
    try {
      await postCashSale(repo, { bookId: book.id, periodId: 'p', date: '2026-07-10', amount: 100, method: 'cash' });
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-10', amount: 200 });

      // Before any receipt: cash revenue = 100 (cash sale only); the 200 invoice is excluded.
      let reports = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(reports.profitAndLoss.revenue).toBe(100);
      expect(reports.balanceSheet.balanced).toBe(true); // accrual BS still balances

      // Receive 120 against the invoice → cash revenue becomes 100 + 120 = 220.
      await postReceipt(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-12', amount: 120, method: 'cash', allocations: [{ invoiceSourceId: invoice.source.id, amount: 120 }] });
      reports = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(reports.profitAndLoss.revenue).toBe(220);
    } finally { close(); }
  });

  it('cash expenses recognize operating expenses when paid', async () => {
    const { runner, close, repo, book } = await setup('cash');
    try {
      await postCashSale(repo, { bookId: book.id, periodId: 'p', date: '2026-07-10', amount: 500, method: 'cash' });
      await postExpense(repo, { bookId: book.id, periodId: 'p', date: '2026-07-11', amount: 80, method: 'cash' });
      const reports = await buildPersistentV2Reports(runner, { bookId: book.id });
      expect(reports.profitAndLoss.revenue).toBe(500);
      expect(reports.profitAndLoss.expenses).toBe(80);
      expect(reports.profitAndLoss.netProfit).toBe(420);
    } finally { close(); }
  });
});
