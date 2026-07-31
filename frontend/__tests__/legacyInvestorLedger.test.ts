const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => (key in mem ? mem[key] : null)),
    setItem: jest.fn(async (key: string, value: string) => { mem[key] = value; }),
    removeItem: jest.fn(async (key: string) => { delete mem[key]; }),
    getAllKeys: jest.fn(async () => Object.keys(mem)),
    multiRemove: jest.fn(async (keys: string[]) => { keys.forEach((key) => delete mem[key]); }),
  },
}));

import { closePeriod, getSettings, investorLedgerDetail, recordInvestorCapital, recordInvestorDrawing, updateSettings } from '../src/db/local';
import { readColl, writeColl } from '../src/db/backend';

beforeEach(() => { for (const key of Object.keys(mem)) delete mem[key]; });

describe('legacy partnership investor ledger fallback', () => {
  it('links manual capital entries and named drawings without deducting drawings twice', async () => {
    await updateSettings({
      accountingStyle: 'retail_partnership', currentPeriodStart: '1970-01-01', openingInventory: 0, openingCash: 100,
      investors: [
        { id: 'alice', name: 'Alice', amount: 100, profitSharePct: 60 },
        { id: 'bob', name: 'Bob', amount: 200, profitSharePct: 40 },
      ],
      partnerNames: ['Alice', 'Bob'],
    });
    await writeColl('sales', [{ id: 'sale', date: '2026-07-01', amount: 100 }]);
    await writeColl('cashEntries', [{ id: 'deposit', date: '2026-07-02', direction: 'in', amount: 50, type: 'capital_injection', investorId: 'alice', partnerName: 'Alice', notes: 'Capital injection' }]);
    await writeColl('payments', [{ id: 'draw', date: '2026-07-03', type: 'drawing', amount: 20, partnerName: 'Alice', notes: 'Personal draw' }]);

    await expect(investorLedgerDetail('alice')).resolves.toEqual(expect.objectContaining({
      openingCapital: 100, totalInjected: 50, totalDrawings: 20, profitShare: 60, currentCapitalBalance: 190,
    }));
  });

  it('records quick actions with investor attribution and carries the closing standing forward', async () => {
    await updateSettings({
      accountingStyle: 'retail_partnership', currentPeriodStart: '1970-01-01', openingInventory: 0, openingCash: 0,
      investors: [{ id: 'alice', name: 'Alice', amount: 100, profitSharePct: 100 }], partnerNames: ['Alice'],
    });
    const date = new Date().toISOString().slice(0, 10);
    await writeColl('sales', [{ id: 'sale', date, amount: 100 }]);
    await recordInvestorCapital('alice', { date, amount: 50, notes: 'Extra capital' });
    await recordInvestorDrawing('alice', { date, amount: 20, notes: 'Owner draw' });
    expect(await readColl<any>('cashEntries')).toEqual([expect.objectContaining({ type: 'capital_injection', investorId: 'alice', partnerName: 'Alice', amount: 50 })]);
    expect(await readColl<any>('payments')).toEqual([expect.objectContaining({ type: 'drawing', investorId: 'alice', partnerName: 'Alice', amount: 20 })]);

    await closePeriod(0, 'Close partnership period');
    expect((await getSettings()).investors).toEqual([expect.objectContaining({ id: 'alice', name: 'Alice', amount: 230, profitSharePct: 100 })]);
  });

  it('blocks individual investor ledgers outside Partnership Mode', async () => {
    await updateSettings({ accountingStyle: 'standard', investors: [{ id: 'owner', name: 'Owner', amount: 100 }] });
    await expect(investorLedgerDetail('owner')).rejects.toThrow(/Partnership Mode/i);
    await expect(recordInvestorCapital('owner', { date: '2026-07-01', amount: 10 })).rejects.toThrow(/Partnership Mode/i);
  });
});
