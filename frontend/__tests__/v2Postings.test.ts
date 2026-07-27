import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { postCashSale, postInvoice, postReceipt, postPurchase, postSupplierPayment, postExpense, postCreditNote, postDebitNote } from '../src/accountingV2/postings';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('book-cash', 'Cash Shop');
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'period-open', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
  return { ...node, repo, book };
}

describe('persistent V2 cash-sale posting tracer', () => {
  it('atomically persists source, journal and balanced lines', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const posted = await postCashSale(repo, { bookId: book.id, periodId: 'period-open', date: '2026-07-27', amount: 75, method: 'bank', reference: 'SALE-1' });
      expect(await runner.first('SELECT id FROM v2_sources WHERE id=?', [posted.source.id])).toBeTruthy();
      expect(await runner.first('SELECT id FROM v2_journal_entries WHERE source_id=?', [posted.source.id])).toBeTruthy();
      expect(await runner.all('SELECT debit,credit FROM v2_journal_lines WHERE journal_id=?', [posted.journal.id])).toEqual([{ debit: 75, credit: 0 }, { debit: 0, credit: 75 }]);
      await expect(repo.reconcileBook(book.id)).resolves.toMatchObject({ balanced: true, difference: 0 });
    } finally { close(); }
  });

  it('rejects closed periods before writing source or journal', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await runner.run("UPDATE v2_periods SET status='closed' WHERE id='period-open'");
      await expect(postCashSale(repo, { bookId: book.id, periodId: 'period-open', date: '2026-07-27', amount: 75 })).rejects.toThrow(/closed/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects values that become unbalanced after cent rounding', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await expect(repo.postJournal({
        bookId: book.id, periodId: 'period-open', date: '2026-07-27', memo: 'Rounding edge',
        lines: [
          { accountId: `${book.id}:account:1000`, debit: 0.004, credit: 0 },
          { accountId: `${book.id}:account:1010`, debit: 0.004, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 0.008 },
        ],
      })).rejects.toThrow(/round|balance/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects a posting dated outside the open period bounds', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await expect(postCashSale(repo, { bookId: book.id, periodId: 'period-open', date: '2026-08-01', amount: 75 })).rejects.toThrow(/period/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects unsupported other payment method instead of posting it to mobile', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await expect(postCashSale(repo, { bookId: book.id, periodId: 'period-open', date: '2026-07-27', amount: 75, method: 'other' })).rejects.toThrow(/payment method/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects non-finite journal values before normalization', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await expect(repo.postJournal({
        bookId: book.id, periodId: 'period-open', date: '2026-07-27', memo: 'Non-finite',
        lines: [
          { accountId: `${book.id}:account:1000`, debit: Number.NaN, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 10 },
        ],
      })).rejects.toThrow(/finite|valid|balance/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects a source date that differs from its journal date', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await expect(repo.postSourceJournal(
        { id: 'source-mismatch', bookId: book.id, type: 'cash_sale', date: '2026-07-26' },
        { bookId: book.id, periodId: 'period-open', date: '2026-07-27', memo: 'Mismatch', lines: [
          { accountId: `${book.id}:account:1000`, debit: 10, credit: 0 },
          { accountId: `${book.id}:account:4000`, debit: 0, credit: 10 },
        ] },
      )).rejects.toThrow(/date/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects cross-book and duplicate reversal references', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const original = await repo.postJournal({ bookId: book.id, periodId: 'period-open', date: '2026-07-27', memo: 'Original', lines: [
        { accountId: `${book.id}:account:1000`, debit: 10, credit: 0 }, { accountId: `${book.id}:account:4000`, debit: 0, credit: 10 },
      ] });
      const other = defaultBook('other-book', 'Other');
      await repo.createBook(other, defaultAccounts(other.id));
      await repo.createPeriod({ id: 'other-period', bookId: other.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
      await expect(repo.postJournal({ bookId: other.id, periodId: 'other-period', date: '2026-07-27', memo: 'Bad reversal', reversalOf: original.id, lines: [
        { accountId: `${other.id}:account:4000`, debit: 10, credit: 0 }, { accountId: `${other.id}:account:1000`, debit: 0, credit: 10 },
      ] })).rejects.toThrow(/reversal|book/i);
      await repo.postJournal({ bookId: book.id, periodId: 'period-open', date: '2026-07-28', memo: 'First reversal', reversalOf: original.id, lines: [
        { accountId: `${book.id}:account:4000`, debit: 10, credit: 0 }, { accountId: `${book.id}:account:1000`, debit: 0, credit: 10 },
      ] });
      await expect(repo.postJournal({ bookId: book.id, periodId: 'period-open', date: '2026-07-29', memo: 'Duplicate', reversalOf: original.id, lines: [
        { accountId: `${book.id}:account:4000`, debit: 10, credit: 0 }, { accountId: `${book.id}:account:1000`, debit: 0, credit: 10 },
      ] })).rejects.toThrow(/already reversed/i);
    } finally { close(); }
  });

  it('atomically persists a customer invoice against a stable party', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const party = { id: 'customer-1', bookId: book.id, name: 'Customer', roles: ['customer'] as ('customer'|'supplier')[] };
      await repo.createParty(party);
      const posted = await postInvoice(repo, { bookId: book.id, periodId: 'period-open', partyId: party.id, date: '2026-07-27', amount: 200, reference: 'INV-1' });
      expect(posted.source.metadata).toMatchObject({ partyId: party.id, total: 200, status: 'unpaid' });
      expect(await runner.first('SELECT id FROM v2_sources WHERE id=?', [posted.source.id])).toBeTruthy();
      expect(await runner.all('SELECT account_id,party_id,debit,credit FROM v2_journal_lines WHERE journal_id=?', [posted.journal.id])).toEqual([
        { account_id: `${book.id}:account:1100`, party_id: party.id, debit: 200, credit: 0 },
        { account_id: `${book.id}:account:4000`, party_id: null, debit: 0, credit: 200 },
      ]);
    } finally { close(); }
  });

  it('rejects invoice posting for a non-customer or another book party', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const supplier = { id: 'supplier-1', bookId: book.id, name: 'Supplier', roles: ['supplier'] as ('customer'|'supplier')[] };
      await repo.createParty(supplier);
      await expect(postInvoice(repo, { bookId: book.id, periodId: 'period-open', partyId: supplier.id, date: '2026-07-27', amount: 200 })).rejects.toThrow(/customer/i);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('posts receipt allocations and excess advance atomically', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const party = { id: 'receipt-customer', bookId: book.id, name: 'Customer', roles: ['customer'] as ('customer'|'supplier')[] };
      await repo.createParty(party);
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'period-open', partyId: party.id, date: '2026-07-20', amount: 100 });
      const receipt = await postReceipt(repo, { bookId: book.id, periodId: 'period-open', partyId: party.id, date: '2026-07-27', amount: 140, method: 'bank', allocations: [{ invoiceSourceId: invoice.source.id, amount: 100 }] });
      expect(receipt).toMatchObject({ allocated: 100, advance: 40 });
      expect(await repo.invoiceOpen(invoice.source.id)).toBe(0);
      expect(await runner.all('SELECT invoice_source_id,receipt_source_id,amount FROM v2_invoice_allocations')).toEqual([{ invoice_source_id: invoice.source.id, receipt_source_id: receipt.source.id, amount: 100 }]);
      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [receipt.journal.id])).toEqual([
        { account_id: `${book.id}:account:1010`, debit: 140, credit: 0 },
        { account_id: `${book.id}:account:1100`, debit: 0, credit: 100 },
        { account_id: `${book.id}:account:2100`, debit: 0, credit: 40 },
      ]);
    } finally { close(); }
  });

  it('rejects duplicate allocations that together exceed invoice open balance', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const party = { id: 'dup-customer', bookId: book.id, name: 'Customer', roles: ['customer'] as ('customer'|'supplier')[] };
      await repo.createParty(party);
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'period-open', partyId: party.id, date: '2026-07-20', amount: 100 });
      await expect(postReceipt(repo, { bookId: book.id, periodId: 'period-open', partyId: party.id, date: '2026-07-27', amount: 120, method: 'cash', allocations: [
        { invoiceSourceId: invoice.source.id, amount: 70 }, { invoiceSourceId: invoice.source.id, amount: 50 },
      ] })).rejects.toThrow(/open balance/i);
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_sources WHERE type='receipt'"))?.n)).toBe(0);
    } finally { close(); }
  });

  it('posts purchases, supplier payments, expenses, and customer notes correctly', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      const supplier = { id: 'persistent-supplier', bookId: book.id, name: 'Supplier', roles: ['supplier'] as ('customer'|'supplier')[] };
      const customerParty = { id: 'notes-customer', bookId: book.id, name: 'Customer', roles: ['customer'] as ('customer'|'supplier')[] };
      await repo.createParty(supplier); await repo.createParty(customerParty);
      const purchase = await postPurchase(repo, { bookId: book.id, periodId: 'period-open', partyId: supplier.id, date: '2026-07-20', amount: 200 });
      await postSupplierPayment(repo, { bookId: book.id, periodId: 'period-open', partyId: supplier.id, date: '2026-07-21', amount: 50, method: 'bank' });
      await postExpense(repo, { bookId: book.id, periodId: 'period-open', date: '2026-07-22', amount: 30, method: 'cash' });
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'period-open', partyId: customerParty.id, date: '2026-07-20', amount: 100 });
      await postCreditNote(repo, { bookId: book.id, periodId: 'period-open', partyId: customerParty.id, invoiceSourceId: invoice.source.id, date: '2026-07-23', amount: 10 });
      await postDebitNote(repo, { bookId: book.id, periodId: 'period-open', partyId: customerParty.id, invoiceSourceId: invoice.source.id, date: '2026-07-24', amount: 5 });
      expect(purchase.source.type).toBe('credit_purchase');
      expect(await repo.reconcileBook(book.id)).toMatchObject({ balanced: true, difference: 0 });
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_sources WHERE type IN ('credit_purchase','supplier_payment','expense','credit_note','debit_note')"))?.n)).toBe(5);
    } finally { close(); }
  });

  it('rolls back the source and journal header when a line insert fails', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await runner.exec(`CREATE TRIGGER fail_sale_credit BEFORE INSERT ON v2_journal_lines WHEN NEW.credit > 0 BEGIN SELECT RAISE(FAIL, 'injected posting failure'); END;`);
      await expect(postCashSale(repo, { bookId: book.id, periodId: 'period-open', date: '2026-07-27', amount: 75 })).rejects.toThrow(/injected posting failure/);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_lines'))?.n)).toBe(0);
    } finally { close(); }
  });
});
