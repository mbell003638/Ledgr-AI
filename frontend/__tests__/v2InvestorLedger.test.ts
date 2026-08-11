import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import { V2InvestorLedgerService } from '../src/accountingV2/investorLedgerService';

async function setup(style: 'standard' | 'retail_partnership' = 'retail_partnership') {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('investor-book', 'Investor Book', style);
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'p1', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
  await repo.createPeriod({ id: 'p2', bookId: book.id, startDate: '2026-08-01', endDate: '2026-08-31', status: 'open' });
  const closeRepo = new V2CloseBooksRepository(node.runner);
  if (style === 'retail_partnership') {
    await closeRepo.addMember({ id: 'alice', bookId: book.id, name: 'Alice', openingContribution: 100, profitSharePct: 60 });
    await closeRepo.addMember({ id: 'bob', bookId: book.id, name: 'Bob', openingContribution: 200, profitSharePct: 40 });
  }
  return { ...node, repo, book, closeRepo, ledger: new V2InvestorLedgerService(node.runner) };
}

describe('V2 partnership investor ledger', () => {
  it('posts balanced cash/capital and drawings journals and calculates partner standing', async () => {
    const { runner, close, repo, book, ledger } = await setup();
    try {
      const deposit = await ledger.deposit({ bookId: book.id, memberId: 'alice', date: '2026-07-10', amount: 50, notes: 'Working capital' });
      const drawing = await ledger.draw({ bookId: book.id, memberId: 'alice', date: '2026-07-12', amount: 20, notes: 'Personal withdrawal' });
      await repo.postJournal({ id: 'profit', bookId: book.id, periodId: 'p1', date: '2026-07-15', memo: 'Sale', lines: [
        { accountId: `${book.id}:account:1000`, debit: 100, credit: 0 },
        { accountId: `${book.id}:account:4000`, debit: 0, credit: 100 },
      ] });

      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [deposit.journal.id])).toEqual([
        { account_id: `${book.id}:account:1000`, debit: 50, credit: 0 },
        { account_id: `${book.id}:account:3000`, debit: 0, credit: 50 },
      ]);
      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [drawing.journal.id])).toEqual([
        { account_id: `${book.id}:account:3100`, debit: 20, credit: 0 },
        { account_id: `${book.id}:account:1000`, debit: 0, credit: 20 },
      ]);

      await expect(ledger.detail(book.id, 'alice')).resolves.toEqual(expect.objectContaining({
        name: 'Alice', openingCapital: 100, totalInjected: 50, totalDrawings: 20,
        profitShare: 60, currentCapitalBalance: 190,
      }));
      expect((await ledger.detail(book.id, 'alice')).transactions.map((item) => item.type)).toEqual(expect.arrayContaining(['opening_capital', 'capital_injection', 'drawing']));
      expect((await repo.reconcileBook(book.id)).balanced).toBe(true);
      expect(close).toBeDefined();
    } finally { close(); }
  });

  it('uses actual partner drawings and deposits when carrying capital into the next period', async () => {
    const { runner, closeRepo, repo, book, ledger, close } = await setup();
    try {
      await ledger.deposit({ bookId: book.id, memberId: 'alice', date: '2026-07-05', amount: 50 });
      await ledger.draw({ bookId: book.id, memberId: 'alice', date: '2026-07-06', amount: 30 });
      await ledger.draw({ bookId: book.id, memberId: 'bob', date: '2026-07-07', amount: 10 });
      await repo.postJournal({ id: 'sale', bookId: book.id, periodId: 'p1', date: '2026-07-10', memo: 'Sale', lines: [
        { accountId: `${book.id}:account:1000`, debit: 100, credit: 0 },
        { accountId: `${book.id}:account:4000`, debit: 0, credit: 100 },
      ] });
      await closeRepo.recordInventoryCount({ id: 'open', bookId: book.id, periodId: 'p1', date: '2026-07-01', value: 0 });
      await closeRepo.recordInventoryCount({ id: 'close', bookId: book.id, periodId: 'p1', date: '2026-07-31', value: 0 });

      const result = await closeRepo.closeBooks({ id: 'close-p1', bookId: book.id, periodId: 'p1', nextPeriodId: 'p2', date: '2026-07-31', commissionPct: 0 });
      expect(result.snapshot.memberProfitShares).toEqual([
        { memberId: 'alice', name: 'Alice', profitSharePct: 60, openingCapital: 100, profitShare: 60, drawings: 30, closingCapital: 180 },
        { memberId: 'bob', name: 'Bob', profitSharePct: 40, openingCapital: 200, profitShare: 40, drawings: 10, closingCapital: 230 },
      ]);
      expect(await runner.all('SELECT id,current_capital FROM v2_members ORDER BY id')).toEqual([
        { id: 'alice', current_capital: 180 }, { id: 'bob', current_capital: 230 },
      ]);
    } finally { close(); }
  });

  it('corrects and reverses a capital deposit while retaining balanced audit history', async () => {
    const { runner, repo, book, ledger, close } = await setup();
    try {
      const original = await ledger.deposit({ bookId: book.id, memberId: 'alice', date: '2026-07-10', amount: 50, notes: 'Initial amount' });
      const corrected = await ledger.updateDeposit(original.source.id, { bookId: book.id, memberId: 'alice', date: '2026-07-11', amount: 75, notes: 'Corrected amount' });

      await expect(ledger.detail(book.id, 'alice')).resolves.toEqual(expect.objectContaining({ totalInjected: 75, currentCapitalBalance: 175 }));
      expect(await runner.first('SELECT metadata FROM v2_sources WHERE id=?', [original.source.id])).toEqual(expect.objectContaining({ metadata: expect.stringContaining('"reversed":1') }));
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n)).toBe(1);

      await ledger.deleteDeposit(corrected.source.id, book.id, 'alice');
      await expect(ledger.detail(book.id, 'alice')).resolves.toEqual(expect.objectContaining({ totalInjected: 0, currentCapitalBalance: 100 }));
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n)).toBe(2);
      expect((await repo.reconcileBook(book.id)).balanced).toBe(true);
    } finally { close(); }
  });

  it('rejects investor details and postings for a standard entity book', async () => {
    const { book, ledger, close } = await setup('standard');
    try {
      await expect(ledger.detail(book.id, 'owner')).rejects.toThrow(/Partnership Mode/i);
      await expect(ledger.deposit({ bookId: book.id, memberId: 'owner', date: '2026-07-10', amount: 10 })).rejects.toThrow(/Partnership Mode/i);
    } finally { close(); }
  });
});
