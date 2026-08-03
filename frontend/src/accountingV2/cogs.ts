import type { SqlRunner } from '../db/schema';
import { round2 } from '../money';
import { V2_ACCOUNT_CODES } from './types';

/**
 * PERIODIC cost-of-goods-sold — the single source of truth for COGS everywhere.
 *
 * Ledgr has no per-item costing (inventory is tracked as a dollar value via
 * periodic physical counts in v2_inventory_counts), so COGS is derived, not
 * accumulated per sale:
 *
 *     COGS = openingInventory + purchasesInPeriod − closingInventory
 *
 * where
 *   - openingInventory   = the Inventory (1200) value carried into the period
 *                          (physical count dated on the period start, else the
 *                          Inventory GL balance for all postings before start),
 *   - purchasesInPeriod  = net debit movement on Inventory (1200) within the
 *                          period (only purchases hit 1200 until COGS is posted),
 *   - closingInventory   = the latest physical count dated within/at period end.
 *
 * LIMITATION: if NO physical count exists within the period, closing inventory
 * is unknown and COGS is reported as 0 (see hasClosingCount below). Callers must
 * not treat a 0 here as "no cost of sales" without checking hasClosingCount.
 *
 * This module is imported by closeBooksRepository (to POST the real periodic COGS
 * adjustment at close), by reports (to inject an open-period COGS estimate into
 * the P&L), and transitively by the dashboard and investor ledger so all four
 * profit surfaces agree.
 */

export type PeriodicCogsInputs = {
  openingInventory: number;
  purchases: number;
  closingInventory: number;
};

export type PeriodicCogsResult = PeriodicCogsInputs & {
  cogs: number;
  /** False when no physical count fell within the period, so COGS is forced to 0. */
  hasClosingCount: boolean;
};

/** Pure periodic-COGS arithmetic. The one place the formula lives. */
export function periodicCogs(inputs: PeriodicCogsInputs): number {
  return round2(round2(inputs.openingInventory) + round2(inputs.purchases) - round2(inputs.closingInventory));
}

type AccountMovementRow = { debit: number; credit: number };

async function inventoryMovement(db: SqlRunner, bookId: string, condition: string, params: unknown[]): Promise<number> {
  const row = await db.first<AccountMovementRow>(
    `SELECT COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
     FROM v2_accounts a
     JOIN v2_journal_lines l ON l.account_id = a.id
     JOIN v2_journal_entries j ON j.id = l.journal_id
     WHERE j.book_id = ? AND a.code = ? AND ${condition}`,
    [bookId, V2_ACCOUNT_CODES.INVENTORY, ...params],
  );
  return round2(Number(row?.debit || 0) - Number(row?.credit || 0));
}

/**
 * Resolve periodic COGS for [start, end] straight from the authoritative journal
 * lines and physical counts. Used by both the live report path and period close.
 */
export async function computePeriodicCogs(
  db: SqlRunner,
  bookId: string,
  bounds: { start: string; end: string },
): Promise<PeriodicCogsResult> {
  const { start, end } = bounds;

  // Opening inventory: prefer a physical count dated exactly on the period start;
  // otherwise fall back to the Inventory GL balance of everything before the start.
  const startCount = await db.first<{ value: number }>(
    'SELECT value FROM v2_inventory_counts WHERE book_id = ? AND date = ? ORDER BY id DESC LIMIT 1',
    [bookId, start],
  );
  const openingInventory = startCount
    ? round2(Number(startCount.value))
    : await inventoryMovement(db, bookId, 'j.date < ?', [start]);

  // Purchases: net Inventory debit movement inside the period.
  const purchases = Math.max(0, await inventoryMovement(db, bookId, 'j.date >= ? AND j.date <= ?', [start, end]));

  // Closing inventory: latest physical count within/at the period end.
  const closingCount = await db.first<{ value: number }>(
    'SELECT value FROM v2_inventory_counts WHERE book_id = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1',
    [bookId, start, end],
  );
  const hasClosingCount = Boolean(closingCount);
  const closingInventory = closingCount ? round2(Number(closingCount.value)) : 0;

  // Without a closing count there is no basis for periodic COGS yet — report 0.
  const cogs = hasClosingCount ? periodicCogs({ openingInventory, purchases, closingInventory }) : 0;
  return { openingInventory, purchases, closingInventory, cogs, hasClosingCount };
}
