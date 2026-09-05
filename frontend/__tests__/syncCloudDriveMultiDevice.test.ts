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
  adoptRemoteKey,
  cursorsFromOperations,
  deltaFilename,
  fetchRemoteEncryptedDeltas,
  getCloudConfig,
  getStorageClient,
  mockCloudStorage,
  saveCloudConfig,
  uploadEncryptedDelta,
} from '../src/sync/cloudDriveProvider';
import { base64ToBytes, deriveKeyFromPassphrase, getBookE2EEKey } from '../src/sync/e2ee';
import type { SyncOperation } from '../src/sync/protocol';

const bookId = 'book-multi';
const PASSPHRASE = 'correct horse battery staple';

function op(deviceId: string, sequence: number, at: string, amount: number): SyncOperation {
  return {
    protocolVersion: 1, payloadVersion: 1, opId: `op-${deviceId}-${sequence}`,
    bookId, bookEpoch: 'epoch-1', deviceId, deviceSequence: sequence,
    actorId: 'actor-1', commandType: 'RECORD_EXPENSE', aggregateId: `agg-${deviceId}`,
    baseRevision: null, dependencies: [], payload: { amount },
    payloadHash: 'a'.repeat(64), clientCreatedAt: at,
  };
}

describe('cloud drive sync across two devices', () => {
  beforeEach(() => {
    mockCloudStorage.clear();
    for (const k of Object.keys(asyncMem)) delete asyncMem[k];
    for (const k of Object.keys(secureMem)) delete secureMem[k];
  });

  it('lets a second device derive the same key from the same passphrase', async () => {
    // Regression: the salt was generated per call and discarded, so a second
    // device deriving from the same passphrase got a different key and could
    // never read anything the first device had written.
    await saveCloudConfig(bookId, { provider: 'mock', passphrase: PASSPHRASE });
    const config = await getCloudConfig(bookId);
    expect(config?.keySalt).toBeTruthy();

    const deviceA = await getBookE2EEKey(bookId);
    const deviceB = deriveKeyFromPassphrase(PASSPHRASE, base64ToBytes(config!.keySalt!)).key;
    expect(Buffer.from(deviceB).toString('hex')).toBe(Buffer.from(deviceA!).toString('hex'));
  });

  it('lets a joining device recover the key from the passphrase alone', async () => {
    await saveCloudConfig(bookId, { provider: 'mock', passphrase: PASSPHRASE });
    const config = await getCloudConfig(bookId);
    const key = (await getBookE2EEKey(bookId))!;
    const salt = base64ToBytes(config!.keySalt!);
    await uploadEncryptedDelta(bookId, 1, op('dev-a', 1, '2026-01-01T10:00:00Z', 10), mockCloudStorage, key, salt);

    // A fresh device: no stored key, only the passphrase.
    for (const k of Object.keys(secureMem)) delete secureMem[k];
    const adopted = await adoptRemoteKey(bookId, PASSPHRASE, mockCloudStorage);
    expect(adopted).not.toBeNull();
    expect(Buffer.from(adopted!).toString('hex')).toBe(Buffer.from(key).toString('hex'));
  });

  it('refuses to adopt a key when the passphrase is wrong', async () => {
    await saveCloudConfig(bookId, { provider: 'mock', passphrase: PASSPHRASE });
    const config = await getCloudConfig(bookId);
    const key = (await getBookE2EEKey(bookId))!;
    await uploadEncryptedDelta(bookId, 1, op('dev-a', 1, '2026-01-01T10:00:00Z', 10), mockCloudStorage, key, base64ToBytes(config!.keySalt!));
    expect(await adoptRemoteKey(bookId, 'not the passphrase', mockCloudStorage)).toBeNull();
  });

  it('keeps two devices at the same sequence number from colliding', async () => {
    // Regression: filenames omitted the device, so both devices' sequence 5
    // shared a name and a single book-wide cursor skipped one of them.
    expect(deltaFilename(bookId, 'dev-a', 5)).not.toBe(deltaFilename(bookId, 'dev-b', 5));

    const { key } = deriveKeyFromPassphrase(PASSPHRASE, new Uint8Array(16).fill(7));
    await uploadEncryptedDelta(bookId, 5, op('dev-a', 5, '2026-01-01T10:00:00Z', 10), mockCloudStorage, key);
    await uploadEncryptedDelta(bookId, 5, op('dev-b', 5, '2026-01-01T10:00:01Z', 20), mockCloudStorage, key);

    const pulled = await fetchRemoteEncryptedDeltas(bookId, {}, mockCloudStorage, key);
    expect(pulled.map((row) => row.opId).sort()).toEqual(['op-dev-a-5', 'op-dev-b-5']);
  });

  it('advances cursors per device so no device is starved', async () => {
    const { key } = deriveKeyFromPassphrase(PASSPHRASE, new Uint8Array(16).fill(7));
    await uploadEncryptedDelta(bookId, 5, op('dev-a', 5, '2026-01-01T10:00:00Z', 10), mockCloudStorage, key);
    const first = await fetchRemoteEncryptedDeltas(bookId, {}, mockCloudStorage, key);
    const cursors = cursorsFromOperations(first);
    expect(cursors).toEqual({ 'dev-a': 5 });

    // dev-b now writes its own sequence 5, below dev-a's cursor.
    await uploadEncryptedDelta(bookId, 5, op('dev-b', 5, '2026-01-01T10:00:01Z', 20), mockCloudStorage, key);
    const second = await fetchRemoteEncryptedDeltas(bookId, cursors, mockCloudStorage, key);
    expect(second.map((row) => row.opId)).toEqual(['op-dev-b-5']);
  });

  it('orders merged operations identically regardless of arrival order', async () => {
    const { key } = deriveKeyFromPassphrase(PASSPHRASE, new Uint8Array(16).fill(7));
    await uploadEncryptedDelta(bookId, 2, op('dev-b', 2, '2026-01-01T10:00:05Z', 20), mockCloudStorage, key);
    await uploadEncryptedDelta(bookId, 1, op('dev-a', 1, '2026-01-01T10:00:00Z', 10), mockCloudStorage, key);
    const pulled = await fetchRemoteEncryptedDeltas(bookId, {}, mockCloudStorage, key);
    expect(pulled.map((row) => row.opId)).toEqual(['op-dev-a-1', 'op-dev-b-2']);
  });

  it('refuses to write to a disconnected account instead of dropping the book', () => {
    // Regression: an expired token fell through to the in-memory mock, which
    // reported success and then vanished with the process.
    expect(() => getStorageClient({ provider: 'google_drive' })).toThrow(/Reconnect the Google account/);
  });
});
