import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) => fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');
const readSource = (relativePath: string) => fs.readFileSync(path.join(root, 'src', relativePath), 'utf8');

describe('271412 UI/UX remediation contracts', () => {
  it('makes shared Cards single-surface, clipped, and light-theme coherent', () => {
    const ui = readSource('components/UI.tsx');
    const glass = readSource('components/AnimatedGlassSurface.tsx');
    const theme = readSource('theme.ts');
    expect(ui).toContain('shadowEnabled = false');
    expect(ui).toContain('surfaceColor ?? theme.color.surfaceSecondary');
    expect(ui).toContain('overflow: "hidden"');
    expect(glass).toContain('overflow: "hidden"');
    expect(theme).toContain("surfaceSecondary: '#F1F5F2'");
  });

  it('keeps Ask AI voice inside the composer with a bounded themed waveform and stop/cancel recovery', () => {
    const ask = readApp('ask.tsx');
    const orb = readSource('components/VoiceOrb.tsx');
    expect(ask).toContain('testID="ask-voice-inline"');
    expect(ask).toContain('Tap Stop to add');
    expect(ask).toContain('Stop Ask AI voice input');
    expect(ask).toContain('Cancel Ask AI voice input');
    expect(ask).toContain('overflow: "visible"');
    expect(orb).toContain('backgroundColor: accent');
    expect(orb).toContain('waveCompact');
    expect(orb).toContain('minWidth: 30');
    expect(orb).not.toContain('theme.color.info || accent');
  });

  it('uses the full available onboarding viewport for compact steps and natural scrolling for the ready step', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('useWindowDimensions');
    expect(onboarding).toContain('minHeight: Math.max(320, viewportHeight - 150)');
    expect(onboarding).toContain('style={styles.stepBody}');
    expect(onboarding).toContain('style={styles.stepBodyTall}');
    expect(onboarding).toContain('stepBody: { width: "100%", flexGrow: 1, justifyContent: "center"');
  });
});
