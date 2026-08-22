import {
  activePersonaFor,
  getEnabledCapabilities,
  getPersonaCapabilityDefaults,
  featureKeysForCapabilities,
  isCapabilityEnabled,
} from '../src/utils/capabilities';
import {
  calculateCac,
  calculateCogs,
  calculateGrossMargin,
  calculatePeg,
  calculateRoe,
  calculateRoi,
  calculateRto,
} from '../src/utils/metrics';

describe('Manus persona capabilities', () => {
  it('keeps a mobile invoicing workspace focused', () => {
    const settings = { activePersona: 'mobile_invoicing', selectedPersonas: ['mobile_invoicing'] };
    expect(activePersonaFor(settings)).toBe('mobile_invoicing');
    expect(isCapabilityEnabled(settings, 'invoicing')).toBe(true);
    expect(isCapabilityEnabled(settings, 'manufacturing')).toBe(false);
    expect(isCapabilityEnabled(settings, 'multi_location')).toBe(false);
  });

  it('gives retail a location-aware default while preserving core capabilities', () => {
    const settings = { activePersona: 'retail', selectedPersonas: ['retail'] };
    const defaults = getPersonaCapabilityDefaults(settings);
    expect(defaults).not.toContain('multi_location');
    expect(defaults).toContain('core_ledger');
    expect(getEnabledCapabilities({ ...settings, enabledCapabilities: ['invoicing', 'multi_location'] })).toEqual(expect.arrayContaining(['core_ledger', 'cashbook', 'reporting', 'invoicing', 'multi_location']));
  });

  it('maps capability-derived entry points to the selected business model', () => {
    const retailFeatures = featureKeysForCapabilities({ activePersona: 'retail' });
    expect(retailFeatures).toEqual(expect.arrayContaining(['sales', 'invoices', 'receipts', 'quotes', 'bills', 'payments', 'expenses', 'inventory', 'delivery']));
    const saasFeatures = featureKeysForCapabilities({ activePersona: 'saas' });
    expect(saasFeatures).toEqual(expect.arrayContaining(['invoices', 'receipts', 'quotes', 'expenses', 'reports', 'monthly']));
    expect(saasFeatures).not.toContain('inventory');
    expect(saasFeatures).not.toContain('bills');
  });

  it('keeps voice assistant opt-in while leaving Ask AI available by default', () => {
    const settings = { activePersona: 'retail', selectedPersonas: ['retail'] };
    const defaults = getPersonaCapabilityDefaults(settings);
    expect(defaults).toContain('ai_assistant');
    expect(defaults).not.toContain('voice_assistant');
    expect(featureKeysForCapabilities(settings)).not.toContain('voice');
    expect(isCapabilityEnabled(settings, 'ai_assistant')).toBe(true);
    expect(isCapabilityEnabled({ ...settings, enabledCapabilities: ['voice_assistant'] }, 'voice_assistant')).toBe(true);
  });

  it('maps legacy business types to safe modern personas', () => {
    expect(activePersonaFor({ businessType: 'freelancer' })).toBe('content_creator');
    expect(activePersonaFor({ businessType: 'shop' })).toBe('retail');
  });
});

describe('Manus metrics', () => {
  it('calculates operating metrics with explicit formulas', () => {
    expect(calculateCogs(1000).value).toBe(1000);
    expect(calculateGrossMargin(2000, 1000).value).toBe(50);
    expect(calculateCac(500, 10).value).toBe(50);
    expect(calculateRto(2, 20).value).toBe(10);
    expect(calculateRoi(1500, 1000).value).toBe(50);
    expect(calculateRoe(200, 800, 1200).value).toBe(20);
    expect(calculatePeg(20, 10).value).toBe(2);
  });

  it('does not show misleading metrics without required inputs', () => {
    expect(calculateCac(0, 10).state).toBe('insufficient_data');
    expect(calculateRto(2, 0).state).toBe('insufficient_data');
    expect(calculatePeg(0, 10).state).toBe('insufficient_data');
  });
});
