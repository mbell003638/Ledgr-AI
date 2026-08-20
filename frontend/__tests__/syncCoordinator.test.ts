const asyncMem: Record<string, string> = {};
const secureMem: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => asyncMem[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => { asyncMem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete asyncMem[key]; }),
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => secureMem[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { secureMem[key] = value; }),
  deleteItemAsync: jest.fn(async (key: string) => { delete secureMem[key]; }),
}));

import { initSchema } from '../src/db/schema';
import { makeNodeRunner } from './helpers/nodeRunner';
import { makeSyncOperation, enqueueSyncOperation } from '../src/sync/outbox';
import { hashPayload } from '../src/sync/protocol';
import { completeSyncRecovery, markSyncRecoveryRequired, syncNow } from '../src/sync/coordinator';

const bookId = 'book-coordinator';
const epoch = 'epoch-coordinator';
const deviceId = 'device-coordinator';
const tokenKey = `ledgr:sync:${bookId}:access-token`;

function profileSql() {
  return `INSERT INTO sync_profiles(id,server_url,user_id,device_id,actor_id,book_epoch,enabled,protocol_version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,1,?,?)`;
}

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const timestamp = '2026-08-20T00:00:00.000Z';
  await node.runner.run(profileSql(), [bookId, 'https://sync.example.test', 'user-coordinator', deviceId, 'user-coordinator', epoch, timestamp, timestamp]);
  await node.runner.run('INSERT INTO sync_book_state(book_id,book_epoch,server_cursor,updated_at) VALUES(?,?,0,?)', [bookId, epoch, timestamp]);
  secureMem[tokenKey] = JSON.stringify('token-coordinator');
  return node;
}

function canonical(op: ReturnType<typeof makeSyncOperation>, bookSequence: number) {
  return { ...op, aggregateRevision: 1, bookSequence, acceptedAt: '2026-08-20T00:00:01.000Z' };
}

describe('sync coordinator safety', () => {
  beforeEach(() => {
    for (const key of Object.keys(asyncMem)) delete asyncMem[key];
    for (const key of Object.keys(secureMem)) delete secureMem[key];
    jest.restoreAllMocks();
  });

  it('uses pull, push, pull ordering and commits the final cursor', async () => {
    const { runner, close } = await setup();
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId, deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-1', baseRevision: 0, dependencies: [],
      payload: { id: 'party-1', patch: { phone: '1' } }, payloadHash: hashPayload({ id: 'party-1', patch: { phone: '1' } }),
      clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    await enqueueSyncOperation(runner, op);
    const calls: string[] = [];
    let pullCount = 0;
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method || 'GET';
      calls.push(method);
      if (method === 'POST') return { ok: true, json: async () => ({ accepted: [canonical(op, 1)], cursor: 1 }) } as Response;
      pullCount += 1;
      return { ok: true, json: async () => ({ events: pullCount === 2 ? [canonical(op, 1)] : [], cursor: pullCount === 2 ? 1 : 0, hasMore: false, checkpointHash: `checkpoint-${pullCount}` }) } as Response;
    }) as unknown as typeof fetch;
    try {
      await syncNow(runner, bookId, async () => undefined);
      expect(calls).toEqual(['GET', 'POST', 'GET']);
      expect(await runner.first<{ server_cursor: number }>('SELECT server_cursor FROM sync_book_state WHERE book_id=?', [bookId])).toEqual({ server_cursor: 1 });
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });

  it('quarantines pending work before recovery and requires explicit epoch completion', async () => {
    const { runner, close } = await setup();
    const payload = { id: 'party-recovery', patch: { phone: '7' } };
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId, deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-recovery', baseRevision: 0, dependencies: [],
      payload, payloadHash: hashPayload(payload), clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    await enqueueSyncOperation(runner, op);
    await markSyncRecoveryRequired(runner, bookId, 'restore requires reconciliation');
    expect(await runner.first<{ status: string }>('SELECT status FROM sync_outbox WHERE op_id=?', [op.opId])).toEqual({ status: 'quarantined' });
    expect(await runner.first<{ enabled: number; recovery_required: number }>('SELECT enabled,recovery_required FROM sync_profiles WHERE id=?', [bookId])).toEqual({ enabled: 0, recovery_required: 1 });
    await completeSyncRecovery(runner, bookId, 'epoch-recovered');
    expect(await runner.first<{ enabled: number; recovery_required: number; book_epoch: string }>('SELECT enabled,recovery_required,book_epoch FROM sync_profiles WHERE id=?', [bookId])).toEqual({ enabled: 1, recovery_required: 0, book_epoch: 'epoch-recovered' });
    close();
  });

  it('rolls back all remote projection writes and leaves the cursor unchanged on failure', async () => {
    const { runner, close } = await setup();
    const payload = { id: 'party-remote', patch: { phone: '9' } };
    const op = makeSyncOperation({
      bookId, bookEpoch: epoch, deviceId: 'device-remote', deviceSequence: 1, actorId: 'user-coordinator',
      commandType: 'party.patch', aggregateId: 'party-remote', baseRevision: 0, dependencies: [],
      payload, payloadHash: hashPayload(payload), clientCreatedAt: '2026-08-20T00:00:00.000Z',
    });
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ events: [canonical(op, 1)], cursor: 1, hasMore: false, checkpointHash: 'checkpoint-1' }),
    })) as unknown as typeof fetch;
    try {
      await expect(syncNow(runner, bookId, async (db) => {
        await db.run('INSERT INTO meta(key,value) VALUES(?,?)', ['remote-write', 'must-rollback']);
        throw new Error('simulated replay failure');
      })).rejects.toThrow('simulated replay failure');
      expect(await runner.first('SELECT value FROM meta WHERE key=?', ['remote-write'])).toBeNull();
      expect(await runner.first('SELECT server_cursor FROM sync_book_state WHERE book_id=?', [bookId])).toEqual({ server_cursor: 0 });
      expect(await runner.first<{ status: string; reason: string }>("SELECT status,reason FROM sync_conflicts WHERE book_id=? AND op_id=?", [bookId, op.opId])).toEqual({ status: 'open', reason: 'simulated replay failure' });
    } finally {
      global.fetch = previousFetch;
      close();
    }
  });
});
