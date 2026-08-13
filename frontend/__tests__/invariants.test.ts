import {
  balancedJournalInvariant,
  minimumLinesInvariant,
  nonNegativeAmountsInvariant,
  validatePostingInvariants,
  InvariantError,
} from '../src/accountingV2/invariants';

describe('accountingV2 Invariant Engine', () => {
  it('passes balanced double-entry postings', () => {
    const lines = [
      { accountCode: '1000', debitCents: 5000, creditCents: 0 },
      { accountCode: '4000', debitCents: 0, creditCents: 5000 },
    ];
    expect(() => validatePostingInvariants(lines)).not.toThrow();
  });

  it('rejects unbalanced journal entries (INV-01)', () => {
    const lines = [
      { accountCode: '1000', debitCents: 5000, creditCents: 0 },
      { accountCode: '4000', debitCents: 0, creditCents: 4000 },
    ];
    expect(() => validatePostingInvariants(lines)).toThrow(InvariantError);
    expect(() => validatePostingInvariants(lines)).toThrow('BALANCED_JOURNAL');
  });

  it('rejects journal entries with fewer than 2 lines (INV-02)', () => {
    const lines = [{ accountCode: '1000', debitCents: 5000, creditCents: 0 }];
    expect(() => validatePostingInvariants(lines)).toThrow(InvariantError);
    expect(() => validatePostingInvariants(lines)).toThrow('MINIMUM_LINES');
  });

  it('rejects negative line amounts (INV-03)', () => {
    const lines = [
      { accountCode: '1000', debitCents: -5000, creditCents: 0 },
      { accountCode: '4000', debitCents: 0, creditCents: -5000 },
    ];
    expect(() => validatePostingInvariants(lines)).toThrow(InvariantError);
    expect(() => validatePostingInvariants(lines)).toThrow('NON_NEGATIVE_AMOUNTS');
  });
});
