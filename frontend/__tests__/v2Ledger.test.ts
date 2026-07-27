import { defaultAccounts, defaultBook, emptyV2Store, isBalanced } from '../src/accountingV2/schema';
import { V2Ledger } from '../src/accountingV2/ledger';

function setup() {
  const ledger = new V2Ledger(emptyV2Store());
  const book = defaultBook('book_1', 'Test Shop', 'retail_partnership');
  ledger.createBook(book, defaultAccounts(book.id));
  return { ledger, book };
}

test('rejects unbalanced journals and accepts balanced journals', () => {
  const { ledger, book } = setup();
  expect(isBalanced([{ accountId: 'x', debit: 10, credit: 0 }, { accountId: 'y', debit: 0, credit: 10 }])).toBe(true);
  expect(() => ledger.post({ bookId: book.id, periodId: 'p1', date: '2026-01-01', memo: 'bad', lines: [{ accountId: `${book.id}:account:1000`, debit: 10, credit: 0 }] })).toThrow(/balance/);
  const entry = ledger.post({ bookId: book.id, periodId: 'p1', date: '2026-01-01', memo: 'sale', lines: [
    { accountId: `${book.id}:account:1000`, debit: 10, credit: 0 },
    { accountId: `${book.id}:account:4000`, debit: 0, credit: 10 },
  ] });
  expect(entry.lines).toHaveLength(2);
  expect(ledger.reconcile(book.id)).toMatchObject({ balanced: true, debit: 10, credit: 10, difference: 0 });
});

test('parties can have customer and supplier roles without name matching', () => {
  const { ledger, book } = setup();
  const p = ledger.createParty({ bookId: book.id, name: 'Both Co', roles: ['customer', 'supplier'] });
  expect(p.roles).toEqual(['customer', 'supplier']);
  expect(() => ledger.createParty({ bookId: book.id, name: 'No Role', roles: [] })).toThrow(/customer/);
});

test('reverses a journal exactly once', () => {
  const { ledger, book } = setup();
  const original = ledger.post({ bookId: book.id, periodId: 'p1', date: '2026-01-01', memo: 'sale', lines: [
    { accountId: `${book.id}:account:1000`, debit: 25, credit: 0 },
    { accountId: `${book.id}:account:4000`, debit: 0, credit: 25 },
  ] });
  const reversal = ledger.reverse(original.id, '2026-01-02', 'correction');
  expect(reversal.reversalOf).toBe(original.id);
  expect(ledger.reconcile(book.id).balanced).toBe(true);
  expect(() => ledger.reverse(original.id, '2026-01-03', 'again')).toThrow(/reversed/);
});
