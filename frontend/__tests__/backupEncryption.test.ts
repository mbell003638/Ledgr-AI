import { createHash } from 'crypto';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  getRandomBytes: jest.fn((length: number) => new Uint8Array(Array.from({ length }, (_, index) => (index * 17 + 3) % 256))),
  digestStringAsync: jest.fn(async (_algorithm: string, value: string) => createHash('sha256').update(value, 'utf8').digest('hex')),
}));

import { backupIntegrityHash, decryptBackup, encryptBackup, isEncryptedBackup, verifyBackupIntegrity } from '../src/utils/backupEncryption';

describe('encrypted backup envelope', () => {
  const payload = {
    _meta: { app: 'ledgr', version: 11 },
    settings: { businessName: 'Example Books', currency: 'CAD' },
    books: [], bookData: {},
    v2: { schemaVersion: 2, tables: { v2_books: [{ id: 'default' }] }, meta: { v2_active_book_id: 'default' } },
  };

  it('round-trips without storing the passphrase', async () => {
    const envelope = await encryptBackup(payload, 'correct horse battery');
    expect(isEncryptedBackup(envelope)).toBe(true);
    expect(envelope).toMatchObject({ cipher: 'AES-256-GCM', kdf: 'scrypt', kdfParams: { N: 16384, r: 8, p: 1, dkLen: 32 } });
    expect(JSON.stringify(envelope)).not.toContain('correct horse battery');
    await expect(decryptBackup(envelope, 'correct horse battery')).resolves.toEqual(payload);
  });

  it('rejects wrong passwords, ciphertext tampering, and changed authentication metadata', async () => {
    const envelope = await encryptBackup(payload, 'correct horse battery');
    await expect(decryptBackup(envelope, 'wrong passphrase')).rejects.toThrow(/decrypt/i);
    await expect(decryptBackup({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }, 'correct horse battery')).rejects.toThrow(/decrypt|integrity/i);
    await expect(decryptBackup({ ...envelope, aad: 'changed' }, 'correct horse battery')).rejects.toThrow(/authentication metadata/i);
    await expect(decryptBackup({ ...envelope, kdfParams: { ...envelope.kdfParams, N: 32768 } }, 'correct horse battery')).rejects.toThrow(/key-derivation/i);
  });

  it('uses a stable integrity hash and rejects weak passphrases', async () => {
    const hash = await backupIntegrityHash(payload);
    expect(hash).toHaveLength(64);
    expect(await verifyBackupIntegrity(payload, hash)).toBe(true);
    expect(await verifyBackupIntegrity({ ...payload, settings: { businessName: 'Changed' } }, hash)).toBe(false);
    await expect(encryptBackup(payload, 'short')).rejects.toThrow(/8 characters/i);
  });
});
