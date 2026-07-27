import { V2Documents } from '../src/accountingV2/documents';
import { V2Ledger } from '../src/accountingV2/ledger';
import { defaultAccounts, defaultBook, emptyV2Store } from '../src/accountingV2/schema';

function setup() { const ledger = new V2Ledger(emptyV2Store()); const book = defaultBook('b', 'Shop'); ledger.createBook(book, defaultAccounts(book.id)); const docs = new V2Documents(ledger); const party = ledger.createParty({ bookId: book.id, name: 'Customer', roles: ['customer'] }); const supplier = ledger.createParty({ bookId: book.id, name: 'Supplier', roles: ['supplier'] }); return { ledger, docs, book, party, supplier }; }

test('credit sale and partial receipt reconcile without revenue double count', () => {
 const { ledger, docs, book, party } = setup(); const inv = docs.invoice(book.id, 'p', party.id, '2026-01-01', 200); const r = docs.receipt(book.id, 'p', party.id, '2026-01-02', 50, 'cash', [{ invoiceSourceId: inv.source.id, amount: 50 }]); expect(r.advance).toBe(0); expect(docs.invoiceOpen(inv.source.id)).toBe(150); expect(ledger.reconcile(book.id).balanced).toBe(true);
});

test('mark paid collects only remaining amount', () => {
 const { ledger, docs, book, party } = setup(); const inv = docs.invoice(book.id, 'p', party.id, '2026-01-01', 200); docs.receipt(book.id, 'p', party.id, '2026-01-02', 50, 'cash', [{ invoiceSourceId: inv.source.id, amount: 50 }]); const paid = docs.markInvoicePaid(book.id, 'p', inv.source.id, '2026-01-03'); expect(paid.source.metadata?.total).toBe(150); expect(docs.invoiceOpen(inv.source.id)).toBe(0); expect(ledger.balance(book.id, `${book.id}:account:1100`)).toBe(0); });

test('overpayment becomes customer advance, not sales', () => { const { ledger, docs, book, party } = setup(); const inv = docs.invoice(book.id, 'p', party.id, '2026-01-01', 200); const r = docs.receipt(book.id, 'p', party.id, '2026-01-02', 300, 'cash', [{ invoiceSourceId: inv.source.id, amount: 200 }]); expect(r.advance).toBe(100); expect(ledger.balance(book.id, `${book.id}:account:2100`)).toBe(-100); });

test('cash and credit purchases post to different liabilities/cash accounts', () => { const { ledger, docs, book, supplier } = setup(); docs.purchase(book.id, 'p', supplier.id, '2026-01-01', 100, 'cash'); docs.purchase(book.id, 'p', supplier.id, '2026-01-02', 200); expect(ledger.balance(book.id, `${book.id}:account:1000`)).toBe(-100); expect(ledger.balance(book.id, `${book.id}:account:2000`)).toBe(-200); expect(ledger.reconcile(book.id).balanced).toBe(true); });
