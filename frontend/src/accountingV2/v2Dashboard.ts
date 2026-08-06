import type { SqlRunner } from '../db/schema';
import { round2 } from '../money';
import { buildPersistentV2Reports } from './persistentReports';
import { partnershipProfitFromReports } from './reports';
import { V2BookConfigRepository } from './bookConfigRepository';

const cents = round2;

export async function getV2Dashboard(db: SqlRunner, bookId: string) {
  const reports = await buildPersistentV2Reports(db, { bookId });
  const configRepo = new V2BookConfigRepository(db);
  const config = await configRepo.getBookConfig(bookId);

  // Read sources for total sales & purchases (for headline tiles + trend only).
  const salesSources = await db.all<{ metadata: string; date: string }>(
    "SELECT metadata, date FROM v2_sources WHERE book_id=? AND type IN ('cash_sale', 'invoice')",
    [bookId]
  );
  let totalSales = 0;
  const trendMap: Record<string, number> = {};
  for (const row of salesSources) {
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (meta.deleted || meta.reversed) continue;
      const amt = Number(meta.total ?? meta.amount ?? 0);
      totalSales += amt;
      const dateKey = (row.date || '').slice(0, 10);
      trendMap[dateKey] = (trendMap[dateKey] || 0) + amt;
    } catch { /* parse fallback */ }
  }
  totalSales = cents(totalSales);

  const purchaseSources = await db.all<{ metadata: string }>(
    "SELECT metadata FROM v2_sources WHERE book_id=? AND type IN ('cash_purchase', 'credit_purchase')",
    [bookId]
  );
  let totalPurchases = 0;
  for (const row of purchaseSources) {
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (meta.deleted || meta.reversed) continue;
      totalPurchases += Number(meta.total || 0);
    } catch { /* parse fallback */ }
  }
  totalPurchases = cents(totalPurchases);

  // Profit is derived from the journal-authoritative report (COGS included), not the
  // sales−purchases shortcut, so the dashboard agrees with reports and the investor ledger.
  const commPct = config?.retailPartnership?.commissionPct || 0;
  const profit = partnershipProfitFromReports(reports.profitAndLoss, commPct);
  const grossProfit = profit.grossProfit;
  const commission = profit.commission;
  const netProfit = profit.netProfit;

  // Account balances helper
  const getBal = (code: string) => {
    const acc = reports.trialBalance.accounts.find((a) => a.code === code);
    return acc ? acc.normalBalance : 0;
  };

  const cash = cents(getBal('1000') + getBal('1010') + getBal('1020') + getBal('1030'));
  const inventoryValue = cents(getBal('1200'));
  const accountsReceivable = cents(getBal('1100'));
  const supplierAdvances = cents(getBal('1210'));
  const accountsPayable = cents(getBal('2000'));
  const customerAdvances = cents(getBal('2100'));
  const commissionPayable = cents(getBal('2200'));
  const otherAssets = cents(getBal('1500'));
  const otherLiabilities = cents(getBal('2500'));

  const assets = cents(cash + inventoryValue + accountsReceivable + supplierAdvances + otherAssets);
  const liabilities = cents(accountsPayable + customerAdvances + commissionPayable + otherLiabilities);
  const netWorth = cents(assets - liabilities);
  const drawings = cents(getBal('3100'));

  const partiesCountRow = await db.first<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM v2_parties WHERE book_id=? AND archived=0",
    [bookId]
  );
  const suppliers = partiesCountRow?.cnt || 0;

  const period = await db.first<{ start_date: string }>(
    "SELECT start_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1",
    [bookId]
  );
  const periodStart = period?.start_date || new Date().toISOString().slice(0, 10);

  // Real opening figures: balances as of the START of the open period (inclusive of
  // opening-balance entries dated on the start date), not aliases of current balances.
  const opening = await openingBalances(db, bookId, periodStart);

  const salesTrend = Object.entries(trendMap)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-7)
    .map(([date, value]) => ({ date, value: cents(value) }));

  return {
    assets,
    liabilities,
    netWorth,
    cash,
    inventoryValue,
    accountsReceivable, supplierAdvances, accountsPayable, customerAdvances, commissionPayable, otherAssets, otherLiabilities,
    openingBalance: opening.assets,
    openingInventory: opening.inventory,
    openingCash: opening.cash,
    closingBalance: assets,
    totalPurchases,
    totalSales,
    grossProfit,
    managerCommissionPct: commPct,
    commission,
    netProfit,
    drawings,
    supplierPayments: accountsPayable,
    suppliers,
    periodStart,
    salesTrend,
  };
}

/** Sum of account normal balances for the given codes with all postings dated on/before `asOf`. */
async function balancesAsOf(db: SqlRunner, bookId: string, asOf: string, codes: string[]): Promise<number> {
  const placeholders = codes.map(() => '?').join(',');
  const row = await db.first<{ debit: number; credit: number }>(
    `SELECT COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
     FROM v2_accounts a JOIN v2_journal_lines l ON l.account_id=a.id JOIN v2_journal_entries j ON j.id=l.journal_id
     WHERE j.book_id=? AND j.date<=? AND a.code IN (${placeholders})`,
    [bookId, asOf, ...codes],
  );
  // All requested codes here are asset (debit-normal) accounts.
  return round2(Number(row?.debit || 0) - Number(row?.credit || 0));
}

async function openingBalances(db: SqlRunner, bookId: string, periodStart: string) {
  const cash = await balancesAsOf(db, bookId, periodStart, ['1000', '1010', '1020', '1030']);
  const inventory = await balancesAsOf(db, bookId, periodStart, ['1200']);
  const receivable = await balancesAsOf(db, bookId, periodStart, ['1100']);
  const otherAssets = await balancesAsOf(db, bookId, periodStart, ['1500']);
  return { cash, inventory, assets: round2(cash + inventory + receivable + otherAssets) };
}
