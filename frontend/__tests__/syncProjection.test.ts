import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { exportBookProjection, hashBookProjection, installBookProjection } from '../src/sync/projection';
import { makeNodeRunner } from './helpers/nodeRunner';

describe('sync projection snapshots', () => {
  it('installs one Business Account atomically with the same semantic hash', async () => {
    const source = makeNodeRunner(); const target = makeNodeRunner();
    try {
      await initSchema(source.runner); await initSchema(target.runner);
      const repo = new V2SqlRepository(source.runner);
      const book = defaultBook('projection-book', 'Projection Book');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'projection-period', bookId: book.id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
      await repo.postSourceJournal(
        { id: 'projection-source', bookId: book.id, type: 'sale', date: '2026-08-20', metadata: { amount: 25 } },
        { id: 'projection-journal', bookId: book.id, periodId: 'projection-period', date: '2026-08-20', memo: 'Projection test', lines: [
          { accountId: `${book.id}:account:1000`, debit: 25, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 25 },
        ] },
      );
      const exported = await exportBookProjection(source.runner, book.id);
      const projectionHash = await hashBookProjection(source.runner, book.id);
      const snapshot = { snapshotId: 'snapshot-1', bookId: book.id, bookEpoch: 'epoch-1', throughSequence: 1, schemaVersion: exported.schemaVersion, payload: exported, payloadHash: 'unused-by-installer', checkpointHash: 'checkpoint-1', aggregateRevisions: {}, projectionHash, createdAt: '2026-08-20T00:00:00.000Z' };
      await installBookProjection(target.runner, exported, snapshot);
      expect(await hashBookProjection(target.runner, book.id)).toBe(projectionHash);
      expect(await target.runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [book.id])).toEqual({ n: 1 });
    } finally { source.close(); target.close(); }
  });

  it('rejects a snapshot that contains another book or an unknown table', async () => {
    const node = makeNodeRunner();
    try {
      await initSchema(node.runner);
      const source = makeNodeRunner();
      await initSchema(source.runner);
      const repo = new V2SqlRepository(source.runner); const book = defaultBook('expected-book', 'Expected Book');
      await repo.createBook(book, defaultAccounts(book.id));
      await repo.createPeriod({ id: 'expected-period', bookId: book.id, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' });
      const valid = await exportBookProjection(source.runner, book.id);
      const invalid = { ...valid, tables: { ...valid.tables, unknown_table: [] } };
      const snapshot = { snapshotId: 'snapshot-invalid', bookId: 'expected-book', bookEpoch: 'epoch-1', throughSequence: 0, schemaVersion: 1, payload: invalid, payloadHash: 'unused-by-installer', checkpointHash: 'checkpoint-empty', aggregateRevisions: {}, createdAt: '2026-08-20T00:00:00.000Z' };
      await expect(installBookProjection(node.runner, invalid, snapshot)).rejects.toThrow(/unknown or missing table/);
      source.close();
    } finally { node.close(); }
  });
});
