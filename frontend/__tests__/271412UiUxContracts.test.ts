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

  it('uses one voice transaction workflow while preserving the themed voice orb', () => {
    const ask = readApp('ask.tsx');
    const orb = readSource('components/VoiceOrb.tsx');
    expect(ask).toContain('accessibilityLabel="Open voice transaction assistant"');
    expect(ask).toContain('router.push("/voice" as Href)');
    expect(ask).not.toContain('voiceInputWrapper');
    expect(orb).toContain('backgroundColor: accent');
    expect(orb).toContain('waveCompact');
    expect(orb).toContain('minWidth: 30');
    expect(orb).not.toContain('theme.color.info || accent');
  });

  it('provides browser-safe location CRUD while preserving the native SQLite path', () => {
    const api = fs.readFileSync(path.join(root, 'src', 'api.ts'), 'utf8');
    expect(api).toContain('const rows = await db.listLocations()');
    expect(api).toContain('const r = await db.createLocation(input)');
    expect(api).toContain('db.updateLocation(id, { active: false })');
  });

  it('uses a full-height onboarding scroll region with a single safe-area-aware footer', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('useSafeAreaInsets');
    expect(onboarding).toContain('<SafeAreaView style={styles.container} edges={["top"]}>');
    expect(onboarding).toContain('const footerBottomPadding = Math.max(12, insets.bottom);');
    expect(onboarding).toContain('paddingBottom: footerBottomPadding');
    expect(onboarding).toContain('step === 0 && styles.footerSolo');
    expect(onboarding).toContain('step === 0 && styles.nextBtnSolo');
    expect(onboarding).toContain('{step > 0 ? <Pressable');
    expect(onboarding).toContain('footerSolo: { justifyContent: "center" }');
    expect(onboarding).toContain('nextBtnSolo: { alignSelf: "stretch" }');
    expect(onboarding).toContain('scrollView: { flex: 1 }');
    expect(onboarding).toContain('flexShrink: 0');
    expect(onboarding).not.toContain('useWindowDimensions');
    expect(onboarding).not.toContain('minHeight: Math.max(0, viewportHeight - 220)');
    expect(onboarding).toContain('style={styles.stepBody}');
    expect(onboarding).toContain('style={styles.stepBodyTall}');
    expect(onboarding).toContain('stepBody: { width: "100%", flexGrow: 0, justifyContent: "flex-start"');
  });
});
