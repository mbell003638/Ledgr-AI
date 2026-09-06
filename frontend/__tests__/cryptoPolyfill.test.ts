// wifiP2pSync pulls in the storage layer; these keep the module graph loadable
// under jest without changing what is being tested.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined), removeItem: jest.fn(async () => undefined) },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-crypto', () => ({
  getRandomValues: (array: Uint8Array) => {
    for (let i = 0; i < array.length; i += 1) array[i] = (i * 37 + 11) % 256;
    return array;
  },
}));

type Scope = { crypto?: unknown };

function withoutWebCrypto<T>(run: () => T): T {
  const scope = globalThis as Scope;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete scope.crypto;
  }
}

describe('the sync screen fails without Web Crypto, and the polyfill is what restores it', () => {
  beforeEach(() => jest.resetModules());

  // The device failure itself cannot be reproduced here: @noble falls back to
  // node:crypto under jest, so removing globalThis.crypto does not break it the
  // way it breaks under Hermes. What is testable is that the polyfill installs a
  // working CSPRNG, that the pairing session it feeds succeeds, and that our own
  // id generator refuses to run without one.

  it('creates the pairing session once the polyfill is installed', () => {
    withoutWebCrypto(() => {
      require('../src/utils/cryptoPolyfill');
      const { createWifiP2pSession, WIFI_P2P_QR_SCHEME } = require('../src/sync/wifiP2pSync');
      const { session, key, qrCodeUri } = createWifiP2pSession('book-1');
      expect(key).toHaveLength(32);
      expect(session.bookId).toBe('book-1');
      expect(qrCodeUri.startsWith(WIFI_P2P_QR_SCHEME)).toBe(true);
    });
  });

  it('installs getRandomValues on a runtime that has none', () => {
    withoutWebCrypto(() => {
      const { installCryptoPolyfill } = require('../src/utils/cryptoPolyfill');
      installCryptoPolyfill();
      const bytes = new Uint8Array(8);
      (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto!.getRandomValues(bytes);
      expect(bytes.some((byte) => byte !== 0)).toBe(true);
    });
  });

  it('leaves a runtime that already has Web Crypto untouched', () => {
    const marker = jest.fn((array: Uint8Array) => array);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: marker }, configurable: true, writable: true });
    try {
      const { installCryptoPolyfill } = require('../src/utils/cryptoPolyfill');
      installCryptoPolyfill();
      expect((globalThis as { crypto: { getRandomValues: unknown } }).crypto.getRandomValues).toBe(marker);
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });

  it('refuses to invent ids from Math.random when no CSPRNG is present', () => {
    withoutWebCrypto(() => {
      const { createSyncId } = require('../src/sync/ids');
      // Predictable operation and conflict ids are worse than a loud failure.
      expect(() => createSyncId()).toThrow(/Secure random values are unavailable/);
    });
  });
});

describe('the app installs the polyfill before anything can use it', () => {
  it('imports it as the first import in the root layout', () => {
    const fs = require('fs');
    const path = require('path');
    const layout: string = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');
    const polyfillAt = layout.indexOf('@/src/utils/cryptoPolyfill');
    expect(polyfillAt).toBeGreaterThanOrEqual(0);
    const firstOtherImport = layout.search(/^import\s+(?!["']@\/src\/utils\/cryptoPolyfill)/m);
    expect(polyfillAt).toBeLessThan(firstOtherImport);
  });
});
