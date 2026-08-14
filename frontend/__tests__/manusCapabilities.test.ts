import {
  activePersonaFor,
  getEnabledCapabilities,
  getPersonaCapabilityDefaults,
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
