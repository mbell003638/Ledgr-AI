/**
 * Party-sale → invoice → debtor regression tests.
 *
 * Guards the crash reported from the field: opening an invoice created by the
 * quick Sale form threw "Cannot read property 'toFixed' of undefined" because
 * the sale form wrote line items as { qty, price } while the Invoice screen
 * reads l.rate. These tests prove the backend wiring a party sale depends on:
 *  - createInvoice with a { qty, rate } line stores a numeric total and links a
 *    debtor (the customer receivable).
 *  - The stored invoice line carries `rate` (the field the UI renders), so no
 *    undefined `.toFixed` can occur.
 *  - A credit party sale shows up as a debtor with the invoice on its ledger.
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

import { createInvoice, listInvoices, listDebtors, getDebtorStatement } from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Party sale → invoice → debtor', () => {
  it('creates an invoice with a numeric total and a rate-bearing line', async () => {
    // Mirrors exactly what app/sale-form.tsx sends for a credit (party) sale.
    const inv = await createInvoice({
      clientName: 'Walk-in Customer',
      clientPhone: '',
      date: '2026-07-26',
      lines: [{ description: 'Sale', qty: 1, rate: 250 }],
      total: 250,
      taxRate: 0,
    });

    // Total is a real number — never undefined (the crash precondition).
    expect(typeof inv.total).toBe('number');
    expect(inv.total).toBe(250);

    // The line carries `rate` (what invoices.tsx renders), not `price`.
    expect(inv.lines[0].rate).toBe(250);
    expect(inv.lines[0].price).toBeUndefined();

    // The stored invoice list agrees, and every line rate is a finite number,
    // so `l.rate.toFixed(2)` in the UI can never crash.
    const invs = await listInvoices();
    expect(invs).toHaveLength(1);
    for (const l of invs[0].lines) {
      expect(Number.isFinite(Number(l.rate))).toBe(true);
    }
  });

  it('links the party sale to a debtor ledger', async () => {
    await createInvoice({
      clientName: 'Party Cust',
      date: '2026-07-26',
      lines: [{ description: 'Sale', qty: 1, rate: 400 }],
      total: 400,
      taxRate: 0,
    });

    const debtors = await listDebtors();
    const d = debtors.find((x: any) => x.name === 'Party Cust');
    expect(d).toBeDefined();

    // The receivable shows the invoiced amount as the outstanding balance.
    const st = await getDebtorStatement(d!.id);
    expect(st.balance).toBe(400);
  });
});
