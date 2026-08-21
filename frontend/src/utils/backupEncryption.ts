import * as Crypto from 'expo-crypto';
import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt';

export const ENCRYPTED_BACKUP_FORMAT = 'ledgr-encrypted-backup' as const;
export const ENCRYPTED_BACKUP_VERSION = 1 as const;
const KDF_N = 2 ** 14;
const KDF_R = 8;
const KDF_P = 1;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const SALT_LENGTH = 16;

export type EncryptedBackupEnvelope = {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: typeof ENCRYPTED_BACKUP_VERSION;
  cipher: 'AES-256-GCM';
  kdf: 'scrypt';
  kdfParams: { N: number; r: number; p: number; dkLen: number };
  salt: string;
  nonce: string;
  aad: string;
  ciphertext: string;
  integrity: string;
  createdAt: string;
};

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    output += BASE64[(n >>> 18) & 63] + BASE64[(n >>> 12) & 63]
      + (i + 1 < bytes.length ? BASE64[(n >>> 6) & 63] : '=')
      + (i + 2 < bytes.length ? BASE64[n & 63] : '=');
  }
  return output;
}

function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s/g, '');
  if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('Encrypted backup contains invalid base64 data.');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean[i]; const c1 = clean[i + 1]; const c2 = clean[i + 2]; const c3 = clean[i + 3];
    const n = (BASE64.indexOf(c0) << 18) | (BASE64.indexOf(c1) << 12)
      | (c2 === '=' ? 0 : BASE64.indexOf(c2) << 6) | (c3 === '=' ? 0 : BASE64.indexOf(c3));
    if (BASE64.indexOf(c0) < 0 || BASE64.indexOf(c1) < 0 || (c2 !== '=' && BASE64.indexOf(c2) < 0) || (c3 !== '=' && BASE64.indexOf(c3) < 0)) throw new Error('Encrypted backup contains invalid base64 data.');
    out.push((n >>> 16) & 255);
    if (c2 !== '=') out.push((n >>> 8) & 255);
    if (c3 !== '=') out.push(n & 255);
  }
  return new Uint8Array(out);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export async function backupIntegrityHash(data: unknown): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, stableStringify(data), { encoding: Crypto.CryptoEncoding.HEX });
}

export async function verifyBackupIntegrity(data: unknown, expectedHash: string): Promise<boolean> {
  if (!expectedHash || typeof expectedHash !== 'string') return false;
  const actual = await backupIntegrityHash(data);
  return actual.toLowerCase() === expectedHash.toLowerCase();
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.trim().length < 8) throw new Error('Use a backup passphrase with at least 8 characters.');
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  return scryptAsync(utf8(passphrase), salt, { N: KDF_N, r: KDF_R, p: KDF_P, dkLen: KEY_LENGTH, asyncTick: 10 });
}

export async function encryptBackup(data: unknown, passphrase: string): Promise<EncryptedBackupEnvelope> {
  assertPassphrase(passphrase);
  const salt = Crypto.getRandomBytes(SALT_LENGTH);
  const nonce = Crypto.getRandomBytes(NONCE_LENGTH);
  const aad = `${ENCRYPTED_BACKUP_FORMAT}:v${ENCRYPTED_BACKUP_VERSION}`;
  const plaintext = utf8(JSON.stringify(data));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = gcm(key, nonce, utf8(aad)).encrypt(plaintext);
  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: ENCRYPTED_BACKUP_VERSION,
    cipher: 'AES-256-GCM',
    kdf: 'scrypt',
    kdfParams: { N: KDF_N, r: KDF_R, p: KDF_P, dkLen: KEY_LENGTH },
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    aad,
    ciphertext: bytesToBase64(ciphertext),
    integrity: await backupIntegrityHash(data),
    createdAt: new Date().toISOString(),
  };
}

export async function decryptBackup(encrypted: EncryptedBackupEnvelope, passphrase: string): Promise<any> {
  assertPassphrase(passphrase);
  if (!encrypted || encrypted.format !== ENCRYPTED_BACKUP_FORMAT || encrypted.version !== ENCRYPTED_BACKUP_VERSION) throw new Error('Unsupported encrypted Ledgr backup format.');
  if (encrypted.cipher !== 'AES-256-GCM' || encrypted.kdf !== 'scrypt') throw new Error('Unsupported encrypted backup security settings.');
  if (!encrypted.salt || !encrypted.nonce || !encrypted.ciphertext || !encrypted.integrity) throw new Error('Encrypted backup is incomplete.');
  const salt = base64ToBytes(encrypted.salt);
  const nonce = base64ToBytes(encrypted.nonce);
  if (salt.length !== SALT_LENGTH || nonce.length !== NONCE_LENGTH) throw new Error('Encrypted backup has invalid security parameters.');
  const key = await deriveKey(passphrase, salt);
  let plaintext: Uint8Array;
  try {
    plaintext = gcm(key, nonce, utf8(encrypted.aad || `${ENCRYPTED_BACKUP_FORMAT}:v${ENCRYPTED_BACKUP_VERSION}`)).decrypt(base64ToBytes(encrypted.ciphertext));
  } catch {
    throw new Error('Could not decrypt this backup. Check the passphrase or choose a different file.');
  }
  let data: any;
  try { data = JSON.parse(decodeUtf8(plaintext)); } catch { throw new Error('Decrypted backup payload is not valid JSON.'); }
  if (!(await verifyBackupIntegrity(data, encrypted.integrity))) throw new Error('Backup integrity verification failed. The file may be damaged or tampered with.');
  return data;
}

export function isEncryptedBackup(value: unknown): value is EncryptedBackupEnvelope {
  const candidate = value as Partial<EncryptedBackupEnvelope> | null;
  return !!candidate && candidate.format === ENCRYPTED_BACKUP_FORMAT && candidate.version === ENCRYPTED_BACKUP_VERSION;
}

export { stableStringify };
