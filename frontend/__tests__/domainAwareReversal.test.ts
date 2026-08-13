import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2DocumentService } from '../src/accountingV2/documentService';
import { postExpense } from '../src/accountingV2/postings';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const documents = new V2DocumentService(repo);
  const book = defaultBook('book-reversal', 'Reversal Test Shop');
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'period-rev', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
  return { ...node, repo, documents, book };
}

describe('Domain-Aware Reversal Engine', () => {
  it('reverses an expense and updates source metadata with reversed flag', async () => {
    const { runner, close, repo, documents, book } = await setup();
    try {
      const posted = await postExpense(repo, {
        bookId: book.id,
        periodId: 'period-rev',
        date: '2026-07-15',
        amount: 50,
        method: 'cash',
        metadata: { category: 'Office Supplies', reference: 'SUP-1' },
      });

      expect(posted.source.id).toBeTruthy();

      const reversal = await documents.reverseSource(posted.source.id, 'expense', 'Undo expense', true);
      expect(reversal.source.id).toBeTruthy();

      const sourceRow = await runner.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=?', [posted.source.id]);
      const meta = JSON.parse(sourceRow?.metadata || '{}');
      expect(meta.reversed).toBe(1);
      expect(meta.deleted).toBe(1);
    } finally {
      close();
    }
  });

  it('blocks double reversal on the same source', async () => {
    const { close, repo, documents, book } = await setup();
    try {
      const posted = await postExpense(repo, {
        bookId: book.id,
        periodId: 'period-rev',
        date: '2026-07-15',
        amount: 30,
        method: 'cash',
        metadata: { category: 'Travel' },
      });

      await documents.reverseSource(posted.source.id, 'expense', 'Undo expense first time', true);
      await expect(
        documents.reverseSource(posted.source.id, 'expense', 'Undo expense second time', true)
      ).rejects.toThrow(/already been reversed/i);
    } finally {
      close();
    }
  });
});
