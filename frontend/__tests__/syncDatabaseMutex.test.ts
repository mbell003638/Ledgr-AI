import { withSyncDatabaseMutationLock } from '../src/sync/databaseMutex';

describe('sync database mutation lock', () => {
  it('serializes independent SQLite mutation boundaries', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withSyncDatabaseMutationLock(async () => {
      order.push('first:start');
      await firstMayFinish;
      order.push('first:end');
    });
    const second = withSyncDatabaseMutationLock(async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('releases the next mutation after a failure', async () => {
    await expect(withSyncDatabaseMutationLock(async () => {
      throw new Error('expected failure');
    })).rejects.toThrow('expected failure');

    await expect(withSyncDatabaseMutationLock(async () => 'continued')).resolves.toBe('continued');
  });
});
