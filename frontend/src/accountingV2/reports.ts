import type { V2MemoryStore } from './schema';
import type { V2Account, V2AccountType, V2JournalEntry } from './types';
import { round2 } from '../money';

const cents = round2;
const TOLERANCE = 0.005;

export type V2ReportOptions = {
  bookId: string;
  /** Inclusive ISO date boundary. */
  from?: string;
  /** Inclusive ISO date boundary. */
  to?: string;
  /**
   * Open-period periodic COGS to reflect in reports before it is posted to the GL
   * (see cogs.ts). Injected as a synthetic, non-persisted Dr COGS / Cr Inventory so
   * trial balance, P&L, and balance sheet all stay internally consistent and gross/
   * net profit include cost of sales for the still-open period. Callers must NOT pass
   * this for ranges whose COGS is already posted (closed periods) to avoid double count.
   */
  cogsAdjustment?: { cogsAccountId: string; inventoryAccountId: string; amount: number };
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
    /** Total expenses INCLUDING cost of goods sold. */
    expenses: number;
    /** Periodic cost of goods sold (5000 account balance, incl. any open-period estimate). */
    cogs: number;
    /** revenue − cogs. */
    grossProfit: number;
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
 * Cash-basis P&L (M3): recognizes revenue and expenses only when cash actually moves.
 *   revenue  = cash sales + amounts received against invoices (receipt→invoice allocations)
 *   expenses = cash-paid operating expenses + payments made to suppliers
 * COGS is still periodic (computed elsewhere and shown for reference), so it is NOT added
 * into the cash-basis expense total to avoid double-counting supplier payments. An unpaid
 * invoice therefore contributes to accrual revenue but never to cash revenue until received.
 * Note: the trial balance and balance sheet remain accrual/journal-derived; only the P&L
 * revenue/expense recognition changes with basis.
 */
function cashBasisProfitAndLoss(store: V2MemoryStore, options: V2ReportOptions) {
  const inRange = (date: string) => (!options.from || date >= options.from) && (!options.to || date <= options.to);
  const live = store.sources.filter((s) => s.bookId === options.bookId && !(s.metadata as any)?.deleted && !(s.metadata as any)?.reversed);
  const sourceById = new Map(store.sources.map((s) => [s.id, s]));
  const metaTotal = (id: string) => cents(Number((sourceById.get(id)?.metadata as any)?.total || 0));

  // Revenue: cash sales in range + receipts allocated to invoices, recognized on the receipt date.
  const cashSales = live.filter((s) => s.type === 'cash_sale' && inRange(s.date)).reduce((sum, s) => cents(sum + Number((s.metadata as any)?.total || 0)), 0);
  const received = store.allocations
    .filter((a) => a.bookId === options.bookId)
    .filter((a) => { const receipt = sourceById.get(a.receiptSourceId); const date = receipt?.date || a.allocatedAt; return receipt && !(receipt.metadata as any)?.deleted && !(receipt.metadata as any)?.reversed && inRange(date); })
    .reduce((sum, a) => cents(sum + Number(a.amount)), 0);
  const revenue = cents(cashSales + received);

  // Expenses: cash-paid operating expenses + cash paid to suppliers, both on their own date.
  const cashExpenses = live.filter((s) => s.type === 'expense' && inRange(s.date)).reduce((sum, s) => cents(sum + metaTotal(s.id)), 0);
  const supplierPayments = live.filter((s) => s.type === 'supplier_payment' && inRange(s.date)).reduce((sum, s) => cents(sum + metaTotal(s.id)), 0);
  const cashPurchases = live.filter((s) => s.type === 'cash_purchase' && inRange(s.date)).reduce((sum, s) => cents(sum + metaTotal(s.id)), 0);
  const expenses = cents(cashExpenses + supplierPayments + cashPurchases);

  return { revenue, expenses };
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

  // Inject the open-period periodic COGS estimate (Dr COGS / Cr Inventory) so profit
  // reflects cost of sales before the close posts it. Non-persisted; keeps books balanced.
  const cogsAdj = options.cogsAdjustment;
  if (cogsAdj && Number.isFinite(cogsAdj.amount) && cogsAdj.amount > 0) {
    const amount = cents(cogsAdj.amount);
    const cogsTotal = totalsById.get(cogsAdj.cogsAccountId);
    const inventoryTotal = totalsById.get(cogsAdj.inventoryAccountId);
    if (cogsTotal && inventoryTotal && accountsById.has(cogsAdj.cogsAccountId) && accountsById.has(cogsAdj.inventoryAccountId)) {
      cogsTotal.debit += amount;
      inventoryTotal.credit += amount;
      totalDebit += amount;
      totalCredit += amount;
      const cogsAccount = accountsById.get(cogsAdj.cogsAccountId)!;
      const inventoryAccount = accountsById.get(cogsAdj.inventoryAccountId)!;
      const date = options.to || '';
      details.push({ journalId: 'periodic-cogs', sourceId: undefined, date, memo: 'Periodic cost of goods sold (estimate)', accountId: cogsAccount.id, accountCode: cogsAccount.code, accountName: cogsAccount.name, accountType: cogsAccount.type, debit: amount, credit: 0 });
      details.push({ journalId: 'periodic-cogs', sourceId: undefined, date, memo: 'Periodic cost of goods sold (estimate)', accountId: inventoryAccount.id, accountCode: inventoryAccount.code, accountName: inventoryAccount.name, accountType: inventoryAccount.type, debit: 0, credit: amount });
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
  const cogs = cents(accountTotals
    .filter((account) => account.code === '5000')
    .reduce((sum, account) => sum + account.normalBalance, 0));

  // Accrual (default) P&L is derived straight from the journal-authoritative account
  // balances. Cash basis (M3) recognizes revenue/expenses only when money moves.
  const book = store.books.find((b) => b.id === options.bookId);
  const cashBasis = book?.basis === 'cash';
  const accrualRevenue = sumType('revenue');
  const accrualExpenses = sumType('expense');
  // The balance sheet ALWAYS uses accrual current earnings so the accounting identity
  // (assets = liabilities + equity + earnings) holds regardless of the P&L basis.
  const accrualNetProfit = cents(accrualRevenue - accrualExpenses);
  let revenue = accrualRevenue;
  let expenses = accrualExpenses;
  if (cashBasis) {
    const cash = cashBasisProfitAndLoss(store, options);
    revenue = cash.revenue;
    expenses = cash.expenses;
  }
  const grossProfit = cents(revenue - cogs);
  const netProfit = cents(revenue - expenses);
  const assets = sumType('asset');
  const liabilities = sumType('liability');
  const equity = sumType('equity');
  const liabilitiesAndEquity = cents(liabilities + equity + accrualNetProfit);
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
    profitAndLoss: { revenue, expenses, cogs, grossProfit, netProfit },
    balanceSheet: {
      assets,
      liabilities,
      equity,
      currentEarnings: accrualNetProfit,
      liabilitiesAndEquity,
      difference: balanceSheetDifference,
      balanced: Math.abs(balanceSheetDifference) <= TOLERANCE,
    },
    reconciliation: { ok: errors.length === 0, errors },
  };
}

export type V2PartnershipProfit = { revenue: number; cogs: number; grossProfit: number; commission: number; expenses: number; netProfit: number };

/**
 * The single derivation of partnership profit for the OPEN period, shared by the
 * dashboard and the investor ledger so every profit surface agrees. Takes a
 * journal-derived report (COGS already reflected) plus the commission rate and
 * applies the manager commission consistently. Commission is an open-period accrual
 * estimate (it is only posted to the GL at close), so it is subtracted here rather
 * than read from the ledger.
 */
export function partnershipProfitFromReports(pnl: V2Reports['profitAndLoss'], commissionPct: number): V2PartnershipProfit {
  const grossProfit = cents(pnl.grossProfit);
  const pct = Number.isFinite(commissionPct) ? commissionPct : 0;
  const commission = grossProfit > 0 ? cents(grossProfit * pct / 100) : 0;
  const netProfit = cents(pnl.netProfit - commission);
  return { revenue: cents(pnl.revenue), cogs: cents(pnl.cogs), grossProfit, commission, expenses: cents(pnl.expenses), netProfit };
}
