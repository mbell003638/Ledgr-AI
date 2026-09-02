import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) => fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');

describe('271269 UI/UX remediation contracts', () => {
  it('keeps Ask AI chat and voice transaction entry as separate, explicit workflows', () => {
    const source = readApp('ask.tsx');
    expect(source).toContain('accessibilityLabel="Open voice transaction assistant"');
    expect(source).toContain('router.push("/voice" as Href)');
    expect(source).not.toContain('testID="ask-voice-inline"');
    expect(source).not.toContain('Adding it to this chat');
  });

  it('keeps accounting configuration out of Main Settings and canonical in Advanced Settings', () => {
    const source = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    expect(source).not.toContain('title="Accounting setup"');
    expect(source).not.toContain('read-only summary');
    expect(source).not.toContain('accounting-configuration-summary');
    expect(source).not.toContain('Accounting Style</Text>');
    expect(source).not.toContain('Accounting Basis</Text>');
    expect(source).toContain('router.push("/advanced-settings")');
    expect(advanced).toContain('Accounting & Workflow');
    expect(advanced).toContain('Accounting Basis');
    expect(advanced).toContain('Accounting Style');
  });

  it('removes default row elevation and reserves settings space above the VoiceFab', () => {
    const glow = fs.readFileSync(path.join(root, 'src/components/GlowPressable.tsx'), 'utf8');
    const settings = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    expect(glow).toContain('props.prominent ?');
    expect(glow).toContain('prominent ?');
    expect(settings).toContain('scroll: { paddingHorizontal: 18, paddingBottom: 180 }');
    expect(advanced).toContain('scroll: { paddingHorizontal: theme.spacing.lg, paddingBottom: 180 }');
  });

  it('makes the empty Home onboarding reminder dismissible and persistent', () => {
    const source = readApp('(tabs)/index.tsx');
    expect(source).toContain('quickStartDismissed');
    expect(source).toContain('quickStartDismissed ?');
    expect(source).toContain('testID="dismiss-dashboard-quick-start"');
    expect(source).toContain('quickStartDismissed: true');
    expect(source).toContain('Dismiss first-entry reminder');
  });
});
