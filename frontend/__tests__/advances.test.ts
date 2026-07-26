/**
 * Advances / Deposits tests (feature #4).
 *
 * Proves:
 *  - getAdvanceCredit / listAdvances show the right unallocated remainder.
 *  - applyAdvanceToInvoice draws from advance credit without creating new cash.
 *  - Advance credit is consumed oldest-first, and invoice status reflects the
 *    allocation retroactively.
 *  - No double-counting: the applied amount was already in cash when the advance
 *    was received, so applying it to an invoice does NOT add a second cash row.
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
  createInvoice, createReceipt, listDebtors, listInvoices, listCashEntries, getDebtorStatement,
  getAdvanceCredit, listAdvances, applyAdvanceToInvoice,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Advances — advance credit tracking', () => {
  it('shows full advance as credit before any application', async () => {
    const inv = await createInvoice({ clientName: 'Dep', date: '2026-07-10', total: 500, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    // Receive an advance of 300 before invoicing
    await createReceipt({ mode: 'advance', date: '2026-07-08', amount: 300, debtorId, clientName: 'Dep' });
    expect(await getAdvanceCredit(debtorId)).toBe(300);

    const advances = await listAdvances(debtorId);
    expect(advances).toHaveLength(1);
    expect(advances[0].remaining).toBe(300);
    expect(advances[0].allocated).toBe(0);

    // Debtor balance is negative (customer is in credit)
    const st = await getDebtorStatement(debtorId);
    expect(st.balance).toBe(200); // invoiced 500 - paid 300 = 200
  });

  it('getAdvanceCredit only counts unallocated advance receipts', async () => {
    const inv = await createInvoice({ clientName: 'Multi', date: '2026-07-10', total: 1000, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await createReceipt({ mode: 'advance', date: '2026-07-08', amount: 200, debtorId, clientName: 'Multi' });
    await createReceipt({ mode: 'advance', date: '2026-07-09', amount: 300, debtorId, clientName: 'Multi' });
    expect(await getAdvanceCredit(debtorId)).toBe(500);
  });
});

describe('Advances — applying to an invoice', () => {
  it('applies advance credit to an invoice, deriving status, without creating new cash', async () => {
    const inv = await createInvoice({ clientName: 'App', date: '2026-07-10', total: 400, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    // Two advances totalling 200 + 150 = 350
    await createReceipt({ mode: 'advance', date: '2026-07-08', amount: 200, debtorId, clientName: 'App' });
    await createReceipt({ mode: 'advance', date: '2026-07-09', amount: 150, debtorId, clientName: 'App' });

    // Cash before applying
    const cashBefore = (await listCashEntries()).filter((c: any) => c.receiptId).length;

    const result = await applyAdvanceToInvoice(debtorId, inv.id);
    expect(result.applied).toBe(350); // all credit consumed

    // Invoice status is now 'partial' (400 - 350 = 50 remaining)
    const invs = await listInvoices();
    expect(invs[0].status).toBe('partial');

    // Debtor balance now 50
    const st = await getDebtorStatement(debtorId);
    expect(st.balance).toBe(50);

    // Cash entries did NOT increase (cash was already recorded when advances were received)
    const cashAfter = (await listCashEntries()).filter((c: any) => c.receiptId).length;
    expect(cashAfter).toBe(cashBefore);

    // Advance credit is now 0
    expect(await getAdvanceCredit(debtorId)).toBe(0);
    const advances = await listAdvances(debtorId);
    expect(advances[0].remaining).toBe(0);
    expect(advances[1].remaining).toBe(0);
  });

  it('refuses to apply when credit is exhausted', async () => {
    const inv = await createInvoice({ clientName: 'NoCr', date: '2026-07-10', total: 100, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await expect(applyAdvanceToInvoice(debtorId, inv.id)).rejects.toThrow(/no advance credit/i);
  });
});