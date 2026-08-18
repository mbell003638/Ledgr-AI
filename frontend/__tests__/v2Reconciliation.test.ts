import { defaultAccounts, defaultBook, emptyV2Store } from '../src/accountingV2/schema';
import type { V2MemoryStore } from '../src/accountingV2/schema';
import { buildV2Reports, V2ReportError } from '../src/accountingV2/reports';

const accountId = (bookId: string, code: string) => `${bookId}:account:${code}`;

function storeWithBooks(...bookIds: string[]): V2MemoryStore {
  const store = emptyV2Store();
  for (const id of bookIds) {
    store.books.push(defaultBook(id, id));
    store.accounts.push(...defaultAccounts(id));
  }
  return store;
}

function post(
  store: V2MemoryStore,
  bookId: string,
  id: string,
  date: string,
  lines: Array<[string, number, number]>,
) {
  store.journals.push({
    id,
    bookId,
    periodId: 'p1',
    date,
    memo: id,
    lines: lines.map(([code, debit, credit]) => ({ accountId: accountId(bookId, code), debit, credit })),
  });
}

describe('V2 journal-derived reports and reconciliation', () => {
  test('derives trial balance, P&L, and balance sheet entirely from postings', () => {
    const store = storeWithBooks('a');
    post(store, 'a', 'capital', '2026-01-01', [['1000', 1000, 0], ['3000', 0, 1000]]);
    post(store, 'a', 'sale', '2026-01-02', [['1000', 250, 0], ['4000', 0, 250]]);
    post(store, 'a', 'expense', '2026-01-03', [['6000', 40, 0], ['1000', 0, 40]]);

    const report = buildV2Reports(store, { bookId: 'a' });

    expect(report.trialBalance.totals).toEqual({ debit: 1290, credit: 1290, difference: 0 });
    expect(report.trialBalance.accounts.find((x) => x.code === '1000')).toMatchObject({ debit: 1250, credit: 40, balance: 1210 });
    expect(report.profitAndLoss).toMatchObject({ revenue: 250, expenses: 40, netProfit: 210 });
    expect(report.balanceSheet).toMatchObject({ assets: 1210, liabilities: 0, equity: 1000, currentEarnings: 210, difference: 0 });
    expect(report.reconciliation).toEqual({ ok: true, errors: [] });
  });

  test('applies inclusive range filtering while keeping balance reports cumulative through `to`', () => {
    const store = storeWithBooks('a');
    post(store, 'a', 'before', '2025-12-31', [['1000', 999, 0], ['3000', 0, 999]]);
    post(store, 'a', 'inside', '2026-01-15', [['1000', 75, 0], ['4000', 0, 75]]);
    post(store, 'a', 'after', '2026-02-01', [['6000', 20, 0], ['1000', 0, 20]]);

    const report = buildV2Reports(store, { bookId: 'a', from: '2026-01-01', to: '2026-01-31' });

    expect(report.journalCount).toBe(1);
    expect(report.trialBalance.totals).toEqual({ debit: 1074, credit: 1074, difference: 0 });
    expect(report.profitAndLoss.netProfit).toBe(75);
    expect(report.balanceSheet.difference).toBe(0);
  });

  test('isolates accounts and journals by book', () => {
    const store = storeWithBooks('a', 'b');
    post(store, 'a', 'a-sale', '2026-01-01', [['1000', 10, 0], ['4000', 0, 10]]);
    post(store, 'b', 'b-sale', '2026-01-01', [['1000', 900, 0], ['4000', 0, 900]]);

    const report = buildV2Reports(store, { bookId: 'a' });

    expect(report.journalCount).toBe(1);
    expect(report.profitAndLoss.revenue).toBe(10);
    expect(report.trialBalance.accounts.every((x) => x.bookId === 'a')).toBe(true);
  });

  test('returns structured reconciliation errors for an unbalanced journal and equation', () => {
    const store = storeWithBooks('a');
    post(store, 'a', 'broken', '2026-01-01', [['1000', 100, 0], ['3000', 0, 90]]);

    const report = buildV2Reports(store, { bookId: 'a' });

    expect(report.reconciliation.ok).toBe(false);
    expect(report.reconciliation.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOURNAL_UNBALANCED', journalId: 'broken', difference: 10 }),
      expect.objectContaining({ code: 'TRIAL_BALANCE_OUT_OF_BALANCE', difference: 10 }),
      expect.objectContaining({ code: 'BALANCE_SHEET_OUT_OF_BALANCE', difference: 10 }),
    ]));
  });

  test('rejects invalid range and reports unknown posting accounts structurally', () => {
    const store = storeWithBooks('a');
    expect(() => buildV2Reports(store, { bookId: 'a', from: '2026-02-01', to: '2026-01-01' }))
      .toThrow(V2ReportError);

    store.journals.push({ id: 'bad-account', bookId: 'a', periodId: 'p', date: '2026-01-01', memo: '', lines: [
      { accountId: 'missing', debit: 1, credit: 0 },
      { accountId: accountId('a', '3000'), debit: 0, credit: 1 },
    ] });
    const report = buildV2Reports(store, { bookId: 'a' });
    expect(report.reconciliation.errors).toContainEqual(expect.objectContaining({
      code: 'UNKNOWN_ACCOUNT', journalId: 'bad-account', accountId: 'missing',
    }));
  });
});
