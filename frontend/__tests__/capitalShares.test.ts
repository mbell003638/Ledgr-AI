/**
 * Partner/investor profit shares must ALWAYS sum EXACTLY to net profit. [Penny H2/M3]
 *
 * Historically the equal split used `+(netProfit/shareCount).toFixed(2)`, so a
 * 3-way split of $100 produced 33.33 × 3 = 99.99 (a stray cent). The fix routes
 * through drift-safe money math and assigns the final member the remainder.
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

import { createSale, updateSettings, capitalStatement } from '../src/db/local';
import { addMoney } from '../src/money';

beforeEach(() => { for (const key of Object.keys(mem)) delete mem[key]; });

async function setupNetProfit100(investors: any[]) {
  await updateSettings({
    accountingStyle: 'retail_partnership',
    managerCommissionPct: 0,        // so net profit == gross profit
    currentPeriodStart: '2026-01-01',
    openingInventory: 0,
    investors,
    partnerNames: investors.map((i) => i.name),
  });
  // One cash sale of $100, no purchases → gross = net = 100.
  await createSale({ date: '2026-07-01', amount: 100 });
}

describe('capital statement profit shares', () => {
  it('splits $100 three ways as 33.33 / 33.33 / 33.34 and sums to exactly 100', async () => {
    await setupNetProfit100([
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
      { id: 'C', name: 'C' },
    ]);

    const cs = await capitalStatement();
    expect(cs.netProfit).toBe(100);
    const shares = cs.investors.map((i: any) => i.profitShare);
    expect(shares).toEqual([33.33, 33.33, 33.34]);
    expect(addMoney(...shares)).toBe(100);
  });

  it('single investor receives the full net profit', async () => {
    await setupNetProfit100([{ id: 'Solo', name: 'Solo' }]);
    const cs = await capitalStatement();
    expect(cs.investors[0].profitShare).toBe(cs.netProfit);
    expect(addMoney(...cs.investors.map((i: any) => i.profitShare))).toBe(cs.netProfit);
  });

  it('explicit percentages that round still sum exactly to net profit', async () => {
    await setupNetProfit100([
      { id: 'A', name: 'A', profitSharePct: 33.333 },
      { id: 'B', name: 'B', profitSharePct: 33.333 },
      { id: 'C', name: 'C', profitSharePct: 33.334 },
    ]);
    const cs = await capitalStatement();
    expect(addMoney(...cs.investors.map((i: any) => i.profitShare))).toBe(cs.netProfit);
  });
});
