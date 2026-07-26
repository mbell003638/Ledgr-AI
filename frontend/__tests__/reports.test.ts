/**
 * Enhanced reports tests: taxReport, salesRegister, receiptsRegister.
 */

const mem: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    setItem: jest.fn(async (k: string, v: string) => { mem[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete mem[k]; }),
  },
}));

import {
  createSale, createInvoice, createReceipt, listDebtors,
  updateSettings, taxReport, salesRegister, receiptsRegister,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('salesRegister', () => {
  it('lists cash sales and invoices with correct totals', async () => {
    await createSale({ date: '2026-07-10', amount: 100 });
    await createInvoice({ clientName: 'A', date: '2026-07-11', total: 250, taxRate: 0, lines: [] });
    const r = await salesRegister('2026-07-01', '2026-07-31');
    expect(r.count).toBe(2);
    expect(r.cashTotal).toBe(100);
    expect(r.invoiceTotal).toBe(250);
    expect(r.total).toBe(350);
  });
});

describe('receiptsRegister', () => {
  it('groups receipts by method and totals them', async () => {
    await createReceipt({ mode: 'cash_sale', date: '2026-07-10', amount: 100, method: 'cash' });
    await createReceipt({ mode: 'cash_sale', date: '2026-07-11', amount: 50, method: 'card' });
    const r = await receiptsRegister('2026-07-01', '2026-07-31');
    expect(r.count).toBe(2);
    expect(r.total).toBe(150);
    expect(r.byMethod.cash).toBe(100);
    expect(r.byMethod.card).toBe(50);
  });
});

describe('taxReport', () => {
  it('computes output tax on invoices (accrual) with a tax rate', async () => {
    await updateSettings({ accountingBasis: 'accrual', taxRate: 5, taxLabel: 'VAT' });
    // Invoice of 105 incl 5% tax -> tax component = 5
    await createInvoice({ clientName: 'T', date: '2026-07-10', total: 105, taxRate: 5, lines: [] });
    const r = await taxReport('2026-07-01', '2026-07-31');
    expect(r.outputTax).toBeCloseTo(5, 1);
    expect(r.netOutputTax).toBeCloseTo(5, 1);
  });
});
