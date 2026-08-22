import { advancedOperationalModulesFor, featuredOperationalModulesFor, operationalModulesFor } from '../src/utils/operationalModules';

describe('progressive industry module coverage', () => {
  it('keeps featured tools focused while exposing advanced tools for manufacturers', () => {
    const settings = { activePersona: 'manufacturer', selectedPersonas: ['manufacturer'] };
    const featured = featuredOperationalModulesFor(settings);
    const advanced = advancedOperationalModulesFor(settings);
    const all = operationalModulesFor(settings);
    expect(featured.length).toBeLessThanOrEqual(8);
    expect(featured.map((module) => module.key)).toEqual(expect.arrayContaining(['sales_orders', 'inventory_catalog', 'manufacturing_bom']));
    expect(all.length).toBeGreaterThan(featured.length);
    expect(advanced.map((module) => module.key)).toEqual(expect.arrayContaining(['budgets_forecasts', 'tax_compliance']));
  });

  it('exposes live stock control only when the live product stock capability is enabled', () => {
    const periodic = operationalModulesFor({ activePersona: 'retail', enabledCapabilities: ['inventory'] }).map((module) => module.key);
    const live = operationalModulesFor({ activePersona: 'retail', enabledCapabilities: ['live_product_stock'] }).map((module) => module.key);
    expect(periodic).not.toContain('live_stock_control');
    expect(live).toContain('inventory_catalog');
    expect(live).toContain('live_stock_control');
  });

  it('gives a creator the creator workflow without showing manufacturing by default', () => {
    const settings = { activePersona: 'content_creator', selectedPersonas: ['content_creator'] };
    const featuredKeys = featuredOperationalModulesFor(settings).map((module) => module.key);
    expect(featuredKeys).toContain('creator_contracts');
    expect(featuredKeys).not.toContain('manufacturing_bom');
  });
});
