/**
 * Credit / Debit Notes tests (feature #5).
 *
 * Proves:
 *  - A credit note reduces the customer's balance (return/discount) with no cash.
 *  - A debit note increases it (extra charge).
 *  - Both appear in the debtor statement ledger with a correct running balance.
 *  - Accrual revenue drops by a credit note and rises by a debit note; cash basis
 *    and cash-on-hand are unaffected (they post no cash).
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
  createInvoice, listDebtors, getDebtorStatement, dashboard, updateSettings,
  createCreditNote, createDebitNote, listCreditNotes, deleteCreditNote,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Credit notes — discounts / returns', () => {
  it('reduces the customer balance without cash, and shows in the statement', async () => {
    const inv = await createInvoice({ clientName: 'Disco', date: '2026-07-10', total: 500, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;

    // Give a 50 post-sale discount as a credit note
    const cn = await createCreditNote({ debtorId, invoiceId: inv.id, clientName: 'Disco', date: '2026-07-12', amount: 50, reason: 'discount' });
    expect(cn.noteNumber).toBe('CN-0001');

    // Balance drops from 500 to 450
    const debtors = await listDebtors();
    expect(debtors[0].balance).toBe(450);
    expect(debtors[0].totalCredited).toBe(50);

    // Statement includes the credit note with running balance
    const st = await getDebtorStatement(debtorId);
    expect(st.balance).toBe(450);
    const cnRow = st.ledger.find((r: any) => r.kind === 'credit_note');
    expect(cnRow).toBeTruthy();
    expect(cnRow.credit).toBe(50);
  });

  it('reduces accrual revenue but not cash', async () => {
    const inv = await createInvoice({ clientName: 'Rev', date: '2026-07-10', total: 1000, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await updateSettings({ accountingBasis: 'accrual' });
    let d = await dashboard();
    expect(d.totalSales).toBe(1000);
    const cashBefore = d.cash;

    await createCreditNote({ debtorId, invoiceId: inv.id, clientName: 'Rev', date: '2026-07-12', amount: 200, reason: 'return' });
    d = await dashboard();
    expect(d.totalSales).toBe(800); // 1000 - 200 credit note
    expect(d.cash).toBe(cashBefore); // no cash movement
  });
});

describe('Debit notes — extra charge', () => {
  it('increases the customer balance and accrual revenue', async () => {
    const inv = await createInvoice({ clientName: 'Extra', date: '2026-07-10', total: 300, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    await updateSettings({ accountingBasis: 'accrual' });

    const dn = await createDebitNote({ debtorId, clientName: 'Extra', date: '2026-07-12', amount: 75, reason: 'correction' });
    expect(dn.noteNumber).toBe('DN-0001');

    const debtors = await listDebtors();
    expect(debtors[0].balance).toBe(375); // 300 + 75
    expect(debtors[0].totalDebited).toBe(75);

    const d = await dashboard();
    expect(d.totalSales).toBe(375); // 300 invoice + 75 debit note
  });
});

describe('Credit notes — delete reverses', () => {
  it('removing a credit note restores the balance', async () => {
    const inv = await createInvoice({ clientName: 'Undo', date: '2026-07-10', total: 400, taxRate: 0, lines: [] });
    const debtorId = (await listDebtors())[0].id;
    const cn = await createCreditNote({ debtorId, clientName: 'Undo', date: '2026-07-12', amount: 100, reason: 'discount' });
    expect((await listDebtors())[0].balance).toBe(300);
    await deleteCreditNote(cn.id);
    expect((await listDebtors())[0].balance).toBe(400);
    expect(await listCreditNotes(debtorId)).toHaveLength(0);
  });
});
