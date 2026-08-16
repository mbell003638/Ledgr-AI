import { eligibleMetrics, getPersonaCapabilityDefaults, reportSegmentsFor, workspaceLabelsFor, workspaceTileLabelsFor } from '@/src/utils/capabilities';
import { accountCodeForExpenseCategory, expenseCategoryOptionsForPersona } from '@/src/accountingV2/expenseCategories';
import { metricsFromDashboard } from '@/src/utils/metrics';
import { V2_ACCOUNT_CODES } from '@/src/accountingV2/types';

describe('persona-adaptive accounting foundation', () => {
  it('gives startup the growth metrics that were previously hidden on Home', () => {
    const settings = { activePersona: 'startup', selectedPersonas: ['startup'] };
    const capabilities = getPersonaCapabilityDefaults(settings);
    expect(capabilities).toContain('growth_analytics');
    expect(eligibleMetrics({ ...settings, enabledCapabilities: capabilities }).map((metric) => metric.key)).toEqual(expect.arrayContaining(['cac', 'roi', 'roe', 'peg']));
  });

  it('gives ecommerce workspaces COGS, margin, RTO, CAC, and ROI readiness', () => {
    const settings = { activePersona: 'dropshipper', selectedPersonas: ['dropshipper'] };
    const capabilities = getPersonaCapabilityDefaults(settings);
    const keys = eligibleMetrics({ ...settings, enabledCapabilities: capabilities }).map((metric) => metric.key);
    expect(keys).toEqual(expect.arrayContaining(['cac', 'cogs', 'gross_margin', 'rto', 'roi']));
  });

  it('does not show supplier reports for a developer unless procurement is enabled', () => {
    const developer = { activePersona: 'developer', selectedPersonas: ['developer'] };
    expect(reportSegmentsFor(developer)).toContain('Customers');
    expect(reportSegmentsFor(developer)).not.toContain('Suppliers');
    expect(reportSegmentsFor({ ...developer, enabledCapabilities: [...getPersonaCapabilityDefaults(developer), 'procurement'] })).toContain('Suppliers');
  });

  it('uses persona-aware Accounts labels', () => {
    expect(workspaceLabelsFor({ activePersona: 'developer' }).accountsTitle).toBe('Clients');
    expect(workspaceLabelsFor({ activePersona: 'content_creator' }).accountsTitle).toBe('Partners & Platforms');
    expect(workspaceLabelsFor({ activePersona: 'retail' }).accountsTitle).toBe('Customers & Suppliers');
  });

  it('adapts Home workflow vocabulary to the selected persona', () => {
    expect(workspaceTileLabelsFor({ activePersona: 'dropshipper' })).toMatchObject({ sales: 'Customer Orders', delivery: 'Shipping & RTO', expenses: 'Ads & Operating Costs' });
    expect(workspaceTileLabelsFor({ activePersona: 'content_creator' })).toMatchObject({ sales: 'Brand Deals', receipts: 'Platform Payouts' });
    expect(workspaceTileLabelsFor({ activePersona: 'manufacturer' })).toMatchObject({ inventory: 'Materials & Stock', reports: 'Production Reports' });
    expect(workspaceTileLabelsFor({ activePersona: 'developer' })).toMatchObject({ sales: 'Client Work', quotes: 'Estimates' });
  });

  it('calculates optional metrics from persisted operational inputs', () => {
    const results = metricsFromDashboard({ totalSales: 1000, totalPurchases: 400, netProfit: 250, openingCapital: 500, netWorth: 750 }, { acquisitionSpend: 200, newCustomers: 10, returnedOrders: 2, shippedOrders: 20, investmentReturn: 150, investmentCost: 100, priceToEarnings: 12, expectedGrowthPercent: 20 });
    expect(results.find((metric) => metric.key === 'cac')).toMatchObject({ value: 20, state: 'ready' });
    expect(results.find((metric) => metric.key === 'rto')).toMatchObject({ value: 10, state: 'ready' });
    expect(results.find((metric) => metric.key === 'roi')).toMatchObject({ value: 50, state: 'ready' });
    expect(results.find((metric) => metric.key === 'peg')).toMatchObject({ value: 0.6, state: 'ready' });
  });

  it('maps business expense categories to dedicated validated V2 accounts', () => {
    expect(accountCodeForExpenseCategory('Advertising and acquisition')).toBe(V2_ACCOUNT_CODES.ADVERTISING_EXPENSE);
    expect(accountCodeForExpenseCategory('Returns and RTO')).toBe(V2_ACCOUNT_CODES.RETURNS_EXPENSE);
    expect(accountCodeForExpenseCategory('unknown custom category')).toBe(V2_ACCOUNT_CODES.EXPENSES);
    expect(expenseCategoryOptionsForPersona('manufacturer').map((option) => option.accountCode)).toContain(V2_ACCOUNT_CODES.MANUFACTURING_OVERHEAD);
  });
});
