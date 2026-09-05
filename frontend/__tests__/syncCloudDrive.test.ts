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

import {
  mockCloudStorage,
  uploadEncryptedDelta,
  fetchRemoteEncryptedDeltas,
  uploadEncryptedSnapshot,
  downloadEncryptedSnapshot,
  saveCloudConfig,
  getCloudConfig,
} from '../src/sync/cloudDriveProvider';
import { deriveKeyFromPassphrase } from '../src/sync/e2ee';
import type { SyncOperation, SyncSnapshot } from '../src/sync/protocol';

describe('cloudDriveProvider', () => {
  const salt = new Uint8Array(16).fill(5);
  const { key } = deriveKeyFromPassphrase('test-cloud-passphrase', salt);
  const bookId = 'book-test-123';

  beforeEach(() => {
    mockCloudStorage.clear();
  });

  it('saves and retrieves cloud configuration', async () => {
    await saveCloudConfig(bookId, {
      provider: 'google_drive',
      accountEmail: 'user@example.com',
      passphrase: 'test-cloud-passphrase',
      autoSyncEnabled: true,
    });

    const retrieved = await getCloudConfig(bookId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.provider).toBe('google_drive');
    expect(retrieved?.accountEmail).toBe('user@example.com');
  });

  it('uploads encrypted deltas and fetches them in sequence order', async () => {
    const op1: SyncOperation = {
      protocolVersion: 1,
      payloadVersion: 1,
      opId: 'op-1',
      bookId,
      bookEpoch: 'epoch-1',
      deviceId: 'dev-1',
      deviceSequence: 1,
      actorId: 'actor-1',
      commandType: 'RECORD_EXPENSE',
      aggregateId: 'agg-1',
      baseRevision: null,
      dependencies: [],
      payload: { amount: 50 },
      payloadHash: 'hash-1',
      clientCreatedAt: new Date().toISOString(),
    };

    const op2: SyncOperation = {
      ...op1,
      opId: 'op-2',
      deviceSequence: 2,
      payload: { amount: 120 },
      payloadHash: 'hash-2',
    };

    // Upload in reverse order
    await uploadEncryptedDelta(bookId, 2, op2, mockCloudStorage, key);
    await uploadEncryptedDelta(bookId, 1, op1, mockCloudStorage, key);

    // Fetch since sequence 0
    const ops = await fetchRemoteEncryptedDeltas(bookId, 0, mockCloudStorage, key);
    expect(ops.length).toBe(2);
    expect(ops[0].opId).toBe('op-1');
    expect(ops[1].opId).toBe('op-2');

    // Fetch since sequence 1
    const newerOps = await fetchRemoteEncryptedDeltas(bookId, 1, mockCloudStorage, key);
    expect(newerOps.length).toBe(1);
    expect(newerOps[0].opId).toBe('op-2');
  });

  it('uploads and downloads encrypted snapshots', async () => {
    const snapshot: SyncSnapshot = {
      snapshotId: 'snap-1',
      bookId,
      bookEpoch: 'epoch-1',
      throughSequence: 10,
      schemaVersion: 1,
      payload: { accounts: [{ id: 'acc-1', balance: 500 }] },
      payloadHash: 'snap-hash-1',
      checkpointHash: 'chk-1',
      aggregateRevisions: { 'agg-1': 1 },
      createdAt: new Date().toISOString(),
    };

    await uploadEncryptedSnapshot(bookId, snapshot, mockCloudStorage, key);
    const downloaded = await downloadEncryptedSnapshot(bookId, 'epoch-1', mockCloudStorage, key);

    expect(downloaded).not.toBeNull();
    expect(downloaded?.snapshotId).toBe('snap-1');
    expect(downloaded?.throughSequence).toBe(10);
    expect(downloaded?.payload).toEqual(snapshot.payload);
  });
});
