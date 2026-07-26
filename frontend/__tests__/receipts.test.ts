/**
 * Receipts engine tests (feature #1).
 *
 * Drives the REAL local.ts receipt functions over a mocked AsyncStorage backend,
 * proving the money actually flows correctly:
 *  - cash_sale creates a `sales` revenue row AND does NOT double-count cash
 *  - against_invoice posts a debtor payment, writes a Cash Book IN row, and
 *    derives invoice status (unpaid -> partial -> paid) from allocations
 *  - advance sits as a debtor credit
 *  - deleteReceipt fully reverses every side effect
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
  createInvoice, listInvoices,
  createReceipt, listReceipts, deleteReceipt, invoicePaidAmount,
  listDebtors, getDebtorStatement,
  listCashEntries, listSales,
  dashboard,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Receipts — cash sale', () => {
  it('creates a sales revenue row and reaches dashboard revenue, no Cash Book double-count', async () => {
    await createReceipt({ mode: 'cash_sale', date: '2026-07-10', amount: 100, taxRate: 5 });
    const sales = await listSales();
    const cash = await listCashEntries();
    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receiptNumber).toBe('RCPT-0001');
    expect(sales).toHaveLength(1);              // revenue recorded
    expect(sales[0].amount).toBe(100);
    expect(cash.filter((c: any) => c.receiptId)).toHaveLength(0); // NOT also in cash book
    const d = await dashboard();
    expect(d.totalSales).toBe(100);            // shows in revenue
  });
});

describe('Receipts — against invoice (partial then full)', () => {
  it('derives status unpaid -> partial -> paid and bridges to cash', async () => {
    const inv = await createInvoice({ clientName: 'tmam', date: '2026-07-10', total: 200, taxRate: 0, lines: [{ description: 'x', qty: 1, rate: 200 }] });
    let invs = await listInvoices();
    expect(invs[0].status).toBe('unpaid');

    const debtorsBefore = await listDebtors();
    const debtorId = debtorsBefore[0].id;

    // Partial payment of 50
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 50, debtorId, clientName: 'tmam', allocations: [{ invoiceId: inv.id, amountApplied: 50 }] });
    expect(await invoicePaidAmount(inv.id)).toBe(50);
    invs = await listInvoices();
    expect(invs[0].status).toBe('partial');

    // Cash Book got the IN row (invoice money reaching cash — the bridge)
    const cash = await listCashEntries();
    expect(cash.filter((c: any) => c.direction === 'in' && c.receiptId)).toHaveLength(1);

    // Debtor balance now 150 (200 invoiced - 50 paid)
    let st = await getDebtorStatement(debtorId);
    expect(st.balance).toBe(150);

    // Pay remaining 150 -> paid
    await createReceipt({ mode: 'against_invoice', date: '2026-07-12', amount: 150, debtorId, clientName: 'tmam', allocations: [{ invoiceId: inv.id, amountApplied: 150 }] });
    invs = await listInvoices();
    expect(invs[0].status).toBe('paid');
    st = await getDebtorStatement(debtorId);
    expect(st.balance).toBe(0);
  });

  it('rejects over-allocation', async () => {
    const inv = await createInvoice({ clientName: 'A', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    await expect(createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 50, allocations: [{ invoiceId: inv.id, amountApplied: 80 }] }))
      .rejects.toThrow(/exceeds/i);
  });
});

describe('Receipts — advance', () => {
  it('sits as a debtor credit (negative balance)', async () => {
    // create a debtor via an invoice then fully offset with a bigger advance
    const inv = await createInvoice({ clientName: 'Dep', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'advance', date: '2026-07-09', amount: 300, debtorId, clientName: 'Dep' });
    const st = await getDebtorStatement(debtorId);
    // invoiced 100, paid 300 -> balance -200 (customer is in credit)
    expect(st.balance).toBe(-200);
  });
});

describe('Receipts — delete reverses everything', () => {
  it('removes sales, cash, debtor payment and reverts invoice status', async () => {
    const inv = await createInvoice({ clientName: 'Rev', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    const rc = await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 100, debtorId, clientName: 'Rev', allocations: [{ invoiceId: inv.id, amountApplied: 100 }] });
    expect((await listInvoices())[0].status).toBe('paid');

    await deleteReceipt(rc.id);
    expect(await listReceipts()).toHaveLength(0);
    expect((await listCashEntries()).filter((c: any) => c.receiptId === rc.id)).toHaveLength(0);
    expect((await invoicePaidAmount(inv.id))).toBe(0);
    expect((await listInvoices())[0].status).toBe('unpaid');
    const st = await getDebtorStatement(debtorId);
    expect(st.balance).toBe(100); // back to fully owing
  });
});
