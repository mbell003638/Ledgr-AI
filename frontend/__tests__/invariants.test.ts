import {
  balancedJournalInvariant,
  minimumLinesInvariant,
  nonNegativeAmountsInvariant,
  validatePostingInvariants,
  InvariantError,
} from '../src/accountingV2/invariants';

describe('accountingV2 Invariant Engine', () => {
  it('passes balanced double-entry postings', async () => {
    const lines = [
      { accountCode: '1000', debitCents: 5000, creditCents: 0 },
      { accountCode: '4000', debitCents: 0, creditCents: 5000 },
    ];
    await expect(validatePostingInvariants(lines)).resolves.not.toThrow();
  });

  it('rejects unbalanced journal entries (INV-01)', async () => {
    const lines = [
      { accountCode: '1000', debitCents: 5000, creditCents: 0 },
      { accountCode: '4000', debitCents: 0, creditCents: 4000 },
    ];
    await expect(validatePostingInvariants(lines)).rejects.toThrow(InvariantError);
    await expect(validatePostingInvariants(lines)).rejects.toThrow('BALANCED_JOURNAL');
  });

  it('rejects journal entries with fewer than 2 lines (INV-02)', async () => {
    const lines = [{ accountCode: '1000', debitCents: 5000, creditCents: 0 }];
    await expect(validatePostingInvariants(lines)).rejects.toThrow(InvariantError);
    await expect(validatePostingInvariants(lines)).rejects.toThrow('MINIMUM_LINES');
  });

  it('rejects negative line amounts (INV-03)', async () => {
    const lines = [
      { accountCode: '1000', debitCents: -5000, creditCents: 0 },
      { accountCode: '4000', debitCents: 0, creditCents: -5000 },
    ];
    await expect(validatePostingInvariants(lines)).rejects.toThrow(InvariantError);
    await expect(validatePostingInvariants(lines)).rejects.toThrow('NON_NEGATIVE_AMOUNTS');
  });
});
