import { eligibleMetrics, getPersonaCapabilityDefaults, reportSegmentsFor, workspaceLabelsFor } from '@/src/utils/capabilities';
import { accountCodeForExpenseCategory, expenseCategoryOptionsForPersona } from '@/src/accountingV2/expenseCategories';
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

  it('maps business expense categories to dedicated validated V2 accounts', () => {
    expect(accountCodeForExpenseCategory('Advertising and acquisition')).toBe(V2_ACCOUNT_CODES.ADVERTISING_EXPENSE);
    expect(accountCodeForExpenseCategory('Returns and RTO')).toBe(V2_ACCOUNT_CODES.RETURNS_EXPENSE);
    expect(accountCodeForExpenseCategory('unknown custom category')).toBe(V2_ACCOUNT_CODES.EXPENSES);
    expect(expenseCategoryOptionsForPersona('manufacturer').map((option) => option.accountCode)).toContain(V2_ACCOUNT_CODES.MANUFACTURING_OVERHEAD);
  });
});
