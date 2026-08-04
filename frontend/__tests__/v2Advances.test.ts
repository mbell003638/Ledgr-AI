/**
 * Advances that actually apply (audit M1/M2).
 *
 * Customer (2100): over-paying a receipt creates an advance; a later invoice for the
 * same party auto-consumes it (Dr 2100 / Cr 1100), reducing the debtor's AR and setting
 * the invoice paid-status.
 *
 * Supplier (1210): over-paying a supplier routes the excess to a Supplier Advances asset
 * (Dr 1210) rather than driving AP into a debit; a later credit bill for that supplier
 * applies the advance (Cr 1210), reducing the new payable.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { postInvoice, postReceipt, postPurchase, postSupplierPayment } from '../src/accountingV2/postings';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('adv-book', 'Advance Shop');
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'p', bookId: book.id, startDate: '2026-07-01', endDate: '2026-07-31', status: 'open' });
  return { ...node, repo, book };
}

const bal = async (repo: any, bookId: string, code: string, partyId?: string) => {
  const clause = partyId ? 'AND l.party_id=?' : '';
  const params = partyId ? [bookId, code, partyId] : [bookId, code];
  const row = await repo.db.first(
    `SELECT COALESCE(SUM(l.debit-l.credit),0) AS b FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id JOIN v2_accounts a ON a.id=l.account_id WHERE j.book_id=? AND a.code=? ${clause}`,
    params,
  );
  return Math.round(Number(row.b) * 100) / 100;
};

describe('customer advances auto-apply', () => {
  it('consumes a prior over-payment when the next invoice is created', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await repo.createParty({ id: 'cust', bookId: book.id, name: 'Customer', roles: ['customer'] });
      // Over-pay with no invoice: 300 cash in, all advance.
      const receipt = await postReceipt(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-05', amount: 300, method: 'cash' });
      expect(receipt.advance).toBe(300);
      expect(await bal(repo, book.id, '2100')).toBe(-300); // liability (credit) 300

      // New invoice for 500 → 300 advance auto-applied, 200 receivable remains.
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-10', amount: 500 });
      expect(invoice.advanceApplied).toBe(300);
      expect(invoice.source.metadata).toMatchObject({ status: 'partial', advanceApplied: 300 });
      expect(await bal(repo, book.id, '1100', 'cust')).toBe(200); // AR net of applied advance
      expect(await bal(repo, book.id, '2100')).toBe(0);           // advance fully consumed
      expect(await repo.invoiceOpen(invoice.source.id)).toBe(200); // paid-status reflects the advance
      expect((await repo.reconcileBook(book.id)).balanced).toBe(true);
    } finally { close(); }
  });

  it('fully settles an invoice smaller than the advance and leaves the remainder as advance', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await repo.createParty({ id: 'cust', bookId: book.id, name: 'Customer', roles: ['customer'] });
      await postReceipt(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-05', amount: 300, method: 'cash' });
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'p', partyId: 'cust', date: '2026-07-10', amount: 120 });
      expect(invoice.advanceApplied).toBe(120);
      expect(invoice.source.metadata).toMatchObject({ status: 'paid' });
      expect(await repo.invoiceOpen(invoice.source.id)).toBe(0);
      expect(await bal(repo, book.id, '2100')).toBe(-180); // 300 − 120 remains as advance
      expect(await bal(repo, book.id, '1100', 'cust')).toBe(0);
    } finally { close(); }
  });
});

describe('supplier advances', () => {
  it('routes a supplier over-payment to 1210 instead of a negative AP, then applies it to a later bill', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await repo.createParty({ id: 'sup', bookId: book.id, name: 'Supplier', roles: ['supplier'] });
      // Pay 200 with no outstanding payable → whole 200 becomes a supplier advance (1210).
      const payment = await postSupplierPayment(repo, { bookId: book.id, periodId: 'p', partyId: 'sup', date: '2026-07-05', amount: 200, method: 'bank' });
      expect(payment.supplierAdvance).toBe(200);
      expect(await bal(repo, book.id, '1210', 'sup')).toBe(200); // asset (debit) 200
      expect(await bal(repo, book.id, '2000', 'sup')).toBe(0);   // AP NOT driven negative

      // Credit bill for 250 → 200 advance applied, only 50 left as payable.
      const bill = await postPurchase(repo, { bookId: book.id, periodId: 'p', partyId: 'sup', date: '2026-07-10', amount: 250 });
      expect(bill.supplierAdvanceApplied).toBe(200);
      expect(bill.source.metadata).toMatchObject({ supplierAdvanceApplied: 200 });
      expect(await bal(repo, book.id, '1210', 'sup')).toBe(0);   // advance consumed
      expect(await bal(repo, book.id, '2000', 'sup')).toBe(-50); // payable net (credit 50)
      expect(await bal(repo, book.id, '1200')).toBe(250);        // inventory still recognised in full
      expect((await repo.reconcileBook(book.id)).balanced).toBe(true);
    } finally { close(); }
  });

  it('partially settles the payable when the payment exceeds it', async () => {
    const { runner, close, repo, book } = await setup();
    try {
      await repo.createParty({ id: 'sup', bookId: book.id, name: 'Supplier', roles: ['supplier'] });
      await postPurchase(repo, { bookId: book.id, periodId: 'p', partyId: 'sup', date: '2026-07-04', amount: 80 }); // AP 80
      const payment = await postSupplierPayment(repo, { bookId: book.id, periodId: 'p', partyId: 'sup', date: '2026-07-06', amount: 100, method: 'cash' });
      expect(payment.supplierAdvance).toBe(20); // 80 clears AP, 20 becomes advance
      expect(await bal(repo, book.id, '2000', 'sup')).toBe(0);
      expect(await bal(repo, book.id, '1210', 'sup')).toBe(20);
    } finally { close(); }
  });
});
