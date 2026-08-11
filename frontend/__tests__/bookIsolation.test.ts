/**
 * Multi-book ("multiple businesses") isolation & lifecycle verification.
 *
 * READ-ONLY verification engineer test. Creates two books in one SQLite DB and
 * proves calculations stay independent across book_id, that the app-facing read
 * path (activeContext) selects the correct book, that the dataVersion cache is
 * keyed per active book, and characterizes lifecycle + backup behaviour.
 *
 * Two layers are exercised:
 *  - V2 layer: direct repository / dashboard / trial balance keyed by book_id.
 *  - App/backend layer: the AsyncStorage-namespaced book router in backend.ts
 *    (mocked AsyncStorage), which is what the app actually uses to switch books.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { initializeV2Book, accountingBookVersion, V2_BOOK_VERSION } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { getV2Dashboard } from '../src/accountingV2/v2Dashboard';
import { buildPersistentV2Reports, persistentV2Reports } from '../src/accountingV2/persistentReports';
import { resetV2AccountingData } from '../src/accountingV2/resetBook';
import { exportV2Data, importV2Data } from '../src/db/v2Backup';
import {
  getDataVersion, bumpDataVersion, getCached, setCached, isCacheFresh, clearDataCache,
} from '../src/utils/dataVersion';

// ---- Helpers ---------------------------------------------------------------

// Boot a runner with two independent V2 books (A, B) in the SAME sqlite db.
async function twoBookRunner() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: 'bookA', name: 'Shop' },
    period: { id: 'bookA:period:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  await initializeV2Book(node.runner, {
    book: { id: 'bookB', name: 'Technician' },
    period: { id: 'bookB:period:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  return node;
}

// Point the "active book" pointer the app read-path (activeContext) reads.
async function setActiveV2Book(runner: any, bookId: string) {
  await runner.run(
    "INSERT INTO meta(key,value) VALUES('v2_active_book_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [bookId],
  );
}

// ===========================================================================
// ITEM 1 — Data isolation at the V2 (double-entry) layer.
// ===========================================================================
describe('Item 1 — V2 layer data isolation across book_id', () => {
  it('keeps sales/bills/receipts, dashboard, trial balance and P&L independent per book', async () => {
    const { runner, close } = await twoBookRunner();
    const svc = new V2AppService(runner);
    try {
      // --- Book A: 300 cash sale, 120 cash bill ---
      await setActiveV2Book(runner, 'bookA');
      await svc.createSale({ date: '2026-03-01', amount: 300, method: 'cash' });
      await svc.createBill({ date: '2026-03-02', amount: 120, supplierName: 'A-Vendor', paymentType: 'cash', method: 'cash' });

      // --- Book B: different amounts — 50 cash sale, 999 credit bill ---
      await setActiveV2Book(runner, 'bookB');
      await svc.createSale({ date: '2026-03-01', amount: 50, method: 'cash' });
      await svc.createBill({ date: '2026-03-02', amount: 999, supplierName: 'B-Vendor', paymentType: 'credit' });

      // Dashboards must reflect ONLY their own book's numbers.
      const dashA = await getV2Dashboard(runner, 'bookA');
      const dashB = await getV2Dashboard(runner, 'bookB');
      expect(dashA.totalSales).toBe(300);
      expect(dashA.totalPurchases).toBe(120);
      expect(dashB.totalSales).toBe(50);
      expect(dashB.totalPurchases).toBe(999);
      expect(dashA.totalSales).not.toBe(dashB.totalSales);

      // Trial balances balance independently and carry only own-book revenue.
      const repA = await buildPersistentV2Reports(runner, { bookId: 'bookA' });
      const repB = await buildPersistentV2Reports(runner, { bookId: 'bookB' });
      expect(repA.trialBalance.totals.difference).toBe(0);
      expect(repB.trialBalance.totals.difference).toBe(0);
      expect(repA.profitAndLoss.revenue).toBe(300);
      expect(repB.profitAndLoss.revenue).toBe(50);

      // Parties do NOT leak across books.
      const partiesA = await runner.all("SELECT name FROM v2_parties WHERE book_id='bookA'");
      const partiesB = await runner.all("SELECT name FROM v2_parties WHERE book_id='bookB'");
      expect(partiesA).toEqual([{ name: 'A-Vendor' }]);
      expect(partiesB).toEqual([{ name: 'B-Vendor' }]);

      // Accounts/periods are per-book: every account row and journal entry is scoped.
      const crossAccounts = await runner.all("SELECT id FROM v2_accounts WHERE book_id='bookA' AND id LIKE 'bookB:%'");
      expect(crossAccounts).toEqual([]);
      const jeBooks = await runner.all('SELECT DISTINCT book_id FROM v2_journal_entries ORDER BY book_id');
      expect(jeBooks).toEqual([{ book_id: 'bookA' }, { book_id: 'bookB' }]);
      const journalLinesLeak = await runner.first(
        "SELECT COUNT(*) n FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.book_id='bookA' AND l.account_id LIKE 'bookB:%'",
      );
      expect(Number(journalLinesLeak.n)).toBe(0);
    } finally { close(); }
  });

  it('resetV2AccountingData clears only the target book, leaving the other intact', async () => {
    const { runner, close } = await twoBookRunner();
    const svc = new V2AppService(runner);
    try {
      await setActiveV2Book(runner, 'bookA');
      await svc.createSale({ date: '2026-03-01', amount: 300, method: 'cash' });
      await setActiveV2Book(runner, 'bookB');
      await svc.createSale({ date: '2026-03-01', amount: 50, method: 'cash' });

      // Reset book A only.
      const res = await resetV2AccountingData(runner, 'bookA', '2026-01-01');
      expect(res.reset).toBe(true);

      const dashA = await getV2Dashboard(runner, 'bookA');
      const dashB = await getV2Dashboard(runner, 'bookB');
      expect(dashA.totalSales).toBe(0);   // A wiped
      expect(dashB.totalSales).toBe(50);  // B untouched

      // A's journals gone; B's remain.
      const aJournals = await runner.first("SELECT COUNT(*) n FROM v2_journal_entries WHERE book_id='bookA'");
      const bJournals = await runner.first("SELECT COUNT(*) n FROM v2_journal_entries WHERE book_id='bookB'");
      expect(Number(aJournals.n)).toBe(0);
      expect(Number(bJournals.n)).toBeGreaterThan(0);
      // A still exists as a book (identity preserved) with a fresh open period.
      const aBook = await runner.first("SELECT id FROM v2_books WHERE id='bookA'");
      expect(aBook).toEqual({ id: 'bookA' });
    } finally { close(); }
  });
});

// ===========================================================================
// ITEM 2 — App-layer isolation: activeContext switching + dataVersion cache.
// ===========================================================================
describe('Item 2 — App read-path isolation via activeContext + dataVersion cache', () => {
  it('activeContext resolves to the pointed book so list/dashboard reads are book-scoped', async () => {
    const { runner, close } = await twoBookRunner();
    const svc = new V2AppService(runner);
    try {
      await setActiveV2Book(runner, 'bookA');
      await svc.createSale({ date: '2026-03-01', amount: 300, method: 'cash' });
      await svc.createInvoice({ date: '2026-03-02', total: 40, clientName: 'Alice' });

      // Active = A: the app's list surface (listSalesAndInvoices/listBills) sees A's rows.
      let ctx = await svc.activeContext();
      expect(ctx?.bookId).toBe('bookA');
      let salesA = await svc.listSalesAndInvoices();
      expect(salesA.map((s: any) => s.amount).sort((x: number, y: number) => x - y)).toEqual([40, 300]);

      // Switch active to B (as api.setActiveBook does): B is empty.
      await setActiveV2Book(runner, 'bookB');
      ctx = await svc.activeContext();
      expect(ctx?.bookId).toBe('bookB');
      expect(await svc.listSalesAndInvoices()).toEqual([]);
      expect(await svc.listBills()).toEqual([]);
      expect(await svc.listParties()).toEqual([]);

      // Switch back to A: A's data is intact.
      await setActiveV2Book(runner, 'bookA');
      salesA = await svc.listSalesAndInvoices();
      expect(salesA.map((s: any) => s.amount).sort((x: number, y: number) => x - y)).toEqual([40, 300]);
    } finally { close(); }
  });

  it('dataVersion cache is keyed by activeBookId so book A cache cannot serve book B', () => {
    clearDataCache();
    // Simulate two screens caching under per-book keys (screenKey + activeBookId).
    const keyA = 'dashboard:bookA';
    const keyB = 'dashboard:bookB';
    setCached(keyA, { totalSales: 300 });
    // Book B has never cached: its key is a miss even though A is fresh.
    expect(getCached(keyA)).toEqual({ version: getDataVersion(), data: { totalSales: 300 } });
    expect(getCached(keyB)).toBeUndefined();
    expect(isCacheFresh(keyA)).toBe(true);
    expect(isCacheFresh(keyB)).toBe(false); // B cannot read A's payload

    // A mutation (what api.setActiveBook + writes call) bumps the version, so
    // even A's own stale entry is invalidated on the next focus.
    bumpDataVersion();
    expect(isCacheFresh(keyA)).toBe(false);
    clearDataCache();
  });
});

// ===========================================================================
// ITEM 3 — Lifecycle via the real backend.ts book router (mocked AsyncStorage).
// This block isolates the module so it can mock AsyncStorage without disturbing
// the runner-based blocks above.
// ===========================================================================
describe('Item 3 — Book lifecycle (backend.ts router, AsyncStorage mode)', () => {
  const mem: Record<string, string> = {};
  let backend: typeof import('../src/db/backend');

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: {
        getItem: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
        setItem: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
        removeItem: jest.fn(async (k: string) => { delete mem[k]; }),
        multiGet: jest.fn(async (ks: string[]) => ks.map((k) => [k, k in mem ? mem[k] : null])),
        multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [k, v] of pairs) mem[k] = v; }),
        multiRemove: jest.fn(async (ks: string[]) => { for (const k of ks) delete mem[k]; }),
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    backend = require('../src/db/backend');
  });
  afterAll(() => { jest.dontMock('@react-native-async-storage/async-storage'); jest.resetModules(); });
  beforeEach(async () => { for (const k of Object.keys(mem)) delete mem[k]; await backend.setActiveBook('default'); });

  it('createBook appears in index; renameBook updates it; independent namespaced data', async () => {
    const created = await backend.createBook('Technician', 'service');
    const books = await backend.listBooks();
    expect(books.find((b) => b.id === created.id)?.name).toBe('Technician');
    expect(books.find((b) => b.id === 'default')).toBeTruthy(); // default always present

    await backend.renameBook(created.id, 'Repairs');
    expect((await backend.listBooks()).find((b) => b.id === created.id)?.name).toBe('Repairs');

    // Namespaced writes stay in the book's own key space.
    await backend.setActiveBook(created.id);
    await backend.writeColl('sales', [{ id: 'b-1', amount: 5 }]);
    expect(mem[`ledgr:${created.id}:sales`]).toContain('b-1');
    expect(mem['ledgr:sales']).toBeUndefined(); // default key untouched
  });

  it('deleteBook removes ONLY its namespaced keys; deleting the active book falls back to default', async () => {
    await backend.writeColl('sales', [{ id: 'main', amount: 1 }]); // default book data
    const b = await backend.createBook('Temp');
    await backend.setActiveBook(b.id);
    await backend.writeColl('sales', [{ id: 'temp', amount: 2 }]);
    await backend.writeSettings({ businessName: 'Temp Co' });
    expect(mem[`ledgr:${b.id}:sales`]).toBeDefined();

    // Delete while ACTIVE — must fall back to default sanely.
    await backend.deleteBook(b.id);
    expect(backend.activeBookId()).toBe('default');
    expect(mem[`ledgr:${b.id}:sales`]).toBeUndefined();      // its data gone
    expect(mem[`ledgr:${b.id}:settings`]).toBeUndefined();
    expect((await backend.listBooks()).find((x) => x.id === b.id)).toBeFalsy();
    // Default book intact.
    expect(JSON.parse(mem['ledgr:sales'])[0].id).toBe('main');

    await expect(backend.deleteBook('default')).rejects.toThrow(); // guard
  });

  it('sequences (invoice numbers) are independent per book — separate namespaced collections', async () => {
    // Invoice numbering derives from each book's own (namespaced) invoices collection.
    await backend.setActiveBook('default');
    await backend.writeColl('invoices', [{ id: 'i1', invoiceNumber: 'INV-001' }, { id: 'i2', invoiceNumber: 'INV-002' }]);
    const b = await backend.createBook('Second');
    await backend.setActiveBook(b.id);
    // Second book starts with an EMPTY invoice list — its sequence is independent.
    expect(await backend.readColl('invoices')).toEqual([]);
    await backend.writeColl('invoices', [{ id: 'x', invoiceNumber: 'INV-001' }]);
    // Same human number can exist in both books without collision (separate key spaces).
    await backend.setActiveBook('default');
    expect((await backend.readColl('invoices'))).toHaveLength(2);
    await backend.setActiveBook(b.id);
    expect((await backend.readColl('invoices'))).toHaveLength(1);
  });
});

// ===========================================================================
// ITEM 4 — Backup interplay: V2 payload captures ALL books; legacy is active-only.
// ===========================================================================
describe('Item 4 — Backup coverage across books', () => {
  it('exportV2Data captures EVERY book (not just the active one) and round-trips', async () => {
    const { runner, close } = await twoBookRunner();
    const svc = new V2AppService(runner);
    try {
      await setActiveV2Book(runner, 'bookA');
      await svc.createSale({ date: '2026-03-01', amount: 300, method: 'cash' });
      await setActiveV2Book(runner, 'bookB');
      await svc.createSale({ date: '2026-03-01', amount: 50, method: 'cash' });

      // Active book is B, but the V2 export must contain BOTH books' data.
      const payload = await exportV2Data(runner);
      const bookIds = payload.tables['v2_books'].map((r: any) => r.id).sort();
      expect(bookIds).toEqual(['bookA', 'bookB']);
      const jeBooks = new Set(payload.tables['v2_journal_entries'].map((r: any) => r.book_id));
      expect(jeBooks).toEqual(new Set(['bookA', 'bookB']));
      expect(payload.meta['v2_active_book_id']).toBe('bookB');

      // Restore into a fresh DB reproduces BOTH books' numbers.
      const dest = makeNodeRunner();
      try {
        await initSchema(dest.runner);
        await dest.runner.exec('BEGIN');
        await importV2Data(dest.runner, payload);
        await dest.runner.exec('COMMIT');
        expect((await getV2Dashboard(dest.runner, 'bookA')).totalSales).toBe(300);
        expect((await getV2Dashboard(dest.runner, 'bookB')).totalSales).toBe(50);
        expect(await accountingBookVersion(dest.runner, 'bookB')).toBe(V2_BOOK_VERSION);
      } finally { dest.close(); }
    } finally { close(); }
  });
});

// ===========================================================================
// ITEM 5 — Architectural question: does a secondary book run on V2, or bypass it?
// Determines whether createBook produced a versioned V2 book that activeContext
// resolves (=> secondary books ARE on V2 when a runner exists), and documents
// the runner-absent (AsyncStorage-only) degradation.
// ===========================================================================
describe('Item 5 — Secondary book routing (V2 vs legacy)', () => {
  it('a book created with a runner present IS a versioned V2 book that activeContext resolves', async () => {
    const { runner, close } = await twoBookRunner(); // bookB stands in for a "secondary" book
    const svc = new V2AppService(runner);
    try {
      // Secondary book bookB has V2 version 2 and an open period.
      expect(await accountingBookVersion(runner, 'bookB')).toBe(V2_BOOK_VERSION);
      await setActiveV2Book(runner, 'bookB');
      const ctx = await svc.activeContext('2026-03-01');
      expect(ctx?.bookId).toBe('bookB');

      // Posting to it produces real double-entry journals (NOT a V1 bypass).
      const sale = await svc.createSale({ date: '2026-03-01', amount: 77, method: 'cash' });
      const lines = await runner.all(
        'SELECT debit,credit FROM v2_journal_lines WHERE journal_id=?',
        [(await runner.first('SELECT id FROM v2_journal_entries WHERE source_id=?', [sale.source.id])).id],
      );
      const debit = lines.reduce((s: number, l: any) => s + Number(l.debit), 0);
      const credit = lines.reduce((s: number, l: any) => s + Number(l.credit), 0);
      expect(debit).toBe(credit); // balanced double entry on the secondary book
      expect(debit).toBe(77);

      // And the authoritative V2 report is available for the secondary book.
      const rep = await buildPersistentV2Reports(runner, { bookId: 'bookB' });
      expect(rep.profitAndLoss.revenue).toBe(77);
    } finally { close(); }
  });

  it('DOCUMENTS the gap: with NO runner, createBook cannot initialize V2 so the book has no V2 layer', async () => {
    // Reproduce backend.createBook when runner===null: the V2 init branch is skipped.
    // We assert the *consequence* against a fresh V2 DB: a book that was never
    // initialized has version=null, so activeContext and reports reject it.
    const { runner, close } = await twoBookRunner();
    const svc = new V2AppService(runner);
    try {
      // 'ghost' simulates a book that exists in the AsyncStorage index but was
      // never given a V2 record (createBook's `if (runner)` guard was false).
      await setActiveV2Book(runner, 'ghost');
      expect(await accountingBookVersion(runner, 'ghost')).toBeNull();
      // activeContext refuses a non-versioned book.
      expect(await svc.activeContext('2026-03-01')).toBeNull();
      // The RAW report builder throws BOOK_NOT_FOUND for a book with no V2 record
      // (proving it never silently borrows another book's numbers)...
      await expect(buildPersistentV2Reports(runner, { bookId: 'ghost' })).rejects.toThrow(/not found/i);
      // ...and the app-facing wrapper surfaces the same missing-book error.
      await expect(persistentV2Reports(runner, { bookId: 'ghost' })).rejects.toThrow(/not found/i);
    } finally { close(); }
  });
});
