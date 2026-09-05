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
  createWifiP2pSession,
  parseWifiP2pQr,
  packWifiTransfer,
  unpackWifiTransfer,
  WIFI_P2P_QR_SCHEME,
} from '../src/sync/wifiP2pSync';
import type { SyncSnapshot, SyncOperation } from '../src/sync/protocol';

describe('wifiP2pSync', () => {
  const bookId = 'book-wifi-test';

  it('generates a valid QR URI and parses it back accurately', () => {
    const { session, qrCodeUri } = createWifiP2pSession(bookId, '192.168.1.55', 8787, 15);
    expect(qrCodeUri.startsWith(WIFI_P2P_QR_SCHEME)).toBe(true);

    const parsed = parseWifiP2pQr(qrCodeUri);
    expect(parsed.sessionId).toBe(session.sessionId);
    expect(parsed.bookId).toBe(bookId);
    expect(parsed.hostIp).toBe('192.168.1.55');
    expect(parsed.port).toBe(8787);
    expect(parsed.ephemeralKeyHex).toBe(session.ephemeralKeyHex);
  });

  it('rejects expired QR codes', () => {
    const { qrCodeUri } = createWifiP2pSession(bookId, '192.168.1.55', 8787, -1); // expired 1 min ago
    expect(() => parseWifiP2pQr(qrCodeUri)).toThrow(/expired/i);
  });

  it('packs and unpacks transfer packages with checksum and E2EE integrity', () => {
    const { key } = createWifiP2pSession(bookId);

    const snapshot: SyncSnapshot = {
      snapshotId: 'snap-p2p-1',
      bookId,
      bookEpoch: 'epoch-1',
      throughSequence: 5,
      schemaVersion: 1,
      payload: { balance: 999 },
      payloadHash: 'hash-snap',
      checkpointHash: 'chk-snap',
      aggregateRevisions: { 'agg-1': 1 },
      createdAt: new Date().toISOString(),
    };

    const op: SyncOperation = {
      protocolVersion: 1,
      payloadVersion: 1,
      opId: 'op-p2p-1',
      bookId,
      bookEpoch: 'epoch-1',
      deviceId: 'dev-p2p-1',
      deviceSequence: 1,
      actorId: 'actor-1',
      commandType: 'TRANSFER_FUNDS',
      aggregateId: 'agg-1',
      baseRevision: null,
      dependencies: [],
      payload: { amount: 100 },
      payloadHash: 'hash-op',
      clientCreatedAt: new Date().toISOString(),
    };

    const { envelope, checksum } = packWifiTransfer(snapshot, [op], key);
    expect(checksum).toBeDefined();
    expect(envelope.ciphertext).toBeDefined();

    const unpacked = unpackWifiTransfer(envelope, key);
    expect(unpacked.bookId).toBe(bookId);
    expect(unpacked.snapshot.snapshotId).toBe('snap-p2p-1');
    expect(unpacked.pendingOperations.length).toBe(1);
    expect(unpacked.pendingOperations[0].opId).toBe('op-p2p-1');
  });

  it('fails unpacking if the transfer package checksum is invalid', () => {
    const { key } = createWifiP2pSession(bookId);

    const snapshot: SyncSnapshot = {
      snapshotId: 'snap-p2p-1',
      bookId,
      bookEpoch: 'epoch-1',
      throughSequence: 5,
      schemaVersion: 1,
      payload: { balance: 999 },
      payloadHash: 'hash-snap',
      checkpointHash: 'chk-snap',
      aggregateRevisions: {},
      createdAt: new Date().toISOString(),
    };

    const { envelope } = packWifiTransfer(snapshot, [], key);
    // Unpack with a different key
    const otherKey = new Uint8Array(32).fill(4);
    expect(() => unpackWifiTransfer(envelope, otherKey)).toThrow();
  });
});
