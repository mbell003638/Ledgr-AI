/**
 * Members / capital profit-share tests.
 *
 * Verifies capitalStatement()'s per-member profit split:
 *  - no explicit % → equal split (unchanged legacy behaviour)
 *  - explicit % on each member → honoured proportionally
 *  - partial % (some blank) → blanks share the remaining %
 * Uses the same in-memory AsyncStorage mock as backend.test.ts.
 */

const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mem[k]; }),
    getAllKeys: jest.fn(async () => Object.keys(mem)),
    multiRemove: jest.fn(async (ks: string[]) => { ks.forEach((k) => delete mem[k]); }),
  },
}));

import { capitalStatement, updateSettings } from '../src/db/local';
import { writeColl } from '../src/db/backend';

beforeEach(async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  // Seed a clean book with a known net profit: sales 1000, no purchases/expenses.
  await writeColl('sales', [{ id: 's1', date: '2026-07-01', amount: 1000, items: [] }]);
});

describe('capitalStatement — member profit share', () => {
  it('splits equally when no explicit percentages are set', async () => {
    await updateSettings({
      currentPeriodStart: '1970-01-01',
      investors: [
        { id: 'A', name: 'Alice', amount: 500 },
        { id: 'B', name: 'Bob', amount: 500 },
      ],
    });
    const cap = await capitalStatement();
    const netProfit = cap.netProfit;
    expect(cap.investors).toHaveLength(2);
    // Equal split → each gets half.
    expect(cap.investors[0].profitShare).toBeCloseTo(netProfit / 2, 2);
    expect(cap.investors[1].profitShare).toBeCloseTo(netProfit / 2, 2);
  });

  it('honours explicit percentages (70/30)', async () => {
    await updateSettings({
      currentPeriodStart: '1970-01-01',
      investors: [
        { id: 'A', name: 'Alice', amount: 500, profitSharePct: 70 },
        { id: 'B', name: 'Bob', amount: 500, profitSharePct: 30 },
      ],
    });
    const cap = await capitalStatement();
    const netProfit = cap.netProfit;
    expect(cap.investors[0].profitShare).toBeCloseTo(netProfit * 0.7, 2);
    expect(cap.investors[1].profitShare).toBeCloseTo(netProfit * 0.3, 2);
  });

  it('gives blank-% members the remaining share', async () => {
    await updateSettings({
      currentPeriodStart: '1970-01-01',
      investors: [
        { id: 'A', name: 'Alice', amount: 500, profitSharePct: 60 },
        { id: 'B', name: 'Bob', amount: 500 }, // blank → gets remaining 40%
      ],
    });
    const cap = await capitalStatement();
    const netProfit = cap.netProfit;
    expect(cap.investors[0].profitShare).toBeCloseTo(netProfit * 0.6, 2);
    expect(cap.investors[1].profitShare).toBeCloseTo(netProfit * 0.4, 2);
  });
});
