/**
 * Backend dispatch tests (Phase 2B activation).
 *
 * Verifies the AsyncStorage-mode primitives in backend.ts work correctly using
 * a mocked @react-native-async-storage/async-storage. The SQLite-mode path is
 * covered by sqliteStore.test.ts (same underlying functions). Together these
 * prove both branches of the dispatch.
 */

// In-memory mock of AsyncStorage before importing the backend.
const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mem[k]; }),
  },
}));

import {
  readColl,
  writeColl,
  readSettings,
  writeSettings,
  clearColl,
  storageMode,
} from '../src/db/backend';

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
});

describe('backend — AsyncStorage mode (default)', () => {
  it('defaults to async mode', () => {
    expect(storageMode()).toBe('async');
  });

  it('writeColl / readColl round-trip through AsyncStorage', async () => {
    await writeColl('sales', [{ id: 's1', date: '2026-07-01', amount: 100 }]);
    expect(mem['ledgr:sales']).toContain('s1');
    const back = await readColl('sales');
    expect(back).toHaveLength(1);
    expect((back[0] as any).amount).toBe(100);
  });

  it('readColl returns [] for missing / corrupt data', async () => {
    expect(await readColl('bills')).toEqual([]);
    mem['ledgr:bills'] = '{not json';
    expect(await readColl('bills')).toEqual([]);
  });

  it('settings round-trip + merge behavior', async () => {
    expect(await readSettings()).toEqual({});
    await writeSettings({ currency: 'CAD' });
    expect(await readSettings()).toEqual({ currency: 'CAD' });
  });

  it('clearColl removes the collection', async () => {
    await writeColl('expenses', [{ id: 'e1', date: '2026-01-01', amount: 5 }]);
    expect(await readColl('expenses')).toHaveLength(1);
    await clearColl('expenses');
    expect(await readColl('expenses')).toEqual([]);
  });
});
