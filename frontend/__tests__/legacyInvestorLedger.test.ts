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

  it('uses the reviewed close date for the archive, inventory check, capital carry, and next period start', async () => {
    await updateSettings({
      accountingStyle: 'retail_partnership', currentPeriodStart: '2026-01-01', openingInventory: 25, openingCash: 10,
      investors: [{ id: 'alice', name: 'Alice', amount: 100, profitSharePct: 100 }], partnerNames: ['Alice'],
    });
    await writeColl('sales', [{ id: 'sale', date: '2026-08-09', amount: 50 }]);

    const period = await closePeriod(30, 'Reviewed close', 0, '2026-08-10');

    expect(period).toEqual(expect.objectContaining({ startDate: '2026-01-01', endDate: '2026-08-10', closingInventory: 30 }));
    expect(await readColl<any>('inventoryChecks')).toEqual([
      expect.objectContaining({ date: '2026-08-10', actualStock: 30, notes: 'Period close: 2026-01-01 → 2026-08-10' }),
    ]);
    expect(await getSettings()).toEqual(expect.objectContaining({
      currentPeriodStart: '2026-08-10',
      openingInventory: 30,
      investors: [expect.objectContaining({ id: 'alice', date: '2026-08-10', profitSharePct: 100 })],
    }));
  });

  it('rejects a reviewed close date before later legacy activity without writing close state', async () => {
    await updateSettings({
      accountingStyle: 'retail_partnership', currentPeriodStart: '2026-01-01', openingInventory: 25, openingCash: 10,
      investors: [{ id: 'alice', name: 'Alice', amount: 100, profitSharePct: 100 }], partnerNames: ['Alice'],
    });
    await writeColl('sales', [{ id: 'future-sale', date: '2026-08-11', amount: 50 }]);
    const settingsBefore = await getSettings();

    await expect(closePeriod(30, 'Too early', 0, '2026-08-10')).rejects.toThrow(/contains activity dated 2026-08-11/i);

    expect(await readColl<any>('periods')).toEqual([]);
    expect(await readColl<any>('inventoryChecks')).toEqual([]);
    expect(await getSettings()).toEqual(settingsBefore);
  });

  it('blocks individual investor ledgers outside Partnership Mode', async () => {
    await updateSettings({ accountingStyle: 'standard', investors: [{ id: 'owner', name: 'Owner', amount: 100 }] });
    await expect(investorLedgerDetail('owner')).rejects.toThrow(/Partnership Mode/i);
    await expect(recordInvestorCapital('owner', { date: '2026-07-01', amount: 10 })).rejects.toThrow(/Partnership Mode/i);
  });
});
