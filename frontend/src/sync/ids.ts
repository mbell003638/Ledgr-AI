function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const cryptoImpl = (globalThis as any).crypto;
  if (cryptoImpl?.getRandomValues) {
    cryptoImpl.getRandomValues(bytes);
    return bytes;
  }
  // Falling back to Math.random() made operation and conflict ids predictable
  // while looking like it worked. src/utils/cryptoPolyfill installs a CSPRNG at
  // app start, so reaching here means the polyfill did not run.
  throw new Error('Secure random values are unavailable: crypto.getRandomValues is not installed.');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** UUIDv4-shaped identifier suitable for operation and conflict identities. */
export function createSyncId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
