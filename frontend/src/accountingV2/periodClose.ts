import type { V2Ledger } from './ledger';
import type { V2Member } from './types';
import { round2 } from '../money';

export type CloseResult = { periodId: string; netProfit: number; closingCapital: number; snapshot: Record<string, number>; journalId: string };
const cents = round2;

export function retailNetProfit(sales: number, openingInventory: number, purchases: number, closingInventory: number, commissionPct: number, expenses: number) {
  const cogs = cents(openingInventory + purchases - closingInventory);
  const grossProfit = cents(sales - cogs);
  const commission = grossProfit > 0 ? cents(grossProfit * commissionPct / 100) : 0;
  const netProfit = cents(grossProfit - commission - expenses);
  return { cogs, grossProfit, commission, netProfit };
}

export function closeBooks(ledger: V2Ledger, bookId: string, periodId: string, date: string, input: { sales: number; openingInventory: number; purchases: number; closingInventory: number; commissionPct: number; expenses: number; members: V2Member[] }): CloseResult {
  const existing = ledger.store.journals.find((j) => j.bookId === bookId && j.periodId === periodId && j.memo === 'Period close');
  if (existing) throw new Error('Period is already closed');
  const result = retailNetProfit(input.sales, input.openingInventory, input.purchases, input.closingInventory, input.commissionPct, input.expenses);
  const memberTotal = input.members.reduce((s, x) => s + x.profitSharePct, 0);
  if (input.members.length && Math.abs(memberTotal - 100) > 0.005) throw new Error('Member profit shares must total 100%');
  const snapshot = { sales: cents(input.sales), openingInventory: cents(input.openingInventory), purchases: cents(input.purchases), closingInventory: cents(input.closingInventory), cogs: result.cogs, grossProfit: result.grossProfit, commission: result.commission, expenses: cents(input.expenses), netProfit: result.netProfit };
  const capital = ledger.store.accounts.find((a) => a.bookId === bookId && a.code === '3000');
  const currentProfit = ledger.store.accounts.find((a) => a.bookId === bookId && a.code === '3200');
  if (!capital || !currentProfit) throw new Error('Capital accounts missing');
  // The commission is subtracted from net profit above and recorded in the
  // snapshot, but no journal line ever posted it, so the ledger balanced while
  // understating both expenses and liabilities by the commission and recording
  // the amount owed nowhere. Post it like closeBooksRepository already does.
  const commissionExpense = ledger.store.accounts.find((a) => a.bookId === bookId && a.code === '6100');
  const commissionPayable = ledger.store.accounts.find((a) => a.bookId === bookId && a.code === '2200');
  if (result.commission > 0 && (!commissionExpense || !commissionPayable)) {
    throw new Error('Commission accounts missing');
  }
  if (result.commission > 0 && commissionExpense && commissionPayable) {
    ledger.post({
      bookId, periodId, date, memo: 'Commission expense',
      lines: [
        { accountId: commissionExpense.id, debit: result.commission, credit: 0 },
        { accountId: commissionPayable.id, debit: 0, credit: result.commission },
      ],
    });
  }
  // Capital equity is credit-balanced, so ledger.balance (debit - credit)
  // returns it negated; read it before the close journal moves profit across.
  const capitalBefore = cents(-ledger.balance(bookId, capital.id));
  const amount = Math.abs(result.netProfit);
  const lines = result.netProfit >= 0
    ? [{ accountId: currentProfit.id, debit: amount, credit: 0 }, { accountId: capital.id, debit: 0, credit: amount }]
    : [{ accountId: capital.id, debit: amount, credit: 0 }, { accountId: currentProfit.id, debit: 0, credit: amount }];
  const journal = ledger.post({ bookId, periodId, date, memo: 'Period close', lines });
  // closingCapital used to carry netProfit, so a book with 500,000 of capital
  // and 40,000 of profit reported 40,000 as its closing capital.
  return { periodId, netProfit: result.netProfit, closingCapital: cents(capitalBefore + result.netProfit), snapshot, journalId: journal.id };
}
