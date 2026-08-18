import { toCents, round2, num } from '../money';

export class InvariantError extends Error {
  constructor(public invariantName: string, message: string) {
    super(`[INVARIANT_VIOLATION:${invariantName}] ${message}`);
    this.name = 'InvariantError';
  }
}

export type JournalLineInput = {
  accountCode?: string;
  accountId?: string;
  debit?: number;
  credit?: number;
  debitCents?: number;
  creditCents?: number;
  memo?: string;
};

export type InvariantCheck = {
  name: string;
  description: string;
  check: (lines: JournalLineInput[]) => void | Promise<void>;
};

function getCents(value: number | undefined, centsValue: number | undefined): number {
  if (centsValue !== undefined && Number.isFinite(centsValue)) {
    return Math.round(centsValue);
  }
  return toCents(round2(num(value)));
}

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
      const d = getCents(line.debit, line.debitCents);
      const c = getCents(line.credit, line.creditCents);
      totalDebit += d;
      totalCredit += c;
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
 * INV-03: FINITE_AMOUNTS
 * Supplied monetary values must be finite before any rounding/coercion. The
 * shared money helpers deliberately coerce non-finite values to zero for
 * display arithmetic; a posting boundary must reject them instead.
 */
export const finiteAmountsInvariant: InvariantCheck = {
  name: 'FINITE_AMOUNTS',
  description: 'Supplied debit and credit amounts must be finite numbers.',
  check: (lines: JournalLineInput[]) => {
    for (const line of lines) {
      for (const [field, value] of [
        ['debit', line.debit],
        ['credit', line.credit],
        ['debitCents', line.debitCents],
        ['creditCents', line.creditCents],
      ] as const) {
        if (value !== undefined && !Number.isFinite(value)) {
          throw new InvariantError('FINITE_AMOUNTS', `${field} must be a finite number.`);
        }
      }
    }
  },
};

/**
 * INV-04: NON_NEGATIVE_AMOUNTS
 * Line amounts must be non-negative integers/decimals.
 */
export const nonNegativeAmountsInvariant: InvariantCheck = {
  name: 'NON_NEGATIVE_AMOUNTS',
  description: 'Line debit and credit amounts must be non-negative.',
  check: (lines: JournalLineInput[]) => {
    for (const line of lines) {
      const d = getCents(line.debit, line.debitCents);
      const c = getCents(line.credit, line.creditCents);
      if (d < 0 || c < 0) {
        throw new InvariantError(
          'NON_NEGATIVE_AMOUNTS',
          `Negative line amounts detected (debit: ${d}, credit: ${c}).`
        );
      }
      if (d > 0 && c > 0) {
        throw new InvariantError(
          'INVALID_LINE_MUTUAL_EXCLUSION',
          `Line cannot have both debit and credit amounts (debit: ${d}, credit: ${c}).`
        );
      }
      if (d === 0 && c === 0) {
        throw new InvariantError(
          'ZERO_LINE_AMOUNT',
          'Line cannot have zero debit and zero credit.'
        );
      }
    }
  },
};

export const CORE_INVARIANTS: InvariantCheck[] = [
  minimumLinesInvariant,
  finiteAmountsInvariant,
  balancedJournalInvariant,
  nonNegativeAmountsInvariant,
];

/**
 * Runs all core invariants on candidate posting lines before database write.
 * Throws InvariantError on any invariant breach.
 */
export function validatePostingInvariants(lines: JournalLineInput[], extraChecks: InvariantCheck[] = []): void {
  const allChecks = [...CORE_INVARIANTS, ...extraChecks];
  for (const check of allChecks) {
    check.check(lines);
  }
}
