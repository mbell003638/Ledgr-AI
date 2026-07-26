/**
 * Accounting-basis tests (feature #2).
 *
 * Proves revenue recognition differs correctly by basis, and — critically —
 * that cash-on-hand is NOT distorted by the basis choice:
 *  - accrual: revenue includes invoices raised (even if unpaid)
 *  - cash:    revenue includes only cash sales + amounts received on invoices
 *  - dashboard.cash stays identical across bases (literal cash only)
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
  createInvoice, createReceipt, createSale,
  updateSettings, dashboard, pnlRange, listDebtors,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Accounting basis — revenue recognition', () => {
  it('accrual counts an unpaid invoice as revenue; cash does not; cash-on-hand unaffected', async () => {
    // A cash sale of 100 and an unpaid invoice of 200.
    await createSale({ date: '2026-07-10', amount: 100 });
    await createInvoice({ clientName: 'X', date: '2026-07-10', total: 200, taxRate: 0, lines: [] });

    // Accrual: revenue = 100 (cash sale) + 200 (invoice) = 300
    await updateSettings({ accountingBasis: 'accrual' });
    let d = await dashboard();
    expect(d.totalSales).toBe(300);
    const cashAccrual = d.cash; // opening 0 + cash sale 100 = 100

    // Cash: revenue = 100 (cash sale) + 0 received on invoice = 100
    await updateSettings({ accountingBasis: 'cash' });
    d = await dashboard();
    expect(d.totalSales).toBe(100);
    // Cash on hand is the SAME regardless of basis (only literal cash counts)
    expect(d.cash).toBe(cashAccrual);
    expect(d.cash).toBe(100);
  });

  it('cash basis counts a receipt against the invoice as revenue + reaches cash', async () => {
    const inv = await createInvoice({ clientName: 'Y', date: '2026-07-10', total: 200, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 120, debtorId, clientName: 'Y', allocations: [{ invoiceId: inv.id, amountApplied: 120 }] });

    await updateSettings({ accountingBasis: 'cash' });
    const d = await dashboard();
    // cash-basis revenue = 0 cash sales + 120 received against invoice
    expect(d.totalSales).toBe(120);
    // and the 120 reached cash via the Cash Book IN row
    expect(d.cash).toBe(120);
  });

  it('pnlRange mirrors the basis', async () => {
    await createSale({ date: '2026-07-10', amount: 50 });
    await createInvoice({ clientName: 'Z', date: '2026-07-10', total: 300, taxRate: 0, lines: [] });

    await updateSettings({ accountingBasis: 'accrual' });
    let p = await pnlRange('2026-07-01', '2026-07-31');
    expect(p.revenue).toBe(350);

    await updateSettings({ accountingBasis: 'cash' });
    p = await pnlRange('2026-07-01', '2026-07-31');
    expect(p.revenue).toBe(50);
  });
});
