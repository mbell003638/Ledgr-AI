import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2DocumentService } from '../src/accountingV2/documentService';
import { postInvoice } from '../src/accountingV2/postings';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('svc-book', 'Service Book');
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'period', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
  return { ...node, repo, book, service: new V2DocumentService(repo) };
}

describe('persistent V2 document service', () => {
  it('updates a party and archives only parties with no accounting sources', async () => {
    const { runner, close, repo, book, service } = await setup();
    try {
      await repo.createParty({ id: 'free', bookId: book.id, name: 'Old', roles: ['customer'] });
      await service.updateParty('free', { name: 'New', phone: '123', roles: ['customer', 'supplier'] });
      expect(await runner.first('SELECT name,phone,roles FROM v2_parties WHERE id=?', ['free'])).toEqual({ name: 'New', phone: '123', roles: '["customer","supplier"]' });
      await service.archiveParty('free');
      expect(await runner.first('SELECT archived FROM v2_parties WHERE id=?', ['free'])).toEqual({ archived: 1 });

      await repo.createParty({ id: 'used', bookId: book.id, name: 'Used', roles: ['customer'] });
      await postInvoice(repo, { bookId: book.id, periodId: 'period', partyId: 'used', date: '2026-07-10', amount: 10 });
      await expect(service.archiveParty('used')).rejects.toThrow(/source|accounting/i);
      expect(await runner.first('SELECT archived FROM v2_parties WHERE id=?', ['used'])).toEqual({ archived: 0 });
    } finally { close(); }
  });

  it('posts drawing and payable expense using the requested settlement account atomically', async () => {
    const { runner, close, book, service } = await setup();
    try {
      const drawing = await service.drawing({ bookId: book.id, periodId: 'period', date: '2026-07-20', amount: 25, method: 'cash' });
      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [drawing.journal.id])).toEqual([
        { account_id: `${book.id}:account:3100`, debit: 25, credit: 0 }, { account_id: `${book.id}:account:1000`, debit: 0, credit: 25 },
      ]);
      const expense = await service.createExpense({ bookId: book.id, periodId: 'period', date: '2026-07-20', amount: 40, payable: true });
      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [expense.journal.id])).toEqual([
        { account_id: `${book.id}:account:6000`, debit: 40, credit: 0 }, { account_id: `${book.id}:account:2000`, debit: 0, credit: 40 },
      ]);
    } finally { close(); }
  });

  it('reverses a receipt atomically on delete and leaves the original history intact', async () => {
    const { runner, close, repo, book, service } = await setup();
    try {
      await repo.createParty({ id: 'customer', bookId: book.id, name: 'Customer', roles: ['customer'] });
      const receipt = await service.recordReceipt({ bookId: book.id, periodId: 'period', partyId: 'customer', date: '2026-07-20', amount: 30, method: 'cash' });
      const deleted = await service.deleteReceipt(receipt.source.id);
      expect(await runner.first('SELECT reversal_of FROM v2_journal_entries WHERE id=?', [deleted.journal.id])).toEqual({ reversal_of: receipt.journal.id });
      expect(await runner.all('SELECT debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [deleted.journal.id])).toEqual([{ debit: 0, credit: 30 }, { debit: 30, credit: 0 }]);
      expect(await runner.first<{ deleted: number }>("SELECT json_extract(metadata,'$.deleted') AS deleted FROM v2_sources WHERE id=?", [receipt.source.id])).toEqual({ deleted: 1 });
    } finally { close(); }
  });
});
