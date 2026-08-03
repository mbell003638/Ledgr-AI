/**
 * Fable5 audit — Finding D: backup/restore preserves ALL books.
 *
 * The pre-fix exportBackup captured only the ACTIVE book's legacy collections and
 * neither the books index (ledgr:books) nor secondary books' namespaced legacy
 * payloads, so a restore lost every secondary book. Format 10 captures the books
 * index + every book's payload; the shared v2_* ledger (all books) is captured by
 * the V2 payload. This drives the REAL api/backend/V2 stack against a real SQLite
 * db (node:sqlite) with mocked AsyncStorage/secure-store — exactly as a device.
 *
 * Also covers Finding B here (quote→invoice through the V2 write path) since it
 * needs the same full-stack harness.
 */

const mem: Record<string, string> = {};
const secure: Record<string, string> = {};
function installMocks() {
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
      setItem: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
      removeItem: jest.fn(async (k: string) => { delete mem[k]; }),
      multiGet: jest.fn(async (keys: string[]) => keys.map((k) => [k, k in mem ? mem[k] : null])),
      multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [k, v] of pairs) mem[k] = v; }),
      multiRemove: jest.fn(async (keys: string[]) => { for (const k of keys) delete mem[k]; }),
    },
  }));
  jest.doMock('expo-secure-store', () => ({
    __esModule: true,
    getItemAsync: jest.fn(async (k: string) => (k in secure ? secure[k] : null)),
    setItemAsync: jest.fn(async (k: string, v: string) => { secure[k] = v; }),
    deleteItemAsync: jest.fn(async (k: string) => { delete secure[k]; }),
  }));
  const { DatabaseSync } = require('node:sqlite');
  const dbHolder: { db: any } = { db: null };
  jest.doMock('../src/db/expoRunner', () => ({
    __esModule: true,
    getExpoRunner: jest.fn(async () => {
      if (!dbHolder.db) dbHolder.db = new DatabaseSync(':memory:');
      const db = dbHolder.db;
      return {
        exec: async (sql: string) => { db.exec(sql); },
        run: async (sql: string, params: any[] = []) => { db.prepare(sql).run(...params); },
        all: async (sql: string, params: any[] = []) => db.prepare(sql).all(...params),
        first: async (sql: string, params: any[] = []) => { const r = db.prepare(sql).get(...params); return r ?? null; },
      };
    }),
  }));
}
function resetMem() { for (const k of Object.keys(mem)) delete mem[k]; for (const k of Object.keys(secure)) delete secure[k]; }

async function bootDefault() {
  const backend = require('../src/db/backend');
  const init = await backend.initStorage();
  if (init.mode !== 'sqlite') throw new Error('sqlite mode failed');
  const { api } = require('../src/api');
  const bookId = api.activeBookId();
  await api.initializeV2Book({ book: { id: bookId, name: 'Book1', style: 'standard', basis: 'accrual' }, period: { id: `${bookId}:period:2026`, startDate: '2026-01-01', endDate: '2026-12-31' }, personas: ['custom'] });
  await api.updateSettings({ businessName: 'Book1', currency: 'USD', hasOnboarded: true, businessType: 'shop', selectedPersonas: ['custom'], activePersona: 'custom', accountingStyle: 'standard' });
  return { api, backend, bookId };
}

describe('Finding D — backup round-trip preserves both books', () => {
  beforeEach(() => { jest.resetModules(); resetMem(); installMocks(); });

  it('format-10 backup captures the books index + every book, and a restore lists/hydrates both', async () => {
    const { api } = await bootDefault();
    await api.postV2OpeningBalances({ date: '2026-01-01', cash: 1000, inventory: 0 });
    await api.createSale({ date: '2026-06-01', amount: 500, method: 'cash' });
    const book2 = await api.createBook('Book2');
    await api.setActiveBook(book2.id);
    await api.postV2OpeningBalances({ date: '2026-01-01', cash: 50, inventory: 0 });
    await api.createSale({ date: '2026-06-01', amount: 77, method: 'cash' });
    await api.setActiveBook('default');

    const backup: any = await api.exportBackup();
    expect(backup._meta.version).toBe(10);
    // Books index captured, and Book2's secondary payload present.
    expect(backup.books.map((b: any) => b.name)).toEqual(expect.arrayContaining(['Book2']));
    expect(backup.bookData[book2.id]).toBeTruthy();
    expect(Array.isArray(backup.bookData[book2.id].collections.sales)).toBe(true);

    // Fresh device: new process/db.
    jest.resetModules(); resetMem(); installMocks();
    const backend2 = require('../src/db/backend');
    await backend2.initStorage();
    const { api: api2 } = require('../src/api');
    await api2.importBackup(backup);

    await api2.setActiveBook('default');
    const dash1 = await api2.dashboard();
    const books = await api2.listBooks();
    const b2 = books.find((b: any) => b.name === 'Book2');
    expect(dash1.totalSales).toBe(500);
    expect(!!b2).toBe(true);                 // Book2 selectable after restore
    await api2.setActiveBook(b2.id);
    const dash2 = await api2.dashboard();
    expect(dash2.totalSales).toBe(77);       // Book2's $77 sale survived
    expect(dash2.cash).toBe(127);            // 50 opening + 77 sale
  });
});

describe('Finding B — quote→invoice conversion is visible to the V2 ledger', () => {
  beforeEach(() => { jest.resetModules(); resetMem(); installMocks(); });

  it('a converted quote appears in listSalesAndInvoices, dashboard totalSales and V2 revenue', async () => {
    const { api } = await bootDefault();
    const { v2ReportsOrFallback } = require('../src/accountingV2/runtime');
    await api.postV2OpeningBalances({ date: '2026-01-01', cash: 0, inventory: 0 });
    const q = await api.createQuote({ clientName: 'Bob', date: '2026-03-01', lines: [{ description: 'Job', qty: 1, rate: 400 }] });
    const conv = await api.convertQuoteToInvoice(q.id, { date: '2026-03-02' });
    expect(conv.total).toBe(400);

    const salesInv = await api.listSalesAndInvoices();
    const legacyInv = await api.listInvoices();
    const rep = await v2ReportsOrFallback({ from: '2026-01-01', to: '2026-12-31' }, async () => ({}));
    const dash = await api.dashboard();
    expect(legacyInv.length).toBe(1);
    expect(salesInv.length).toBe(1);                 // was 0 pre-fix (V2 bypassed)
    expect(rep.report.profitAndLoss.revenue).toBe(400);
    expect(dash.totalSales).toBe(400);
    // Converting again is idempotent-guarded.
    await expect(api.convertQuoteToInvoice(q.id, { date: '2026-03-02' })).rejects.toThrow(/already been converted/i);
  });
});
