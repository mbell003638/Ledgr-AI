import type { SqlRunner } from '../db/schema';
import type { FeatureKey } from '../utils/featureFlags';

export type FeatureDisableBlockers = Partial<Record<FeatureKey, string>>;

const LIVE_SOURCE = "(json_extract(metadata,'$.reversed') IS NULL OR json_extract(metadata,'$.reversed')=0) AND (json_extract(metadata,'$.deleted') IS NULL OR json_extract(metadata,'$.deleted')=0)";

const FEATURE_LABELS: Record<FeatureKey, string> = {
  sales: 'Sales',
  bills: 'Purchases & Vendor Bills',
  receipts: 'Customer Receipts',
  payments: 'Supplier Payments & Capital Withdrawals',
  cashbook: 'Cash Book',
  invoices: 'Invoices & Billing',
  quotes: 'Quotes & Estimates',
  delivery: 'Delivery Notes',
  expenses: 'Business Expenses',
  inventory: 'Inventory & Stock Counts',
  assets: 'Assets & Liabilities',
  daybook: 'Day Book Ledger',
  reports: 'Financial Reports',
  monthly: 'Monthly Summary',
  ask: 'Ask AI Finance Chat',
  voice: 'Voice AI Assistant',
  payroll: 'Payroll',
  perpetualInventory: 'Live Product Stock',
  locations: 'Locations / Shops',
};

export async function getV2FeatureDisableBlockers(db: SqlRunner, bookId: string): Promise<FeatureDisableBlockers> {
  const blockers: FeatureDisableBlockers = {};
  const sourceRows = await db.all<{ type: string; n: number }>(
    `SELECT type,COUNT(*) AS n FROM v2_sources WHERE book_id=? AND ${LIVE_SOURCE} GROUP BY type`,
    [bookId],
  );
  const sourceCounts = new Map(sourceRows.map((row) => [row.type, Number(row.n || 0)]));
  const sourceCount = (...types: string[]) => types.reduce((sum, type) => sum + (sourceCounts.get(type) || 0), 0);
  const block = (key: FeatureKey, detail: string) => {
    blockers[key] = `Cannot disable ${FEATURE_LABELS[key]} because this book still has ${detail}. Delete or reverse those entries first, then try again.`;
  };

  if (sourceCount('cash_sale')) block('sales', 'sales entries');
  if (sourceCount('cash_purchase', 'credit_purchase')) block('bills', 'purchase or vendor-bill entries');
  if (sourceCount('receipt')) block('receipts', 'customer receipt entries');
  if (sourceCount('supplier_payment', 'drawing', 'commission_payment')) block('payments', 'payment or capital withdrawal entries');
  if (sourceCount('manual_cash_income', 'manual_cash_expense')) block('cashbook', 'manual cash-book entries');
  if (sourceCount('invoice')) block('invoices', 'invoice entries');
  if (sourceCount('expense', 'payable_expense')) block('expenses', 'expense entries');
  if (sourceCount('opening_balance', 'manual_asset', 'manual_liability', 'capital_injection')) block('assets', 'opening balance, asset, liability, or capital entries');

  const [inventoryCounts, closeSnapshots, inventoryLedgerActivity, productActivity, payrollData, locationActivity] = await Promise.all([
    db.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_inventory_counts WHERE book_id=?', [bookId]),
    db.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_close_books WHERE book_id=?', [bookId]),
    db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM v2_journal_lines l
       JOIN v2_accounts a ON a.id=l.account_id
       JOIN v2_journal_entries j ON j.id=l.journal_id
       LEFT JOIN v2_sources s ON s.id=j.source_id
       WHERE j.book_id=? AND a.code='1200'
         AND (s.id IS NULL OR (${LIVE_SOURCE.replace(/metadata/g, 's.metadata')}))`,
      [bookId],
    ),
    db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM v2_stock_moves m LEFT JOIN v2_sources s ON s.id=m.source_id
       WHERE m.book_id=? AND (s.id IS NULL OR (${LIVE_SOURCE.replace(/metadata/g, 's.metadata')}))`,
      [bookId],
    ),
    db.first<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM v2_employees WHERE book_id=? AND archived=0)
        + (SELECT COUNT(*) FROM v2_pay_runs WHERE book_id=?) AS n`,
      [bookId, bookId],
    ),
    db.first<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM v2_sources WHERE book_id=?
                 AND (location_id IS NOT NULL OR type IN ('location_cash_transfer','location_stock_transfer'))
                 AND ${LIVE_SOURCE})
        + (SELECT COUNT(*) FROM v2_inventory_counts WHERE book_id=? AND location_id IS NOT NULL)
        + (SELECT COUNT(*) FROM v2_journal_lines l
             JOIN v2_journal_entries j ON j.id=l.journal_id
             LEFT JOIN v2_sources s ON s.id=j.source_id
             WHERE j.book_id=? AND l.location_id IS NOT NULL
               AND (s.id IS NULL OR (${LIVE_SOURCE.replace(/metadata/g, 's.metadata')})))
        + (SELECT COUNT(*) FROM v2_stock_moves m
             LEFT JOIN v2_sources s ON s.id=m.source_id
             WHERE m.book_id=? AND m.location_id IS NOT NULL
               AND (s.id IS NULL OR (${LIVE_SOURCE.replace(/metadata/g, 's.metadata')}))) AS n`,
      [bookId, bookId, bookId, bookId],
    ),
  ]);

  if (Number(inventoryCounts?.n || 0) + Number(closeSnapshots?.n || 0) + Number(inventoryLedgerActivity?.n || 0) > 0) {
    block('inventory', 'inventory ledger activity, physical stock counts, or closed inventory periods');
  }
  if (Number(productActivity?.n || 0) > 0) block('perpetualInventory', 'live product stock movements');
  if (Number(payrollData?.n || 0) > 0) block('payroll', 'employees or payroll runs');
  if (Number(locationActivity?.n || 0) > 0) block('locations', 'location-tagged ledger entries');

  return blockers;
}

export async function assertFeatureDisableAllowed(
  db: SqlRunner,
  bookId: string,
  previous: readonly FeatureKey[],
  next: readonly FeatureKey[],
): Promise<void> {
  const nextSet = new Set(next);
  const removed = previous.filter((key) => !nextSet.has(key));
  if (!removed.length) return;
  const blockers = await getV2FeatureDisableBlockers(db, bookId);
  const blocked = removed.find((key) => blockers[key]);
  if (blocked) throw new Error(blockers[blocked]);
}
