/**
 * Pure accounting math — no AsyncStorage, no I/O, fully unit-testable.
 *
 * These functions mirror the calculations embedded in src/db/local.ts
 * (dashboard, pnlRange, capitalStatement). Keeping the math here as pure
 * functions lets us test the accounting engine in isolation and gives the
 * data layer a single source of truth for the formulas.
 *
 * Locked accounting model:
 *   COGS         = opening stock + purchases - closing stock   (periodic inventory)
 *   GrossProfit  = Sales - COGS
 *   Commission   = GrossProfit * commission%   (only when GrossProfit > 0)
 *   NetProfit    = GrossProfit - Commission - Expenses - Drawings
 *   PartnerShare = NetProfit / partners
 *   Capital      = OpeningCapital + NetProfit - Drawings
 */

import { num as moneyNum, round2 as m2, sumMoney, addMoney, subMoney, pctOf } from './money';

/** Coerce any value to a finite number, defaulting to 0 (mirrors toUsd in local.ts). */
export const num = moneyNum;

/** Round to the nearest cent using drift-safe integer-cent math. */
export const round2 = m2;

/** Sum a list of {amount} records (or raw numbers) safely (drift-safe). */
export function sumAmounts(items: ({ amount?: any } | number)[] | null | undefined): number {
  return sumMoney(items);
}

/** Periodic-inventory cost of goods sold. Falls back to purchases when no closing count exists. */
export function computeCogs(opening: number, purchases: number, closing: number, hasClosingCount: boolean): number {
  return hasClosingCount
    ? subMoney(addMoney(num(opening), num(purchases)), num(closing))
    : round2(num(purchases));
}

export function grossProfit(sales: number, cogs: number): number {
  return subMoney(num(sales), num(cogs));
}

/** Commission only accrues on positive gross profit. */
export function commission(gross: number, pct: number): number {
  const g = num(gross);
  return g > 0 ? pctOf(g, num(pct)) : 0;
}

export function netProfit(gross: number, commissionAmt: number, expenses: number, drawings: number): number {
  return subMoney(num(gross), num(commissionAmt), num(expenses), num(drawings));
}

/** Closing capital for the partner capital statement. */
export function closingCapital(openingCapital: number, netProfitAmt: number, totalDrawings: number): number {
  return subMoney(addMoney(num(openingCapital), num(netProfitAmt)), num(totalDrawings));
}

/** Equal split of net profit across N partners (guards against divide-by-zero). */
export function partnerShare(netProfitAmt: number, partnerCount: number): number {
  const n = Math.max(1, Math.floor(num(partnerCount)));
  return round2(num(netProfitAmt) / n);
}

export interface PnlInput {
  sales: number;
  purchases: number;
  openingStock: number;
  closingStock: number;
  hasClosingCount: boolean;
  expenses: number;
  drawings: number;
  commissionPct: number;
}

export interface PnlResult {
  revenue: number;
  cogs: number;
  grossProfit: number;
  commission: number;
  managerCommissionPct: number;
  expenses: number;
  drawings: number;
  netProfit: number;
}

/** End-to-end P&L for a period. Mirrors pnlRange() in local.ts. */
export function computePnl(input: PnlInput): PnlResult {
  const revenue = round2(input.sales);
  const cogs = computeCogs(input.openingStock, input.purchases, input.closingStock, input.hasClosingCount);
  const gross = grossProfit(revenue, cogs);
  const comm = commission(gross, input.commissionPct);
  const net = netProfit(gross, comm, input.expenses, input.drawings);
  return {
    revenue,
    cogs,
    grossProfit: gross,
    commission: comm,
    managerCommissionPct: num(input.commissionPct),
    expenses: round2(input.expenses),
    drawings: round2(input.drawings),
    netProfit: net,
  };
}

/** Cash on hand: opening + sales - supplier payments - drawings - commission payments. Mirrors dashboard(). */
export function computeCash(openingCash: number, sales: number, supplierPayments: number, drawings: number, commissionPayments = 0): number {
  return subMoney(addMoney(num(openingCash), num(sales)), num(supplierPayments), num(drawings), num(commissionPayments));
}

/** Net worth: total assets - total liabilities. */
export function computeNetWorth(assets: number, liabilities: number): number {
  return subMoney(num(assets), num(liabilities));
}
