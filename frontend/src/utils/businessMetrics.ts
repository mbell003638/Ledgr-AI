export type MetricResult = {
  state: 'ready' | 'insufficient_data';
  value: number | null;
  label: string;
  formula: string;
  reason?: string;
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const valid = (...values: number[]) => values.every(Number.isFinite);
const insufficient = (label: string, formula: string, reason: string): MetricResult => ({ state: 'insufficient_data', value: null, label, formula, reason });

export function calculateCogs(purchases: number): MetricResult {
  const label = 'Cost of goods sold';
  const formula = 'Purchases used as the current-period COGS estimate';
  if (!valid(purchases) || purchases < 0) return insufficient(label, formula, 'A valid non-negative purchase total is required.');
  return { state: 'ready', value: round2(purchases), label, formula };
}

export function calculateGrossMargin(revenue: number, cogs: number): MetricResult {
  const label = 'Gross margin';
  const formula = '(Revenue - COGS) / Revenue × 100';
  if (!valid(revenue, cogs) || revenue <= 0 || cogs < 0) return insufficient(label, formula, 'Record positive sales and valid costs to calculate margin.');
  return { state: 'ready', value: round2(((revenue - cogs) / revenue) * 100), label, formula };
}

export function calculateCac(marketingSpend: number, newCustomers: number): MetricResult {
  const label = 'Customer acquisition cost';
  const formula = 'Marketing spend / New customers';
  if (!valid(marketingSpend, newCustomers) || marketingSpend < 0 || newCustomers <= 0) return insufficient(label, formula, 'Marketing spend and at least one new customer are required.');
  return { state: 'ready', value: round2(marketingSpend / newCustomers), label, formula };
}

export function calculateRoi(gain: number, cost: number): MetricResult {
  const label = 'Return on investment';
  const formula = '(Gain - Cost) / Cost × 100';
  if (!valid(gain, cost) || cost <= 0) return insufficient(label, formula, 'A positive investment cost is required.');
  return { state: 'ready', value: round2(((gain - cost) / cost) * 100), label, formula };
}

export function calculateRoe(netIncome: number, openingEquity: number, closingEquity: number): MetricResult {
  const label = 'Return on equity';
  const formula = 'Net income / Average equity × 100';
  const averageEquity = (openingEquity + closingEquity) / 2;
  if (!valid(netIncome, openingEquity, closingEquity) || averageEquity <= 0) return insufficient(label, formula, 'Positive average equity is required.');
  return { state: 'ready', value: round2((netIncome / averageEquity) * 100), label, formula };
}
