/**
 * Backup export/import behavior in AsyncStorage mode (no SQLite runner). [C3/H1/H4]
 *
 * Covers:
 *   - export shape: 16 collections + settings + separate logo key + format v10 [Finding D adds books index + per-book payload]
 *   - CLEARING import: a collection absent from an older backup is wiped, never
 *     left with stale rows [H1]
 *   - logo round-trips through the dedicated key (never inside the settings blob) [H4]
 *   - a pre-V2 backup reports v2Missing (rebuild-from-legacy) [C1]
 *   - failed import rolls back the snapshot (best-effort) [C3]
 */

const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => (key in mem ? mem[key] : null)),
    setItem: jest.fn(async (key: string, value: string) => { mem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete mem[key]; }),
    multiGet: jest.fn(async (keys: string[]) => keys.map((k) => [k, k in mem ? mem[k] : null])),
    multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [k, v] of pairs) mem[k] = v; }),
    multiRemove: jest.fn(async (keys: string[]) => { for (const k of keys) delete mem[k]; }),
  },
}));

import {
  createSale, createBill, listSales, listBills,
  updateSettings, getSettings,
  exportBackup, importBackup, BACKUP_VERSION,
} from '../src/db/local';
import { readLogo } from '../src/db/backend';

beforeEach(() => { for (const key of Object.keys(mem)) delete mem[key]; });

describe('exportBackup', () => {
  it('captures all collections + settings + a separate logo key at the current backup format', async () => {
    await updateSettings({ businessName: 'Shop', logo: 'data:image/png;base64,ZZZ' });
    await createSale({ date: '2026-07-01', amount: 100 });
    await createBill({ date: '2026-07-02', amount: 40, supplierName: 'ACME' });

    const backup: any = await exportBackup();
    expect(backup._meta.version).toBe(BACKUP_VERSION);
    expect(backup._meta.app).toBe('ledgr');
    // Every legacy collection key is present as an array.
    for (const c of ['suppliers', 'bills', 'sales', 'payments', 'inventoryChecks', 'periods', 'expenses', 'debtors', 'invoices', 'quotes', 'receipts', 'creditNotes', 'debitNotes', 'deliveryNotes', 'cashEntries']) {
      expect(Array.isArray(backup[c])).toBe(true);
    }
    expect(backup.sales).toHaveLength(1);
    // Logo is exported OUT of the settings blob.
    expect(backup.logo).toBe('data:image/png;base64,ZZZ');
    expect(typeof backup.settings.logo === 'string' && backup.settings.logo.startsWith('data:')).toBe(false);
    // No V2 payload without a runner.
    expect(backup.v2).toBeUndefined();
    // [Finding D] Format 10 also carries the books index + a per-book payload map.
    // With no secondary book both are empty here, but the keys are always present
    // (listBooks re-injects the default at read time, so an empty raw index is fine).
    expect(backup._meta.version).toBe(10);
    expect(Array.isArray(backup.books)).toBe(true);
    expect(backup.bookData && typeof backup.bookData === 'object' && Object.keys(backup.bookData).length).toBe(0);
  });
});

describe('importBackup — clearing + logo + v2Missing', () => {
  it('CLEARS collections absent from an older backup instead of leaking stale rows [H1]', async () => {
    // Pre-existing data in TWO collections.
    await createSale({ date: '2026-06-01', amount: 10 });
    await createBill({ date: '2026-06-02', amount: 20, supplierName: 'Old' });
    expect(await listSales()).toHaveLength(1);
    expect(await listBills()).toHaveLength(1);

    // A backup that only carries `sales` (bills omitted, as an older format would).
    const partialBackup = {
      _meta: { app: 'ledgr', version: BACKUP_VERSION },
      sales: [{ id: 'restored', date: '2026-07-01', amount: 55 }],
      settings: { businessName: 'Restored' },
    };
    const result: any = await importBackup(partialBackup);

    // Sales replaced; bills CLEARED (not left stale).
    const sales = await listSales();
    expect(sales).toHaveLength(1);
    expect((sales[0] as any).id).toBe('restored');
    expect(await listBills()).toEqual([]);
    expect((await getSettings()).businessName).toBe('Restored');
    // No runner → v2Missing true, but no warning is surfaced (nothing to rebuild).
    expect(result.v2Missing).toBe(true);
    expect(result.v2Restored).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('restores a logo carried at the top level into the dedicated key [H4]', async () => {
    const backup = {
      _meta: { app: 'ledgr', version: BACKUP_VERSION },
      sales: [],
      settings: { businessName: 'WithLogo' },
      logo: 'data:image/jpeg;base64,LOGO',
    };
    await importBackup(backup);
    expect(await readLogo()).toBe('data:image/jpeg;base64,LOGO');
    // getSettings surfaces it as `logo` for consumers.
    expect((await getSettings()).logo).toBe('data:image/jpeg;base64,LOGO');
    // But the raw settings blob does not carry the data-URI.
    const rawSettings = JSON.parse(mem['ledgr:settings'] || '{}');
    expect(typeof rawSettings.logo === 'string' && rawSettings.logo.startsWith('data:')).toBe(false);
  });

  it('migrates a legacy inline logo from an older backup settings blob [H4]', async () => {
    const backup = {
      _meta: { app: 'ledgr', version: 8 }, // older format, logo inline in settings
      sales: [],
      settings: { businessName: 'Legacy', logo: 'data:image/png;base64,INLINE' },
    };
    await importBackup(backup);
    expect(await readLogo()).toBe('data:image/png;base64,INLINE');
    const rawSettings = JSON.parse(mem['ledgr:settings'] || '{}');
    expect(typeof rawSettings.logo === 'string' && rawSettings.logo.startsWith('data:')).toBe(false);
  });

  it('rejects a newer-format backup', async () => {
    await expect(importBackup({ _meta: { app: 'ledgr', version: BACKUP_VERSION + 1 }, sales: [] }))
      .rejects.toThrow(/newer version/i);
  });

  it('rejects a non-Ledgr file', async () => {
    await expect(importBackup({ _meta: { app: 'notledgr' }, sales: [] })).rejects.toThrow(/not a Ledgr backup/i);
  });

  it('rolls back the AsyncStorage snapshot when a write fails mid-import [C3]', async () => {
    await createSale({ date: '2026-06-01', amount: 10 });
    // Force a failure: AsyncStorage.setItem throws on the bills key.
    const AS = require('@react-native-async-storage/async-storage').default;
    const realSet = AS.setItem;
    AS.setItem = jest.fn(async (k: string, v: string) => {
      if (k === 'ledgr:bills') throw new Error('disk full');
      mem[k] = v;
    });
    try {
      await expect(importBackup({
        _meta: { app: 'ledgr', version: BACKUP_VERSION },
        sales: [{ id: 'new', date: '2026-07-01', amount: 99 }],
        bills: [{ id: 'b', date: '2026-07-01', amount: 1 }],
      })).rejects.toThrow(/disk full/);
    } finally {
      AS.setItem = realSet;
    }
    // Original sale restored (import rolled back).
    const sales = await listSales();
    expect(sales).toHaveLength(1);
    expect((sales[0] as any).amount).toBe(10);
  });
});
