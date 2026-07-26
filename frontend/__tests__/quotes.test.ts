/**
 * Quotes / Estimates tests (feature #3).
 *
 * Proves the defining property of a quote: it has NO ledger effect until it is
 * converted into an invoice. Then conversion creates a real invoice + debtor,
 * stamps the quote 'converted', and refuses a second conversion.
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
  createQuote, listQuotes, updateQuote, deleteQuote, setQuoteStatus, convertQuoteToInvoice,
  listInvoices, listDebtors, dashboard, updateSettings,
} from '../src/db/local';

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; });

describe('Quotes — non-posting until converted', () => {
  it('a quote has no ledger effect (no invoice, no debtor, no revenue)', async () => {
    await updateSettings({ accountingBasis: 'accrual' });
    const q = await createQuote({ clientName: 'Acme', date: '2026-07-10', lines: [{ description: 'Design', qty: 2, rate: 100 }], taxRate: 0 });
    expect(q.quoteNumber).toBe('QUO-0001');
    expect(q.total).toBe(200);
    expect(q.status).toBe('draft');

    // Nothing posted anywhere
    expect(await listInvoices()).toHaveLength(0);
    expect(await listDebtors()).toHaveLength(0);
    const d = await dashboard();
    expect(d.totalSales).toBe(0); // even accrual basis sees no revenue from a quote
  });

  it('recomputes total on line/tax edit', async () => {
    const q = await createQuote({ clientName: 'B', date: '2026-07-10', lines: [{ description: 'x', qty: 1, rate: 100 }], taxRate: 0 });
    const up = await updateQuote(q.id, { lines: [{ description: 'x', qty: 1, rate: 100 }], taxRate: 10 });
    expect(up.total).toBe(110);
  });

  it('status transitions work', async () => {
    const q = await createQuote({ clientName: 'C', date: '2026-07-10', lines: [], taxRate: 0 });
    await setQuoteStatus(q.id, 'sent');
    expect((await listQuotes())[0].status).toBe('sent');
    await setQuoteStatus(q.id, 'accepted');
    expect((await listQuotes())[0].status).toBe('accepted');
  });
});

describe('Quotes — conversion to invoice', () => {
  it('converts to a real invoice + debtor and marks the quote converted', async () => {
    await updateSettings({ accountingBasis: 'accrual' });
    const q = await createQuote({ clientName: 'Convert Co', date: '2026-07-10', lines: [{ description: 'Job', qty: 1, rate: 500 }], taxRate: 0 });

    const inv = await convertQuoteToInvoice(q.id, { date: '2026-07-12' });
    expect(inv.total).toBe(500);

    // Invoice + debtor now exist
    expect(await listInvoices()).toHaveLength(1);
    const debtors = await listDebtors();
    expect(debtors).toHaveLength(1);
    expect(debtors[0].name).toBe('Convert Co');
    expect(debtors[0].balance).toBe(500);

    // Accrual revenue now reflects the converted invoice
    const d = await dashboard();
    expect(d.totalSales).toBe(500);

    // Quote is stamped converted with the invoice id
    const quote = (await listQuotes())[0];
    expect(quote.status).toBe('converted');
    expect(quote.convertedInvoiceId).toBe(inv.id);
  });

  it('refuses to convert the same quote twice', async () => {
    const q = await createQuote({ clientName: 'Once', date: '2026-07-10', lines: [{ description: 'j', qty: 1, rate: 100 }], taxRate: 0 });
    await convertQuoteToInvoice(q.id);
    await expect(convertQuoteToInvoice(q.id)).rejects.toThrow(/already been converted/i);
    // only one invoice created
    expect(await listInvoices()).toHaveLength(1);
  });

  it('delete removes the quote', async () => {
    const q = await createQuote({ clientName: 'Del', date: '2026-07-10', lines: [], taxRate: 0 });
    await deleteQuote(q.id);
    expect(await listQuotes()).toHaveLength(0);
  });
});
