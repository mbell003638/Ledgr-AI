function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const cryptoImpl = (globalThis as any).crypto;
  if (cryptoImpl?.getRandomValues) {
    cryptoImpl.getRandomValues(bytes);
    return bytes;
  }
  // Expo's supported release runtimes expose Web Crypto. This fallback only
  // keeps legacy/test environments usable; sync-capable builds should use CSPRNG.
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
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
