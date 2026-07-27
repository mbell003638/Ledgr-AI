import type { SqlRunner } from '../db/schema';
import { buildPersistentV2Reports } from './persistentReports';
import { V2BookConfigRepository } from './bookConfigRepository';

const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export async function getV2Dashboard(db: SqlRunner, bookId: string) {
  const reports = await buildPersistentV2Reports(db, { bookId });
  const configRepo = new V2BookConfigRepository(db);
  const config = await configRepo.getBookConfig(bookId);

  // Read sources for total sales & purchases
  const salesSources = await db.all<{ metadata: string; date: string }>(
    "SELECT metadata, date FROM v2_sources WHERE book_id=? AND type IN ('cash_sale', 'invoice')",
    [bookId]
  );
  let totalSales = 0;
  const trendMap: Record<string, number> = {};
  for (const row of salesSources) {
    try {
      const meta = JSON.parse(row.metadata || '{}');
      if (meta.deleted) continue;
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
      if (meta.deleted) continue;
      totalPurchases += Number(meta.total || 0);
    } catch { /* parse fallback */ }
  }
  totalPurchases = cents(totalPurchases);

  const grossProfit = cents(totalSales - totalPurchases);
  const commPct = config?.retailPartnership?.commissionPct || 0;
  const commission = grossProfit > 0 ? cents(grossProfit * commPct / 100) : 0;
  const netProfit = cents(reports.profitAndLoss.netProfit - commission);

  // Account balances helper
  const getBal = (code: string) => {
    const acc = reports.trialBalance.accounts.find((a) => a.code === code);
    return acc ? acc.normalBalance : 0;
  };

  const cash = cents(getBal('1000') + getBal('1010') + getBal('1020') + getBal('1030'));
  const inventoryValue = cents(getBal('1200'));
  const accountsReceivable = cents(getBal('1100'));
  const accountsPayable = cents(getBal('2000'));
  const commissionPayable = cents(getBal('2200'));

  const assets = cents(cash + inventoryValue + accountsReceivable);
  const liabilities = cents(accountsPayable + commissionPayable);
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
    accountsReceivable,
    openingBalance: assets,
    openingInventory: inventoryValue,
    openingCash: cash,
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
