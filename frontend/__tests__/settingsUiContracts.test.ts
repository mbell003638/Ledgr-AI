import fs from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(__dirname, '..', 'app');
const mainSettings = fs.readFileSync(path.join(appRoot, '(tabs)', 'settings.tsx'), 'utf8');
const advancedSettings = fs.readFileSync(path.join(appRoot, 'advanced-settings.tsx'), 'utf8');

describe('settings UI contracts', () => {
  it('requires explicit trust for custom chat, OCR, and voice hosts', () => {
    expect(advancedSettings).toContain('hasCustomVoiceHost');
    expect(advancedSettings).toContain('aiCustomHostConfirmed: customHostConfirmed');
    expect(advancedSettings).toContain('I trust these custom chat, OCR, and voice hosts');
  });

  it('does not write AI keys from main Settings save', () => {
    expect(mainSettings).not.toContain('setAIConfig');
    expect(mainSettings).not.toContain('getAIConfig');
    expect(advancedSettings).toContain('entryHelpOrder');
    expect(advancedSettings).toContain('AI first');
  });

  it('keeps Accounting & Workflow only in Advanced Settings', () => {
    expect(mainSettings).not.toContain('Accounting Style');
    expect(mainSettings).not.toContain('updateV2BookConfig');
    expect(advancedSettings).toContain('Accounting & Workflow');
    expect(advancedSettings).toContain('Accounting Style');
  });

  it('keeps sync under Advanced Settings and opens privacy in-app', () => {
    expect(mainSettings).not.toContain('Self-hosted Sync (Optional)');
    expect(mainSettings).not.toContain('Linking.openURL');
    expect(mainSettings).toContain('router.push("/privacy-data" as any)');
    expect(advancedSettings).toContain("router.push('/sync-settings' as any)");
  });
});
