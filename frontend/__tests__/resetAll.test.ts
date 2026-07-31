const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => (key in mem ? mem[key] : null)),
    setItem: jest.fn(async (key: string, value: string) => { mem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete mem[key]; }),
  },
}));

import { createSale, getSettings, listSales, resetAll, updateSettings } from '../src/db/local';

beforeEach(() => { for (const key of Object.keys(mem)) delete mem[key]; });

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
