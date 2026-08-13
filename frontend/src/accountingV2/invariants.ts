import { toCents, num } from '../money';

export class InvariantError extends Error {
  constructor(public invariantName: string, message: string) {
    super(`[INVARIANT_VIOLATION:${invariantName}] ${message}`);
    this.name = 'InvariantError';
  }
}

export type JournalLineInput = {
  accountCode: string;
  debitCents: number;
  creditCents: number;
  memo?: string;
};

export type InvariantCheck = {
  name: string;
  description: string;
  check: (lines: JournalLineInput[]) => void | Promise<void>;
};

/**
 * INV-01: BALANCED_JOURNAL
 * Total debits must strictly equal total credits.
 */
export const balancedJournalInvariant: InvariantCheck = {
  name: 'BALANCED_JOURNAL',
  description: 'Sum of line debits must equal sum of line credits.',
  check: (lines: JournalLineInput[]) => {
    let totalDebit = 0;
    let totalCredit = 0;
    for (const line of lines) {
      totalDebit += toCents(line.debitCents || 0);
      totalCredit += toCents(line.creditCents || 0);
    }
    if (totalDebit !== totalCredit) {
      throw new InvariantError(
        'BALANCED_JOURNAL',
        `Journal entry is out of balance. Debits: ${totalDebit} cents, Credits: ${totalCredit} cents (Diff: ${totalDebit - totalCredit}).`
      );
    }
  },
};

/**
 * INV-02: MINIMUM_LINES
 * Every posting must have at least 2 lines for double-entry integrity.
 */
export const minimumLinesInvariant: InvariantCheck = {
  name: 'MINIMUM_LINES',
  description: 'Journal entry must contain at least 2 lines.',
  check: (lines: JournalLineInput[]) => {
    if (!lines || lines.length < 2) {
      throw new InvariantError('MINIMUM_LINES', `Journal entry must have at least 2 lines, got ${lines?.length || 0}.`);
    }
  },
};

/**
 * INV-03: NON_NEGATIVE_AMOUNTS
 * Line amounts must be non-negative integers.
 */
export const nonNegativeAmountsInvariant: InvariantCheck = {
  name: 'NON_NEGATIVE_AMOUNTS',
  description: 'Line debit and credit amounts must be non-negative.',
  check: (lines: JournalLineInput[]) => {
    for (const line of lines) {
      if ((line.debitCents || 0) < 0 || (line.creditCents || 0) < 0) {
        throw new InvariantError(
          'NON_NEGATIVE_AMOUNTS',
          `Negative line amounts detected (debit: ${line.debitCents}, credit: ${line.creditCents}).`
        );
      }
    }
  },
};

export const CORE_INVARIANTS: InvariantCheck[] = [
  minimumLinesInvariant,
  balancedJournalInvariant,
  nonNegativeAmountsInvariant,
];

/**
 * Runs all core invariants on candidate posting lines before database write.
 * Throws InvariantError on any invariant breach.
 */
export async function validatePostingInvariants(lines: JournalLineInput[], extraChecks: InvariantCheck[] = []): Promise<void> {
  const allChecks = [...CORE_INVARIANTS, ...extraChecks];
  for (const check of allChecks) {
    await check.check(lines);
  }
}
