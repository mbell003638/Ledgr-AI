import { initSchema } from '../src/db/schema';
import { makeNodeRunner } from './helpers/nodeRunner';
import { makeSyncOperation, nextDeviceSequence, listPendingSyncOperations, markSyncOperationAccepted, withSyncOperation } from '../src/sync/outbox';

describe('offline-first sync foundation', () => {
  it('commits a local mutation and outbox operation together', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const op = makeSyncOperation({
        bookId: 'book-1', bookEpoch: 'epoch-1', deviceId: 'device-1', deviceSequence: 1,
        actorId: 'actor-1', commandType: 'transaction.create', aggregateId: 'tx-1', baseRevision: null,
        dependencies: [], payload: { sourceId: 'source-1', totalMinor: 1250 }, payloadHash: 'a'.repeat(64),
        clientCreatedAt: '2026-08-20T00:00:00.000Z',
      });
      await withSyncOperation(runner, op, async () => {
        await runner.run('INSERT INTO meta(key,value) VALUES(?,?)', ['sync-test', 'created']);
      });
      expect(await runner.first('SELECT value FROM meta WHERE key=?', ['sync-test'])).toEqual({ value: 'created' });
      expect(await listPendingSyncOperations(runner, 'book-1')).toHaveLength(1);
    } finally { close(); }
  });

  it('allocates monotonic device sequences and marks accepted retries idempotently', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      expect(await nextDeviceSequence(runner, 'book-1', 'device-1', 'epoch-1')).toBe(1);
      expect(await nextDeviceSequence(runner, 'book-1', 'device-1', 'epoch-1')).toBe(2);
      const op = makeSyncOperation({
        bookId: 'book-1', bookEpoch: 'epoch-1', deviceId: 'device-1', deviceSequence: 1,
        actorId: 'actor-1', commandType: 'party.patch', aggregateId: 'party-1', baseRevision: 0,
        dependencies: [], payload: { phone: '1' }, payloadHash: 'b'.repeat(64), clientCreatedAt: '2026-08-20T00:00:00.000Z',
      });
      await withSyncOperation(runner, op, async () => undefined);
      await markSyncOperationAccepted(runner, op.opId, 12);
      expect(await runner.first('SELECT status,accepted_book_sequence FROM sync_outbox WHERE op_id=?', [op.opId])).toEqual({ status: 'accepted', accepted_book_sequence: 12 });
    } finally { close(); }
  });

  it('rolls back the local mutation when outbox insertion cannot complete', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initSchema(runner);
      const op = makeSyncOperation({
        bookId: 'book-1', bookEpoch: 'epoch-1', deviceId: 'device-1', deviceSequence: 1,
        actorId: 'actor-1', commandType: 'transaction.create', aggregateId: 'tx-rollback', baseRevision: null,
        dependencies: [], payload: { totalMinor: 500 }, payloadHash: 'c'.repeat(64), clientCreatedAt: '2026-08-20T00:00:00.000Z',
      });
      await expect(withSyncOperation(runner, op, async () => {
        await runner.run('INSERT INTO meta(key,value) VALUES(?,?)', ['sync-rollback', 'visible']);
        throw new Error('simulated local failure');
      })).rejects.toThrow('simulated local failure');
      expect(await runner.first('SELECT value FROM meta WHERE key=?', ['sync-rollback'])).toBeNull();
      expect(await runner.first('SELECT op_id FROM sync_outbox WHERE op_id=?', [op.opId])).toBeNull();
    } finally { close(); }
  });
});
