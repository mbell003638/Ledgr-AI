import { getEnabledCapabilities, getWorkspaceProfile, operationalModulesFor } from '../src/utils/workspaceCapabilities';

describe('workspace capability compatibility layer', () => {
  it('maps legacy business types without creating a second feature source of truth', () => {
    const profile = getWorkspaceProfile({ businessType: 'shop' });
    expect(profile.persona).toBe('retail');
    expect(profile.title).toBe('Retail Shop Workspace');
    expect(profile.featured.length).toBeLessThanOrEqual(6);
  });

  it('honours the existing manual enabledFeatures override', () => {
    const settings = { activePersona: 'retail', enabledFeatures: ['invoices', 'expenses', 'reports'] };
    expect(operationalModulesFor(settings).map((module) => module.key)).toEqual(['invoices', 'expenses', 'reports']);
    expect(getEnabledCapabilities(settings)).toEqual(expect.arrayContaining(['sales_and_billing', 'purchases_and_expenses', 'reporting']));
    expect(getEnabledCapabilities(settings)).not.toContain('inventory_control');
  });

  it('keeps optional capabilities off until their existing feature is enabled', () => {
    const base = { activePersona: 'retail', enabledFeatures: ['inventory'] };
    expect(getEnabledCapabilities(base)).toContain('inventory_control');
    expect(getEnabledCapabilities(base)).not.toContain('payroll');
    expect(getEnabledCapabilities({ ...base, enabledFeatures: ['inventory', 'payroll'] })).toContain('payroll');
  });
});
