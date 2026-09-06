import { findBestPartyMatch, similarityScore } from '../src/utils/fuzzyMatch';
import { numberToWords } from '../src/utils/numberToWords';
import { hashPayload, stableJson } from '../src/sync/protocol';
import { makeSyncOperation } from '../src/sync/outbox';
import { validatePostingInvariants, InvariantError } from '../src/accountingV2/invariants';
import { defaultAccounts, defaultBook, emptyV2Store } from '../src/accountingV2/schema';
import { V2Ledger } from '../src/accountingV2/ledger';
import { closeBooks } from '../src/accountingV2/periodClose';

describe('a short name must not silently match a much longer party', () => {
  it('scores a tiny containment by how much actually matched', () => {
    // "cash" inside "cash and carry wholesalers" used to score a flat 0.8.
    expect(similarityScore('cash', 'Cash & Carry Wholesalers')).toBeLessThan(0.65);
  });

  it('still treats a near-identical containment as a strong match', () => {
    expect(similarityScore('amit kumar', 'Amit Kumar.')).toBeGreaterThanOrEqual(0.8);
  });

  it('does not resolve a payment to an unrelated party', () => {
    const candidates = [{ id: 'p1', name: 'Cash & Carry Wholesalers' }];
    expect(findBestPartyMatch('cash', candidates)).toBeNull();
  });

  it('still finds the party a user actually named', () => {
    const candidates = [{ id: 'p1', name: 'Cash & Carry Wholesalers' }];
    expect(findBestPartyMatch('Cash & Carry Wholesaler', candidates)?.id).toBe('p1');
  });
});

describe('canonical JSON ordering is codepoint, not locale', () => {
  it('orders an uppercase letter before a lowercase one', () => {
    // localeCompare puts "taxable" first under full ICU and "taxRate" first
    // under a codepoint sort, so the two sides disagreed on the payload hash.
    const json = stableJson({ taxable: true, taxRate: 5 });
    expect(json.indexOf('taxRate')).toBeLessThan(json.indexOf('taxable'));
  });

  it('produces one ordering regardless of insertion order', () => {
    expect(stableJson({ taxable: true, taxRate: 5 })).toBe(stableJson({ taxRate: 5, taxable: true }));
  });
});

describe('generated operation fields win over the caller', () => {
  it('keeps the generated opId when the caller passes an undefined one', () => {
    const payload = {};
    const operation = makeSyncOperation({
      bookId: 'b', bookEpoch: 'e', deviceId: 'd', deviceSequence: 1, actorId: 'a',
      commandType: 'cash.patch', aggregateId: 'agg', baseRevision: 0,
      dependencies: [], payload, payloadHash: hashPayload(payload),
      clientCreatedAt: new Date().toISOString(),
      opId: undefined,
    } as never);
    expect(typeof operation.opId).toBe('string');
    expect(operation.opId.length).toBeGreaterThan(0);
  });
});

describe('a broken amount is surfaced, not reported as zero', () => {
  it('rejects a non-finite cents field instead of treating it as 0', () => {
    expect(() => validatePostingInvariants([
      { accountId: 'a', debitCents: Number.NaN, creditCents: 0 },
      { accountId: 'b', debitCents: 0, creditCents: 0 },
    ])).toThrow(InvariantError);
  });

  it('still accepts ordinary balanced cents lines', () => {
    expect(() => validatePostingInvariants([
      { accountId: 'a', debitCents: 500, creditCents: 0 },
      { accountId: 'b', debitCents: 0, creditCents: 500 },
    ])).not.toThrow();
  });
});

describe('amounts in words never render undefined', () => {
  it('handles a quotient above the largest scale', () => {
    const words = numberToWords(2_000_000_000_000_000);
    expect(words).not.toContain('undefined');
    expect(words).toContain('Trillion');
  });

  it('still reads ordinary amounts correctly', () => {
    expect(numberToWords(1234)).toBe('One Thousand Two Hundred Thirty Four');
  });
});

describe('period close reports real capital and posts the commission', () => {
  const members = [
    { id: 'm1', bookId: 'b', name: 'A', openingContribution: 100, profitSharePct: 50 },
    { id: 'm2', bookId: 'b', name: 'B', openingContribution: 200, profitSharePct: 50 },
  ];
  const input = { sales: 1000, openingInventory: 200, purchases: 400, closingInventory: 250, commissionPct: 10, expenses: 50, members: members as never };

  function closedBook(openingCapital = 0) {
    const ledger = new V2Ledger(emptyV2Store());
    ledger.createBook(defaultBook('b', 'Shop', 'retail_partnership'), defaultAccounts('b'));
    if (openingCapital > 0) {
      const cash = ledger.store.accounts.find((a) => a.bookId === 'b' && a.code === '1100')!;
      const capital = ledger.store.accounts.find((a) => a.bookId === 'b' && a.code === '3000')!;
      ledger.post({ bookId: 'b', periodId: 'p0', date: '2026-01-01', memo: 'Opening capital', lines: [
        { accountId: cash.id, debit: openingCapital, credit: 0 },
        { accountId: capital.id, debit: 0, credit: openingCapital },
      ] });
    }
    const result = closeBooks(ledger, 'b', 'p1', '2026-03-31', input);
    return { ledger, result };
  }

  it('posts the commission it deducted from profit', () => {
    const { ledger, result } = closedBook();
    expect(result.snapshot.commission).toBe(65);
    const expense = ledger.store.accounts.find((a) => a.bookId === 'b' && a.code === '6100')!;
    const payable = ledger.store.accounts.find((a) => a.bookId === 'b' && a.code === '2200')!;
    // Commission was subtracted from net profit but never entered the ledger.
    expect(ledger.balance('b', expense.id)).toBe(65);
    expect(ledger.balance('b', payable.id)).toBe(-65);
  });

  it('reports closing capital, not net profit', () => {
    // 500,000 of capital plus 535 of profit is 500,535 of closing capital. The
    // field used to carry 535 — the profit — under a "closing capital" label.
    const { ledger, result } = closedBook(500_000);
    const capital = ledger.store.accounts.find((a) => a.bookId === 'b' && a.code === '3000')!;
    expect(result.netProfit).toBe(535);
    expect(result.closingCapital).toBe(500_535);
    expect(result.closingCapital).toBe(-ledger.balance('b', capital.id));
  });

  it('keeps the book balanced', () => {
    const { ledger } = closedBook();
    expect(ledger.reconcile('b').balanced).toBe(true);
  });
});
