/** Current-format backup contract. Older formats were never released. */

const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => (key in mem ? mem[key] : null)),
    setItem: jest.fn(async (key: string, value: string) => { mem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete mem[key]; }),
    multiGet: jest.fn(async (keys: string[]) => keys.map((key) => [key, key in mem ? mem[key] : null])),
    multiSet: jest.fn(async (pairs: [string, string][]) => { for (const [key, value] of pairs) mem[key] = value; }),
    multiRemove: jest.fn(async (keys: string[]) => { for (const key of keys) delete mem[key]; }),
  },
}));

import { exportBackup, importBackup, BACKUP_VERSION, updateSettings } from '../src/db/local';

beforeEach(() => { for (const key of Object.keys(mem)) delete mem[key]; });

describe('current backup format', () => {
  it('exports the exact current version with preferences, books, and document collections', async () => {
    await updateSettings({ businessName: 'Shop', currency: 'USD' });
    const backup: any = await exportBackup();
    expect(backup._meta).toMatchObject({ app: 'ledgr', version: BACKUP_VERSION });
    expect(backup.settings).toMatchObject({ businessName: 'Shop', currency: 'USD' });
    expect(Array.isArray(backup.books)).toBe(true);
    expect(backup.bookData).toEqual({});
    for (const collection of ['suppliers','bills','sales','payments','inventoryChecks','periods','expenses','debtors','invoices','quotes','receipts','creditNotes','debitNotes','deliveryNotes','cashEntries']) {
      expect(Array.isArray(backup[collection])).toBe(true);
    }
  });

  it('rejects files that are not exact current-format V2 backups', async () => {
    await expect(importBackup({ _meta: { app: 'ledgr', version: BACKUP_VERSION - 1 } })).rejects.toThrow(/unsupported.*format/i);
    await expect(importBackup({ _meta: { app: 'ledgr', version: BACKUP_VERSION + 1 } })).rejects.toThrow(/unsupported.*format/i);
    await expect(importBackup({ _meta: { app: 'notledgr', version: BACKUP_VERSION } })).rejects.toThrow(/not a Ledgr backup/i);
    await expect(importBackup({ _meta: { app: 'ledgr', version: BACKUP_VERSION } })).rejects.toThrow(/does not contain.*V2/i);
  });
});
