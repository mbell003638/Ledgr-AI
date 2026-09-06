import * as ExpoCrypto from 'expo-crypto';

/**
 * Installs `globalThis.crypto.getRandomValues` on React Native.
 *
 * Hermes ships no Web Crypto, so the global is simply absent on device.
 * `@noble/hashes` and `@noble/ciphers` reach for it on every key, nonce and
 * pairing secret and throw `crypto.getRandomValues must be defined` when it is
 * missing. On the sync screen that surfaced as a pairing QR that never drew and
 * a "Show pairing code" button that appeared to do nothing: the error was
 * caught and written to the status line rather than crashing.
 *
 * expo-crypto is already a dependency on every branch and is backed by the
 * platform CSPRNG, so it is the polyfill rather than a new package. Import this
 * module for its side effect before anything that encrypts or generates an id.
 */
export function installCryptoPolyfill(): void {
  const scope = globalThis as unknown as { crypto?: Record<string, unknown> };
  if (typeof scope.crypto?.getRandomValues === 'function') return;

  const getRandomValues = <T extends ArrayBufferView>(array: T): T =>
    ExpoCrypto.getRandomValues(array as never) as unknown as T;

  if (scope.crypto) {
    try {
      scope.crypto.getRandomValues = getRandomValues as unknown as Record<string, unknown>[string];
      if (typeof scope.crypto.getRandomValues === 'function') return;
    } catch {
      // A frozen or accessor-only global: fall through and replace it wholesale.
    }
  }

  Object.defineProperty(globalThis, 'crypto', {
    value: { ...(scope.crypto || {}), getRandomValues },
    configurable: true,
    writable: true,
  });
}

installCryptoPolyfill();
