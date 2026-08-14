import type { MetricKey } from './capabilities';

export type MetricState = 'ready' | 'insufficient_data' | 'estimated';
export type MetricResult = { key: MetricKey; label: string; value: number | null; unit: 'amount' | 'percent' | 'ratio'; state: MetricState; explanation: string };

const pct = (value: number) => Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function calculateCogs(purchases: number, inventoryChange = 0): MetricResult {
  const value = Math.max(0, finite(purchases) + finite(inventoryChange));
  return { key: 'cogs', label: 'COGS', value, unit: 'amount', state: value > 0 ? 'ready' : 'insufficient_data', explanation: value > 0 ? 'Based on recorded purchases and inventory adjustments.' : 'Record product purchases or stock costs to calculate COGS.' };
}

export function calculateGrossMargin(revenue: number, cogs: number): MetricResult {
  const sales = finite(revenue); const cost = finite(cogs);
  if (sales <= 0) return { key: 'gross_margin', label: 'Gross margin', value: null, unit: 'percent', state: 'insufficient_data', explanation: 'Record revenue before calculating gross margin.' };
  return { key: 'gross_margin', label: 'Gross margin', value: pct(((sales - cost) / sales) * 100), unit: 'percent', state: 'ready', explanation: 'Gross margin = (revenue − COGS) ÷ revenue.' };
}

export function calculateCac(acquisitionSpend: number, newCustomers: number): MetricResult {
  const spend = finite(acquisitionSpend); const customers = finite(newCustomers);
  if (spend <= 0 || customers <= 0) return { key: 'cac', label: 'CAC', value: null, unit: 'amount', state: 'insufficient_data', explanation: 'Tag acquisition spend and record new customers for the same period.' };
  return { key: 'cac', label: 'CAC', value: pct(spend / customers), unit: 'amount', state: 'ready', explanation: 'CAC = attributed acquisition spend ÷ new customers.' };
}

export function calculateRto(returnedOrders: number, shippedOrders: number): MetricResult {
  const returned = finite(returnedOrders); const shipped = finite(shippedOrders);
  if (shipped <= 0) return { key: 'rto', label: 'RTO', value: null, unit: 'percent', state: 'insufficient_data', explanation: 'Track shipped orders and return-to-origin outcomes.' };
  return { key: 'rto', label: 'RTO', value: pct((returned / shipped) * 100), unit: 'percent', state: 'ready', explanation: 'RTO = returned-to-origin shipments ÷ shipped orders.' };
}

export function calculateRoi(returnValue: number, investment: number): MetricResult {
  const result = finite(returnValue); const cost = finite(investment);
  if (cost <= 0) return { key: 'roi', label: 'ROI', value: null, unit: 'percent', state: 'insufficient_data', explanation: 'Assign a cost and attributable return to an investment or campaign.' };
  return { key: 'roi', label: 'ROI', value: pct(((result - cost) / cost) * 100), unit: 'percent', state: 'ready', explanation: 'ROI = (attributable return − investment) ÷ investment.' };
}

export function calculateRoe(netProfit: number, openingEquity: number, closingEquity: number): MetricResult {
  const averageEquity = (finite(openingEquity) + finite(closingEquity)) / 2;
  if (averageEquity <= 0) return { key: 'roe', label: 'ROE', value: null, unit: 'percent', state: 'insufficient_data', explanation: 'Record opening and closing owner or shareholder equity.' };
  return { key: 'roe', label: 'ROE', value: pct((finite(netProfit) / averageEquity) * 100), unit: 'percent', state: 'ready', explanation: 'ROE = net profit ÷ average equity.' };
}

export function calculatePeg(priceToEarnings: number, expectedGrowthPercent: number): MetricResult {
  const pe = finite(priceToEarnings); const growth = finite(expectedGrowthPercent);
  if (pe <= 0 || growth <= 0) return { key: 'peg', label: 'PEG', value: null, unit: 'ratio', state: 'insufficient_data', explanation: 'PEG requires a valuation multiple and expected earnings growth.' };
  return { key: 'peg', label: 'PEG', value: pct(pe / growth), unit: 'ratio', state: 'ready', explanation: 'PEG = price-to-earnings ratio ÷ expected earnings growth.' };
}

export function metricsFromDashboard(dashboard: any, inputs?: { acquisitionSpend?: number; newCustomers?: number; returnedOrders?: number; shippedOrders?: number; investmentReturn?: number; investmentCost?: number; priceToEarnings?: number; expectedGrowthPercent?: number }): MetricResult[] {
  return [
    calculateCogs(finite(dashboard?.totalPurchases), finite(dashboard?.inventoryAdjustment)),
    calculateGrossMargin(finite(dashboard?.totalSales), finite(dashboard?.totalPurchases)),
    calculateCac(finite(inputs?.acquisitionSpend), finite(inputs?.newCustomers)),
    calculateRto(finite(inputs?.returnedOrders), finite(inputs?.shippedOrders)),
    calculateRoi(finite(inputs?.investmentReturn), finite(inputs?.investmentCost)),
    calculateRoe(finite(dashboard?.netProfit), finite(dashboard?.openingCapital), finite(dashboard?.netWorth)),
    calculatePeg(finite(inputs?.priceToEarnings), finite(inputs?.expectedGrowthPercent)),
  ];
}
