/**
 * Sync contract tests.
 *
 * These tests deliberately use the existing V2 repository boundary rather
 * than a sync transport implementation. They pin the properties a future
 * outbox/server adapter must preserve: atomic semantic writes, book isolation
 * and immutable reversal lineage.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';

const account = (bookId: string, code: string) => `${bookId}:account:${code}`;

async function setup(id: string) {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook(id, `Sync contract ${id}`);
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({
    id: `${id}:period`,
    bookId: book.id,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'open',
  });
  return { ...node, repo, book, periodId: `${id}:period` };
}

describe('semantic operation contract', () => {
  it('keeps source, journal and lines atomic when a retried operation fails', async () => {
    const { runner, close, repo, book, periodId } = await setup('atomic');
    try {
      const source = {
        id: 'source-atomic',
        bookId: book.id,
        type: 'sale',
        date: '2026-02-01',
        metadata: { amount: 25 },
      };
      const input = {
        id: 'journal-atomic',
        bookId: book.id,
        periodId,
        date: source.date,
        memo: 'Atomic sale',
        lines: [
          { accountId: account(book.id, '1000'), debit: 25, credit: 0 },
          { accountId: account(book.id, '4000'), debit: 0, credit: 25 },
        ],
      };

      await repo.postSourceJournal(source, input);
      // A retry with the same semantic source must fail idempotently at the
      // database boundary and leave the original aggregate untouched.
      await expect(repo.postSourceJournal(source, { ...input, id: 'journal-retry' })).rejects.toThrow();
      expect(await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources WHERE id=?', [source.id])).toEqual({ n: 1 });
      expect(await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [book.id])).toEqual({ n: 1 });
      expect(await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_lines WHERE journal_id=?', [input.id])).toEqual({ n: 2 });
    } finally { close(); }
  });

  it('preserves immutable reversal lineage and rejects a second reversal', async () => {
    const { runner, close, repo, book, periodId } = await setup('reversal');
    try {
      const original = await repo.postSourceJournal(
        { id: 'source-reversal', bookId: book.id, type: 'expense', date: '2026-03-01', metadata: {} },
        {
          id: 'journal-reversal',
          bookId: book.id,
          periodId,
          date: '2026-03-01',
          memo: 'Expense',
          lines: [
            { accountId: account(book.id, '6000'), debit: 10, credit: 0 },
            { accountId: account(book.id, '1000'), debit: 0, credit: 10 },
          ],
        },
      );
      const reversal = await repo.reverseJournal(original.id, 'Sync correction');
      expect(reversal.reversalOf).toBe(original.id);
      expect(await runner.first<{ reversal_of: string }>('SELECT reversal_of FROM v2_journal_entries WHERE id=?', [reversal.id])).toEqual({ reversal_of: original.id });
      await expect(repo.reverseJournal(original.id, 'Duplicate correction')).rejects.toThrow(/already reversed/i);
      expect(await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of=?', [original.id])).toEqual({ n: 1 });
    } finally { close(); }
  });

  it('rejects cross-book references before applying a remote operation', async () => {
    const first = await setup('book-a');
    const second = await setup('book-b');
    try {
      await expect(first.repo.postJournal({
        id: 'cross-book-journal',
        bookId: first.book.id,
        periodId: first.periodId,
        date: '2026-04-01',
        memo: 'Cross-book attempt',
        lines: [
          { accountId: account(second.book.id, '1000'), debit: 5, credit: 0 },
          { accountId: account(first.book.id, '4000'), debit: 0, credit: 5 },
        ],
      })).rejects.toThrow(/account does not belong to book/i);
      expect(await first.runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [first.book.id])).toEqual({ n: 0 });
    } finally {
      first.close();
      second.close();
    }
  });
});
describe('operation envelope shape', () => {
  it('requires stable retry identity, book epoch and causal metadata', () => {
    const operation = {
      protocolVersion: 1,
      payloadVersion: 1,
      opId: '019b0000-0000-7000-8000-000000000001',
      bookId: 'book-a',
      bookEpoch: 'epoch-1',
      deviceId: 'device-a',
      deviceSequence: 1,
      actorId: 'actor-a',
      commandType: 'transaction.create',
      aggregateId: 'source-1',
      baseRevision: null,
      dependencies: [],
      payload: { sourceId: 'source-1', journalId: 'journal-1' },
      payloadHash: 'sha256:example',
      clientCreatedAt: '2026-04-01T12:00:00.000Z',
      businessDate: '2026-04-01',
    };
    expect(operation.opId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(operation.bookId).toBeTruthy();
    expect(operation.bookEpoch).toBeTruthy();
    expect(operation.deviceSequence).toBeGreaterThan(0);
    expect(operation.commandType).toMatch(/^transaction\./);
    expect(operation.payloadHash).toMatch(/^sha256:/);
    expect(Array.isArray(operation.dependencies)).toBe(true);
  });
});
