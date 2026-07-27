import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';

async function setup(withAccounts = false) {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('contract-book', 'Contract Book');
  await repo.createBook(book, withAccounts ? defaultAccounts(book.id) : []);
  await repo.createPeriod({ id: 'p1', bookId: book.id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
  return { ...node, repo, book };
}

const account = (bookId: string, code: string) => `${bookId}:account:${code}`;

describe('V2SqlRepository persistent core contract', () => {
  it('ensures every default account idempotently without replacing existing rows', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await runner.run('INSERT INTO v2_accounts(id,book_id,code,name,type,payment_method,active) VALUES(?,?,?,?,?,?,?)',
        ['custom-cash', book.id, '1000', 'Till', 'asset', null, 1]);
      const first = await repo.ensureDefaultAccounts(book.id);
      const second = await repo.ensureDefaultAccounts(book.id);
      expect(first).toHaveLength(defaultAccounts(book.id).length);
      expect(second).toEqual(first);
      expect(first.find((item) => item.code === '1000')).toMatchObject({ id: 'custom-cash', name: 'Till' });
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_accounts WHERE book_id=?', [book.id]))?.n)).toBe(defaultAccounts(book.id).length);
      await expect(repo.ensureDefaultAccounts('missing-book')).rejects.toThrow(/book/i);
    } finally { close(); }
  });

  it('creates one exact, same-book reversal with debit and credit swapped', async () => {
    const { runner, close, repo, book } = await setup(true);
    try {
      const original = await repo.postJournal({ id: 'original', bookId: book.id, periodId: 'p1', date: '2026-03-01', memo: 'Sale', lines: [
        { accountId: account(book.id, '1000'), debit: 45.67, credit: 0, memo: 'received' },
        { accountId: account(book.id, '4000'), debit: 0, credit: 45.67, memo: 'earned' },
      ] });
      const reversal = await repo.reverseJournal(original.id, 'Customer refund');
      expect(reversal).toMatchObject({ bookId: book.id, periodId: original.periodId, date: original.date, reversalOf: original.id, memo: 'Customer refund' });
      expect(reversal.lines).toEqual([
        { accountId: account(book.id, '1000'), partyId: undefined, debit: 0, credit: 45.67, memo: 'received' },
        { accountId: account(book.id, '4000'), partyId: undefined, debit: 45.67, credit: 0, memo: 'earned' },
      ]);
      await expect(repo.reverseJournal(original.id, 'Again')).rejects.toThrow(/already reversed/i);
      await expect(repo.reverseJournal('missing', 'No')).rejects.toThrow(/not found/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of=?', [original.id]))?.n)).toBe(1);
    } finally { close(); }
  });

  it('calculates an account balance for one book over an inclusive range', async () => {
    const { close, repo, book } = await setup(true);
    try {
      for (const [id, date, amount] of [['before', '2026-01-31', 5], ['inside-a', '2026-02-01', 20], ['inside-b', '2026-02-28', 7], ['after', '2026-03-01', 9]] as const) {
        await repo.postJournal({ id, bookId: book.id, periodId: 'p1', date, memo: id, lines: [
          { accountId: account(book.id, '1000'), debit: amount, credit: 0 },
          { accountId: account(book.id, '4000'), debit: 0, credit: amount },
        ] });
      }
      await expect(repo.accountBalance(book.id, account(book.id, '1000'), { from: '2026-02-01', to: '2026-02-28' })).resolves.toBe(27);
      await expect(repo.accountBalance(book.id, account(book.id, '4000'), { from: '2026-02-01', to: '2026-02-28' })).resolves.toBe(-27);
      await expect(repo.accountBalance(book.id, account(book.id, '1000'), { from: '2026-03-01', to: '2026-02-01' })).rejects.toThrow(/range/i);
      await expect(repo.accountBalance(book.id, 'missing', {})).rejects.toThrow(/account/i);
    } finally { close(); }
  });

  it('reconciles an inclusive range with balance-sheet difference and structured errors', async () => {
    const { runner, close, repo, book } = await setup(true);
    try {
      await repo.postJournal({ id: 'capital', bookId: book.id, periodId: 'p1', date: '2026-01-01', memo: 'Capital', lines: [
        { accountId: account(book.id, '1000'), debit: 100, credit: 0 },
        { accountId: account(book.id, '3000'), debit: 0, credit: 100 },
      ] });
      await repo.postJournal({ id: 'outside', bookId: book.id, periodId: 'p1', date: '2026-04-01', memo: 'Outside', lines: [
        { accountId: account(book.id, '1000'), debit: 999, credit: 0 },
        { accountId: account(book.id, '4000'), debit: 0, credit: 999 },
      ] });
      await runner.run('INSERT INTO v2_journal_entries(id,book_id,period_id,date,memo,posted_at) VALUES(?,?,?,?,?,?)', ['broken', book.id, 'p1', '2026-02-01', 'Broken', '2026-02-01']);
      await runner.run('INSERT INTO v2_journal_lines(journal_id,account_id,debit,credit) VALUES(?,?,?,?)', ['broken', account(book.id, '1000'), 10, 0]);
      await runner.run('INSERT INTO v2_journal_lines(journal_id,account_id,debit,credit) VALUES(?,?,?,?)', ['broken', account(book.id, '3000'), 0, 8]);

      const result = await repo.reconcileBook(book.id, { from: '2026-01-01', to: '2026-02-28' });
      expect(result).toMatchObject({ debit: 110, credit: 108, difference: 2, balanceSheetDifference: 2, balanced: false });
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'JOURNAL_UNBALANCED', journalId: 'broken', difference: 2 }),
        expect.objectContaining({ code: 'TRIAL_BALANCE_OUT_OF_BALANCE', difference: 2 }),
        expect.objectContaining({ code: 'BALANCE_SHEET_OUT_OF_BALANCE', difference: 2 }),
      ]));
      await expect(repo.reconcileBook(book.id, { from: '2026-03-01', to: '2026-02-01' })).rejects.toThrow(/range/i);
      await expect(repo.reconcileBook('missing-book')).rejects.toThrow(/book/i);
    } finally { close(); }
  });
});
