import type { V2MemoryStore } from './schema';
import type { V2Account, V2AccountType, V2JournalEntry } from './types';

const cents = (value: number) => Math.round(value * 100) / 100;
const TOLERANCE = 0.005;

export type V2ReportOptions = {
  bookId: string;
  /** Inclusive ISO date boundary. */
  from?: string;
  /** Inclusive ISO date boundary. */
  to?: string;
};

export type V2AccountTotal = Pick<V2Account, 'id' | 'bookId' | 'code' | 'name' | 'type'> & {
  debit: number;
  credit: number;
  /** Debit-positive balance; use normalBalance for presentation by account type. */
  balance: number;
  normalBalance: number;
};

export type V2ReportDetail = {
  journalId: string; sourceId?: string; date: string; memo: string;
  accountId: string; accountCode: string; accountName: string; accountType: V2AccountType;
  partyId?: string; debit: number; credit: number;
};

export type V2ReconciliationError = {
  code:
    | 'JOURNAL_UNBALANCED'
    | 'TRIAL_BALANCE_OUT_OF_BALANCE'
    | 'BALANCE_SHEET_OUT_OF_BALANCE'
    | 'UNKNOWN_ACCOUNT'
    | 'INVALID_POSTING_AMOUNT';
  message: string;
  difference?: number;
  journalId?: string;
  accountId?: string;
};

export type V2Reports = {
  bookId: string;
  from?: string;
  to?: string;
  journalCount: number;
  /** Journal-line detail, already restricted to the requested date range. */
  details: V2ReportDetail[];
  trialBalance: {
    accounts: V2AccountTotal[];
    totals: { debit: number; credit: number; difference: number };
    balanced: boolean;
  };
  profitAndLoss: {
    revenue: number;
    expenses: number;
    netProfit: number;
  };
  balanceSheet: {
    assets: number;
    liabilities: number;
    equity: number;
    currentEarnings: number;
    liabilitiesAndEquity: number;
    difference: number;
    balanced: boolean;
  };
  reconciliation: {
    ok: boolean;
    errors: V2ReconciliationError[];
  };
};

export class V2ReportError extends Error {
  constructor(public readonly code: 'BOOK_NOT_FOUND' | 'INVALID_DATE_RANGE', message: string) {
    super(message);
    this.name = 'V2ReportError';
  }
}

function isInRange(entry: V2JournalEntry, options: V2ReportOptions): boolean {
  return (!options.from || entry.date >= options.from) && (!options.to || entry.date <= options.to);
}

function normalBalance(type: V2AccountType, debit: number, credit: number): number {
  return type === 'asset' || type === 'expense' ? cents(debit - credit) : cents(credit - debit);
}

/**
 * Produces all core financial reports from journal lines. No source-document
 * totals or cached balances participate, so reconciliation has one authority.
 */
export function buildV2Reports(store: V2MemoryStore, options: V2ReportOptions): V2Reports {
  if (options.from && options.to && options.from > options.to) {
    throw new V2ReportError('INVALID_DATE_RANGE', '`from` must be on or before `to`');
  }
  if (!store.books.some((book) => book.id === options.bookId)) {
    throw new V2ReportError('BOOK_NOT_FOUND', `Book not found: ${options.bookId}`);
  }

  const accounts = store.accounts.filter((account) => account.bookId === options.bookId);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const totalsById = new Map(accounts.map((account) => [account.id, { debit: 0, credit: 0 }]));
  const journals = store.journals.filter(
    (entry) => entry.bookId === options.bookId && isInRange(entry, options),
  );
  const errors: V2ReconciliationError[] = [];
  const details: V2ReportDetail[] = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const journal of journals) {
    let journalDebit = 0;
    let journalCredit = 0;
    for (const line of journal.lines) {
      if (!Number.isFinite(line.debit) || !Number.isFinite(line.credit) || line.debit < 0 || line.credit < 0) {
        errors.push({
          code: 'INVALID_POSTING_AMOUNT',
          message: `Journal ${journal.id} contains a non-finite or negative posting`,
          journalId: journal.id,
          accountId: line.accountId,
        });
        continue;
      }
      const debit = cents(line.debit);
      const credit = cents(line.credit);
      journalDebit += debit;
      journalCredit += credit;
      totalDebit += debit;
      totalCredit += credit;
      const accountTotal = totalsById.get(line.accountId);
      if (!accountTotal || !accountsById.has(line.accountId)) {
        errors.push({
          code: 'UNKNOWN_ACCOUNT',
          message: `Journal ${journal.id} posts to an account outside book ${options.bookId}`,
          journalId: journal.id,
          accountId: line.accountId,
        });
      } else {
        accountTotal.debit += debit;
        accountTotal.credit += credit;
        const account = accountsById.get(line.accountId)!;
        details.push({ journalId: journal.id, sourceId: journal.sourceId, date: journal.date,
          memo: line.memo || journal.memo, accountId: account.id, accountCode: account.code,
          accountName: account.name, accountType: account.type, partyId: line.partyId, debit, credit });
      }
    }
    const difference = cents(journalDebit - journalCredit);
    if (Math.abs(difference) > TOLERANCE) {
      errors.push({
        code: 'JOURNAL_UNBALANCED',
        message: `Journal ${journal.id} debits and credits differ`,
        journalId: journal.id,
        difference,
      });
    }
  }

  const accountTotals: V2AccountTotal[] = accounts.map((account) => {
    const raw = totalsById.get(account.id)!;
    const debit = cents(raw.debit);
    const credit = cents(raw.credit);
    return {
      id: account.id,
      bookId: account.bookId,
      code: account.code,
      name: account.name,
      type: account.type,
      debit,
      credit,
      balance: cents(debit - credit),
      normalBalance: normalBalance(account.type, debit, credit),
    };
  });

  totalDebit = cents(totalDebit);
  totalCredit = cents(totalCredit);
  const trialDifference = cents(totalDebit - totalCredit);
  if (Math.abs(trialDifference) > TOLERANCE) {
    errors.push({
      code: 'TRIAL_BALANCE_OUT_OF_BALANCE',
      message: 'Trial balance debits and credits differ',
      difference: trialDifference,
    });
  }

  const sumType = (type: V2AccountType) => cents(accountTotals
    .filter((account) => account.type === type)
    .reduce((sum, account) => sum + account.normalBalance, 0));
  const revenue = sumType('revenue');
  const expenses = sumType('expense');
  const netProfit = cents(revenue - expenses);
  const assets = sumType('asset');
  const liabilities = sumType('liability');
  const equity = sumType('equity');
  const liabilitiesAndEquity = cents(liabilities + equity + netProfit);
  const balanceSheetDifference = cents(assets - liabilitiesAndEquity);
  if (Math.abs(balanceSheetDifference) > TOLERANCE) {
    errors.push({
      code: 'BALANCE_SHEET_OUT_OF_BALANCE',
      message: 'Assets do not equal liabilities, equity, and current earnings',
      difference: balanceSheetDifference,
    });
  }

  return {
    bookId: options.bookId,
    from: options.from,
    to: options.to,
    journalCount: journals.length,
    details,
    trialBalance: {
      accounts: accountTotals,
      totals: { debit: totalDebit, credit: totalCredit, difference: trialDifference },
      balanced: Math.abs(trialDifference) <= TOLERANCE,
    },
    profitAndLoss: { revenue, expenses, netProfit },
    balanceSheet: {
      assets,
      liabilities,
      equity,
      currentEarnings: netProfit,
      liabilitiesAndEquity,
      difference: balanceSheetDifference,
      balanced: Math.abs(balanceSheetDifference) <= TOLERANCE,
    },
    reconciliation: { ok: errors.length === 0, errors },
  };
}
