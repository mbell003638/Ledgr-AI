import { gcm } from '@noble/ciphers/aes';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';
import { randomBytes } from '@noble/hashes/utils';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { storage } from '../utils/storage';

export const E2EE_VERSION = 1;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH_BYTES = 32;
const NONCE_LENGTH_BYTES = 12;
const SALT_LENGTH_BYTES = 16;
const SYNC_E2EE_KEY_STORAGE_PREFIX = 'ledgr:sync:e2ee:key:';

export type EncryptedEnvelope = {
  version: number;
  nonce: string; // Base64
  ciphertext: string; // Base64 (includes 16-byte Poly1305/GCM tag appended by noble)
  salt?: string; // Base64
};

function uint8ToBase64(bytes: Uint8Array): string {
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

function base64ToUint8(base64: string): Uint8Array {
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
  return uint8ToBase64(raw).replace(/[/+=]/g, 'X').slice(0, 24);
}

export function deriveKeyFromPassphrase(passphrase: string, saltBytes?: Uint8Array): { key: Uint8Array; salt: Uint8Array } {
  const cleanPass = passphrase.trim();
  if (cleanPass.length < 8) {
    throw new Error('Sync passphrase must be at least 8 characters long');
  }
  const salt = saltBytes || randomBytes(SALT_LENGTH_BYTES);
  const key = pbkdf2(sha256, utf8ToBytes(cleanPass), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: KEY_LENGTH_BYTES,
  });
  return { key, salt };
}

export function encryptPayload(payload: unknown, key: Uint8Array, saltBytes?: Uint8Array): EncryptedEnvelope {
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
    nonce: uint8ToBase64(nonce),
    ciphertext: uint8ToBase64(ciphertextBytes),
    ...(saltBytes ? { salt: uint8ToBase64(saltBytes) } : {}),
  };
}

export function decryptPayload<T = unknown>(envelope: EncryptedEnvelope, key: Uint8Array): T {
  if (!envelope || !envelope.nonce || !envelope.ciphertext) {
    throw new Error('Invalid encrypted envelope');
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
  const nonce = base64ToUint8(envelope.nonce);
  const ciphertextBytes = base64ToUint8(envelope.ciphertext);

  const cipher = gcm(key, nonce);
  const decryptedBytes = cipher.decrypt(ciphertextBytes);
  const jsonStr = bytesToUtf8(decryptedBytes);
  return JSON.parse(jsonStr) as T;
}

export async function storeBookE2EEKey(bookId: string, key: Uint8Array): Promise<void> {
  const b64 = uint8ToBase64(key);
  await storage.secureSet(`${SYNC_E2EE_KEY_STORAGE_PREFIX}${bookId}`, b64);
}

export async function getBookE2EEKey(bookId: string): Promise<Uint8Array | null> {
  const b64 = await storage.secureGet<string | null>(`${SYNC_E2EE_KEY_STORAGE_PREFIX}${bookId}`, null);
  if (!b64) return null;
  return base64ToUint8(b64);
}

export async function clearBookE2EEKey(bookId: string): Promise<void> {
  await storage.secureRemove(`${SYNC_E2EE_KEY_STORAGE_PREFIX}${bookId}`);
}
