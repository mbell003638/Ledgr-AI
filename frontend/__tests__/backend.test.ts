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
  listBooks,
  createBook,
  setActiveBook,
  activeBookId,
  deleteBook,
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

describe('backend — Books (separate accounts)', () => {
  afterEach(async () => { await setActiveBook('default'); });

  it('starts on the default book and always lists it', async () => {
    expect(activeBookId()).toBe('default');
    const books = await listBooks();
    expect(books.find((b) => b.id === 'default')).toBeTruthy();
  });

  it('isolates data between two books (no leakage)', async () => {
    // Write in the default book.
    await writeColl('sales', [{ id: 'main-1', amount: 100 }]);
    // Create + switch to a second book.
    const tech = await createBook('Technician');
    await setActiveBook(tech.id);
    expect(activeBookId()).toBe(tech.id);
    // Second book starts empty — default data is NOT visible.
    expect(await readColl('sales')).toEqual([]);
    // Write different data in the second book.
    await writeColl('sales', [{ id: 'tech-1', amount: 999 }]);
    expect(await readColl('sales')).toHaveLength(1);
    expect((await readColl('sales'))[0]).toMatchObject({ id: 'tech-1' });
    // Switch back — the default book's data is intact and unchanged.
    await setActiveBook('default');
    const mainSales = await readColl('sales');
    expect(mainSales).toHaveLength(1);
    expect((mainSales[0] as any).id).toBe('main-1');
  });

  it('settings are per-book too', async () => {
    await writeSettings({ currency: 'USD', businessName: 'Shop' });
    const tech = await createBook('Tech2');
    await setActiveBook(tech.id);
    await writeSettings({ currency: 'CAD', businessName: 'Tech' });
    expect((await readSettings()).businessName).toBe('Tech');
    await setActiveBook('default');
    expect((await readSettings()).businessName).toBe('Shop');
  });

  it('refuses to delete the default book, but deletes others + wipes their data', async () => {
    await expect(deleteBook('default')).rejects.toThrow();
    const b = await createBook('Temp');
    await setActiveBook(b.id);
    await writeColl('sales', [{ id: 'x', amount: 1 }]);
    await setActiveBook('default');
    await deleteBook(b.id);
    const books = await listBooks();
    expect(books.find((x) => x.id === b.id)).toBeFalsy();
    // The deleted book's namespaced key is gone.
    expect(mem[`ledgr:${b.id}:sales`]).toBeUndefined();
  });
});
