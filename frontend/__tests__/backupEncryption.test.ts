import { createHash } from 'crypto';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  getRandomBytes: jest.fn((length: number) => new Uint8Array(Array.from({ length }, (_, index) => (index * 17 + 3) % 256))),
  digestStringAsync: jest.fn(async (_algorithm: string, value: string) => createHash('sha256').update(value, 'utf8').digest('hex')),
}));

import { backupIntegrityHash, decryptBackup, encryptBackup, isEncryptedBackup, verifyBackupIntegrity } from '../src/utils/backupEncryption';

describe('encrypted backup format', () => {
  const payload = {
    _meta: { app: 'ledgr', version: 10 },
    settings: { businessName: 'Example Books', currency: 'USD' },
    v2: { schemaVersion: 1, tables: { v2_books: [{ id: 'default' }] }, meta: { v2_active_book_id: 'default' } },
  };

  it('encrypts and decrypts a backup without storing the passphrase', async () => {
    const envelope = await encryptBackup(payload, 'correct horse battery');
    expect(isEncryptedBackup(envelope)).toBe(true);
    expect(envelope.cipher).toBe('AES-256-GCM');
    expect(envelope.kdf).toBe('scrypt');
    expect(JSON.stringify(envelope)).not.toContain('correct horse battery');
    await expect(decryptBackup(envelope, 'correct horse battery')).resolves.toEqual(payload);
  });

  it('rejects a wrong passphrase and detects ciphertext tampering', async () => {
    const envelope = await encryptBackup(payload, 'correct horse battery');
    await expect(decryptBackup(envelope, 'wrong passphrase')).rejects.toThrow(/decrypt/i);
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` };
    await expect(decryptBackup(tampered, 'correct horse battery')).rejects.toThrow(/decrypt|integrity/i);
  });

  it('uses a deterministic integrity hash and rejects mismatches', async () => {
    const hash = await backupIntegrityHash(payload);
    expect(hash).toHaveLength(64);
    expect(await verifyBackupIntegrity(payload, hash)).toBe(true);
    expect(await verifyBackupIntegrity({ ...payload, settings: { businessName: 'Changed' } }, hash)).toBe(false);
  });

  it('requires a meaningful passphrase', async () => {
    await expect(encryptBackup(payload, 'short')).rejects.toThrow(/8 characters/i);
  });
});
