import { gcm } from '@noble/ciphers/aes';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { randomBytes } from '@noble/hashes/utils';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { storage } from '../utils/storage';

export const E2EE_VERSION = 1;
/**
 * Chosen for a phone, not a server: this runs in JS via Hermes, where the work
 * costs roughly ten times what it does on a desktop. 600k measured about two
 * seconds in node, so it would have made setup look hung on a mid-range
 * handset. The count travels with the salt so it can be raised later without
 * orphaning books already encrypted at the old value, and the default
 * passphrase is 24 random characters, which matters far more than iterations.
 */
export const PBKDF2_ITERATIONS = 210_000;
const KEY_LENGTH_BYTES = 32;
const NONCE_LENGTH_BYTES = 12;
const SALT_LENGTH_BYTES = 16;
const SYNC_E2EE_KEY_STORAGE_PREFIX = 'ledgr:sync:e2ee:key:';

export type EncryptedEnvelope = {
  version: number;
  nonce: string; // Base64
  ciphertext: string; // Base64 (includes 16-byte Poly1305/GCM tag appended by noble)
  salt?: string; // Base64
  /** Iterations the key was derived with, so the count can change safely. */
  iterations?: number;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function generateSyncPassphrase(): string {
  // Generate 24-character high-entropy alphanumeric secret
  const raw = randomBytes(18);
  return bytesToBase64(raw).replace(/[/+=]/g, 'X').slice(0, 24);
}

export function deriveKeyFromPassphrase(
  passphrase: string,
  saltBytes?: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): { key: Uint8Array; salt: Uint8Array; iterations: number } {
  const cleanPass = passphrase.trim();
  if (cleanPass.length < 8) {
    throw new Error('Sync passphrase must be at least 8 characters long');
  }
  const salt = saltBytes || randomBytes(SALT_LENGTH_BYTES);
  const rounds = Number.isSafeInteger(iterations) && iterations > 0 ? iterations : PBKDF2_ITERATIONS;
  const key = pbkdf2(sha256, utf8ToBytes(cleanPass), salt, {
    c: rounds,
    dkLen: KEY_LENGTH_BYTES,
  });
  return { key, salt, iterations: rounds };
}

export function encryptPayload(payload: unknown, key: Uint8Array, saltBytes?: Uint8Array, iterations?: number): EncryptedEnvelope {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LENGTH_BYTES);
  const jsonStr = JSON.stringify(payload);
  const plaintextBytes = utf8ToBytes(jsonStr);

  const cipher = gcm(key, nonce);
  const ciphertextBytes = cipher.encrypt(plaintextBytes);

  return {
    version: E2EE_VERSION,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertextBytes),
    ...(saltBytes ? { salt: bytesToBase64(saltBytes), iterations: iterations || PBKDF2_ITERATIONS } : {}),
  };
}

export function decryptPayload<T = unknown>(envelope: EncryptedEnvelope, key: Uint8Array): T {
  if (!envelope || !envelope.nonce || !envelope.ciphertext) {
    throw new Error('Invalid encrypted envelope');
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
  const nonce = base64ToBytes(envelope.nonce);
  const ciphertextBytes = base64ToBytes(envelope.ciphertext);

  const cipher = gcm(key, nonce);
  const decryptedBytes = cipher.decrypt(ciphertextBytes);
  const jsonStr = bytesToUtf8(decryptedBytes);
  return JSON.parse(jsonStr) as T;
}

export async function storeBookE2EEKey(bookId: string, key: Uint8Array): Promise<void> {
  const b64 = bytesToBase64(key);
  await storage.secureSet(`${SYNC_E2EE_KEY_STORAGE_PREFIX}${bookId}`, b64);
}

export async function getBookE2EEKey(bookId: string): Promise<Uint8Array | null> {
  const b64 = await storage.secureGet<string | null>(`${SYNC_E2EE_KEY_STORAGE_PREFIX}${bookId}`, null);
  if (!b64) return null;
  return base64ToBytes(b64);
}

export async function clearBookE2EEKey(bookId: string): Promise<void> {
  await storage.secureRemove(`${SYNC_E2EE_KEY_STORAGE_PREFIX}${bookId}`);
}
