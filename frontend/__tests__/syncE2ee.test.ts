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
  deriveKeyFromPassphrase,
  encryptPayload,
  decryptPayload,
  generateSyncPassphrase,
  storeBookE2EEKey,
  getBookE2EEKey,
  clearBookE2EEKey,
} from '../src/sync/e2ee';

describe('sync E2EE cryptography', () => {
  it('generates random passphrases of valid length', () => {
    const pass1 = generateSyncPassphrase();
    const pass2 = generateSyncPassphrase();
    expect(pass1.length).toBeGreaterThanOrEqual(16);
    expect(pass2.length).toBeGreaterThanOrEqual(16);
    expect(pass1).not.toEqual(pass2);
  });

  it('derives a consistent 32-byte key given the same salt and passphrase', () => {
    const salt = new Uint8Array(16).fill(7);
    const pass = 'correct-horse-battery-staple';
    const { key: key1 } = deriveKeyFromPassphrase(pass, salt);
    const { key: key2 } = deriveKeyFromPassphrase(pass, salt);
    expect(key1.length).toBe(32);
    expect(Buffer.from(key1)).toEqual(Buffer.from(key2));
  });

  it('rejects short passphrases', () => {
    expect(() => deriveKeyFromPassphrase('short')).toThrow(/at least 8 characters/i);
  });

  it('encrypts and decrypts arbitrary JSON objects using AES-256-GCM', () => {
    const salt = new Uint8Array(16).fill(3);
    const { key } = deriveKeyFromPassphrase('my-secure-ledger-sync-pass', salt);
    const payload = {
      bookId: 'book-123',
      commandType: 'POST_TRANSACTION',
      entries: [{ account: 'Cash', amount: 150.5 }],
    };

    const envelope = encryptPayload(payload, key);
    expect(envelope.version).toBe(1);
    expect(envelope.nonce).toBeDefined();
    expect(envelope.ciphertext).toBeDefined();

    const decrypted = decryptPayload<typeof payload>(envelope, key);
    expect(decrypted).toEqual(payload);
  });

  it('fails decryption when an invalid or different key is used', () => {
    const salt = new Uint8Array(16).fill(1);
    const { key: correctKey } = deriveKeyFromPassphrase('passphrase-one-1234', salt);
    const { key: wrongKey } = deriveKeyFromPassphrase('passphrase-two-5678', salt);

    const envelope = encryptPayload({ secret: 42 }, correctKey);
    expect(() => decryptPayload(envelope, wrongKey)).toThrow();
  });

  it('fails decryption if ciphertext is tampered with', () => {
    const salt = new Uint8Array(16).fill(2);
    const { key } = deriveKeyFromPassphrase('tamper-test-pass-phrase', salt);
    const envelope = encryptPayload({ amount: 1000 }, key);

    // Tamper with base64 ciphertext
    const raw = Buffer.from(envelope.ciphertext, 'base64');
    raw[0] ^= 0xff;
    envelope.ciphertext = raw.toString('base64');

    expect(() => decryptPayload(envelope, key)).toThrow();
  });

  it('stores and retrieves book E2EE keys securely', async () => {
    const salt = new Uint8Array(16).fill(9);
    const { key } = deriveKeyFromPassphrase('passphrase-store-test', salt);
    const bookId = 'book-secure-test';

    await storeBookE2EEKey(bookId, key);
    const retrieved = await getBookE2EEKey(bookId);
    expect(retrieved).not.toBeNull();
    expect(Buffer.from(retrieved!)).toEqual(Buffer.from(key));

    await clearBookE2EEKey(bookId);
    const cleared = await getBookE2EEKey(bookId);
    expect(cleared).toBeNull();
  });
});
