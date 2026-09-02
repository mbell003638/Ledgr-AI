import { normalizeEntryHelpOrder, withCloudHelpTimeout } from '../src/db/ai';
import { sanitizeSpokenPartyName } from '../src/accountingV2/voicePartyResolution';

describe('entry help order and spoken names', () => {
  it('defaults Automatic order to AI first', () => {
    expect(normalizeEntryHelpOrder(undefined)).toBe('cloud-first');
    expect(normalizeEntryHelpOrder('device-first')).toBe('device-first');
  });

  it('times out a hung cloud call', async () => {
    await expect(withCloudHelpTimeout(new Promise(() => undefined), 20)).rejects.toThrow(/did not respond in time/i);
  });

  it('rejects spoken verbs as party names', () => {
    expect(sanitizeSpokenPartyName('make')).toBe('');
    expect(sanitizeSpokenPartyName('Make Hardware')).toBe('Make Hardware');
    expect(sanitizeSpokenPartyName('Amit today')).toBe('Amit');
  });
});
