import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) => fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');
const readSource = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Phase 4–6 remediation contracts', () => {
  it('keeps web depth in bounded boxShadow CSS and native depth in native-only branches', () => {
    const glass = readSource('src/components/AnimatedGlassSurface.tsx');
    const glow = readSource('src/components/GlowPressable.tsx');
    const workspace = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    const ui = readSource('src/components/UI.tsx');
    const quick = readSource('src/components/QuickActionMenu.tsx');

    for (const source of [glass, glow, workspace, ui, quick]) {
      expect(source).toContain('boxShadow');
    }
    expect(glass).toContain('Platform.OS === "web"');
    expect(glass).toContain('0 4px');
    expect(glow).toContain('focus > 0');
    expect(workspace).toContain('Native shadow properties are intentionally excluded from the web worklet');
    expect(ui).toContain('boxShadow: "none"');
    expect(ui).toContain('overflow: "hidden"');
    expect(quick).toContain('boxShadow: `0 -4px 24px');
  });

  it('keeps onboarding keyboard-safe and explains advanced choices without cluttering the first step', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('<KeyboardAvoidingView');
    expect(onboarding).toContain('keyboardDismissMode="on-drag"');
    expect(onboarding).toContain('automaticallyAdjustKeyboardInsets');
    expect(onboarding).toContain('Keyboard.dismiss()');
    expect(onboarding).toContain('Customize advanced workflows');
    expect(onboarding).toContain('testID="onboarding-capability-summary"');
  });

  it('creates and selects a first location when multi-location is enabled during onboarding', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('testID="onboarding-multi-location"');
    expect(onboarding).toContain('testID="onboarding-initial-location"');
    expect(onboarding).toContain('Name your first location');
    expect(onboarding).toContain('await api.listLocations()');
    expect(onboarding).toContain('await api.createLocation({ name: finalLocationName })');
    expect(onboarding).toContain('await api.updateSettings({ activeLocationId: String(location.id) })');
  });

  it('shows location context on Home while retaining an All locations report scope', () => {
    const dashboard = readApp('(tabs)/index.tsx');
    const reports = readApp('(tabs)/reports.tsx');
    const picker = readSource('src/components/LocationPicker.tsx');
    expect(dashboard).toContain('testID="dashboard-location-context"');
    expect(dashboard).toContain('Reporting location');
    expect(dashboard).toContain('All locations');
    expect(reports).toContain('v2Reports({ from, to, locationId: shopId })');
    expect(picker).toContain('Choose a location before saving this entry.');
  });
});

