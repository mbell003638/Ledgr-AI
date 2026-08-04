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

import { createSale, getSettings, listSales, resetAll, updateSettings, factoryReset } from '../src/db/local';
import {
  createBook,
  setActiveBook,
  activeBookId,
  resetBooksAndActiveBook,
  readLogo,
} from '../src/db/backend';

beforeEach(() => { for (const key of Object.keys(mem)) delete mem[key]; });
afterEach(async () => { await setActiveBook('default'); });

describe('legacy ledger reset', () => {
  it('clears entries but preserves business identity, onboarding, theme, and partnership configuration', async () => {
    await updateSettings({
      businessName: 'Test Business',
      hasOnboarded: true,
      themeMode: 'amoled_blue',
      accountingStyle: 'retail_partnership',
      selectedPersonas: ['retail'],
      partnerNames: ['Amit'],
      investors: [{ id: 'amit', name: 'Amit', amount: 100, profitSharePct: 100 }],
    });
    await createSale({ date: '2026-07-30', amount: 50 });

    await resetAll();

    expect(await listSales()).toEqual([]);
    expect(await getSettings()).toMatchObject({
      businessName: 'Test Business',
      hasOnboarded: true,
      themeMode: 'amoled_blue',
      accountingStyle: 'retail_partnership',
      selectedPersonas: ['retail'],
      partnerNames: ['Amit'],
      investors: [{ id: 'amit', name: 'Amit', amount: 0, openingCapital: 0, currentCapital: 0, profitSharePct: 100 }],
    });
  });
});

describe('books + active-book teardown (factoryReset support) [C4/M2]', () => {
  it('removes the books index and the active-book pointer, and resets the in-memory active book', async () => {
    // Create a second book and switch to it — this writes ledgr:books + ledgr:activeBook.
    const tech = await createBook('Technician');
    await setActiveBook(tech.id);
    expect(activeBookId()).toBe(tech.id);
    expect(mem['ledgr:books']).toContain(tech.id);
    expect(mem['ledgr:activeBook']).toBe(tech.id);

    await resetBooksAndActiveBook();

    // Books index + active pointer are gone; in-memory active book is back to default.
    expect(mem['ledgr:books']).toBeUndefined();
    expect(mem['ledgr:activeBook']).toBeUndefined();
    expect(activeBookId()).toBe('default');
  });
});

describe('factoryReset clears the logo [H4]', () => {
  it('removes the business logo (stored outside the settings blob)', async () => {
    // Writing a data-URI logo routes it to the dedicated key, not the settings doc.
    await updateSettings({ logo: 'data:image/png;base64,AAAA', businessName: 'Shop' });
    expect(await readLogo()).toBe('data:image/png;base64,AAAA');
    // The settings blob must NOT carry the inline data-URI.
    const rawSettings = JSON.parse(mem['ledgr:settings'] || '{}');
    expect(typeof rawSettings.logo === 'string' && rawSettings.logo.startsWith('data:')).toBe(false);

    await factoryReset();

    expect(await readLogo()).toBe('');
  });
});
