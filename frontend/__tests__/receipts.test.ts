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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createInvoice, listInvoices,
  createReceipt, listReceipts, deleteReceipt, invoicePaidAmount,
  getAdvanceCredit,
  listDebtors, getDebtorStatement, updateDebtorPayment, deleteDebtorPayment,
  listCashEntries, listSales,
  dashboard,
} from '../src/db/local';

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (k: string) => (k in mem ? mem[k] : null));
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (k: string, v: string) => { mem[k] = v; });
  (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (k: string) => { delete mem[k]; });
});

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

describe('Debtor payment edit/delete — full reversal and repost', () => {
  it('updates linked receipt, cash, allocation, invoice status, and statement', async () => {
    const inv = await createInvoice({ clientName: 'Edit Co', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 100, debtorId, clientName: 'Edit Co', allocations: [{ invoiceId: inv.id, amountApplied: 100 }] });
    const paymentId = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment').id;

    await updateDebtorPayment(debtorId, paymentId, { amount: 40, date: '2026-07-12', notes: 'Corrected' });

    expect(await invoicePaidAmount(inv.id)).toBe(40);
    expect((await listInvoices())[0].status).toBe('partial');
    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ amount: 40, date: '2026-07-12', notes: 'Corrected' });
    const cash = (await listCashEntries()).filter((c: any) => c.receiptId === receipts[0].id);
    expect(cash).toHaveLength(1);
    expect(cash[0].amount).toBe(40);
    const statement = await getDebtorStatement(debtorId);
    expect(statement.balance).toBe(60);
    expect(statement.ledger.find((r: any) => r.kind === 'payment')).toMatchObject({ credit: 40, date: '2026-07-12' });
  });

  it('preserves original allocation invoices and receipt metadata when an allocated payment is edited', async () => {
    const first = await createInvoice({ clientName: 'Multi Edit Co', date: '2026-07-10', total: 60, taxRate: 0, lines: [] });
    const second = await createInvoice({ clientName: 'Multi Edit Co', date: '2026-07-11', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-12', amount: 100, debtorId, clientName: 'Multi Edit Co', method: 'bank', notes: 'Bank transfer', allocations: [
      { invoiceId: first.id, amountApplied: 60 }, { invoiceId: second.id, amountApplied: 40 },
    ] });
    const paymentId = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment').id;

    await updateDebtorPayment(debtorId, paymentId, { amount: 80 });

    const receipt = (await listReceipts())[0];
    expect(receipt).toMatchObject({ amount: 80, method: 'bank', notes: 'Bank transfer' });
    expect(receipt.allocations).toEqual([
      { invoiceId: first.id, amountApplied: 60 }, { invoiceId: second.id, amountApplied: 20 },
    ]);
    expect(await invoicePaidAmount(first.id)).toBe(60);
    expect(await invoicePaidAmount(second.id)).toBe(20);
  });

  it('keeps excess from a larger edit unallocated instead of moving it to another invoice', async () => {
    const inv = await createInvoice({ clientName: 'Over Edit Co', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 100, debtorId, clientName: 'Over Edit Co', allocations: [{ invoiceId: inv.id, amountApplied: 100 }] });
    const paymentId = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment').id;

    await updateDebtorPayment(debtorId, paymentId, { amount: 140 });

    const receipt = (await listReceipts())[0];
    expect(receipt).toMatchObject({ amount: 140, mode: 'advance' });
    expect(receipt.allocations).toEqual([{ invoiceId: inv.id, amountApplied: 100 }]);
    expect(await invoicePaidAmount(inv.id)).toBe(100);
    expect(await getAdvanceCredit(debtorId)).toBe(40);
  });

  it('restores the exact original posting and removes partial replacement artifacts if repost fails', async () => {
    const inv = await createInvoice({ clientName: 'Rollback Co', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 100, debtorId, clientName: 'Rollback Co', method: 'bank', notes: 'Original', allocations: [{ invoiceId: inv.id, amountApplied: 100 }] });
    const before = {
      receipts: await listReceipts(), cash: await listCashEntries(), debtors: await listDebtors(), invoices: await listInvoices(),
    };
    const paymentId = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment').id;
    const setItem = AsyncStorage.setItem as jest.Mock;
    let cashWriteCount = 0;
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key.includes('cashEntries')) {
        cashWriteCount += 1;
        if (cashWriteCount === 2) throw new Error('injected cash write failure');
      }
      mem[key] = value;
    });

    await expect(updateDebtorPayment(debtorId, paymentId, { amount: 40 })).rejects.toThrow('injected cash write failure');

    expect(await listReceipts()).toEqual(before.receipts);
    expect(await listCashEntries()).toEqual(before.cash);
    expect(await listInvoices()).toEqual(before.invoices);
    expect(await listDebtors()).toEqual(before.debtors);
  });

  it('uses the receipt notes in the editable statement row when payment notes are unchanged', async () => {
    const inv = await createInvoice({ clientName: 'Notes Edit Co', date: '2026-07-10', total: 50, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 50, debtorId, clientName: 'Notes Edit Co', notes: 'Actual note', allocations: [{ invoiceId: inv.id, amountApplied: 50 }] });
    const payment = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment');
    expect(payment.ref).toBe('Actual note');
  });

  it('keeps an advance as unapplied customer credit when edited while invoices are open', async () => {
    await createInvoice({ clientName: 'Advance Edit Co', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'advance', date: '2026-07-11', amount: 60, debtorId, clientName: 'Advance Edit Co', notes: 'Deposit' });
    const paymentId = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment').id;

    await updateDebtorPayment(debtorId, paymentId, { amount: 70, date: '2026-07-12', notes: 'Updated deposit' });

    const receipts = await listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ mode: 'advance', amount: 70, allocations: [] });
    expect(await invoicePaidAmount((await listInvoices())[0].id)).toBe(0);
    expect((await listInvoices())[0].status).toBe('unpaid');
  });

  it('deletes a linked payment and reverses receipt, cash, allocation and invoice status', async () => {
    const inv = await createInvoice({ clientName: 'Delete Co', date: '2026-07-10', total: 80, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'against_invoice', date: '2026-07-11', amount: 80, debtorId, clientName: 'Delete Co', allocations: [{ invoiceId: inv.id, amountApplied: 80 }] });
    const paymentId = (await getDebtorStatement(debtorId)).ledger.find((r: any) => r.kind === 'payment').id;

    await deleteDebtorPayment(debtorId, paymentId);

    expect(await listReceipts()).toHaveLength(0);
    expect((await listCashEntries()).filter((c: any) => c.receiptId)).toHaveLength(0);
    expect(await invoicePaidAmount(inv.id)).toBe(0);
    expect((await listInvoices())[0].status).toBe('unpaid');
    const statement = await getDebtorStatement(debtorId);
    expect(statement.balance).toBe(80);
    expect(statement.ledger.filter((r: any) => r.kind === 'payment')).toHaveLength(0);
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
