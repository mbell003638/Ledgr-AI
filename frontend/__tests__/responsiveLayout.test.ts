import fs from 'node:fs';
import path from 'node:path';

import { isCompactHeaderWidth, quickActionFabBottom, quickActionMenuBottom, quickActionMenuMaxHeight, quickActionMenuWidth } from '../src/utils/responsiveLayout';
import { SETTINGS_SCREEN_CARD_GAP, SETTINGS_SCREEN_CONTENT_TOP, SETTINGS_SCREEN_HEADER_BOTTOM } from '../src/utils/settingsScreenLayout';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const ui = read('src/components/UI.tsx');
const syncSettings = read('app/sync-settings.tsx');
const syncConflicts = read('app/sync-conflicts.tsx');
const backupRecovery = read('app/backup-recovery.tsx');
const quickActions = read('src/components/QuickActionMenu.tsx');
const advancedSettings = read('app/advanced-settings.tsx');
const settings = read('app/(tabs)/settings.tsx');
const embeddedSettingsScreens = [
  'app/advanced-settings.tsx',
  'app/backup-recovery.tsx',
  'app/bank-import-preview.tsx',
  'app/book-health.tsx',
  'app/experimental-modules.tsx',
  'app/privacy-data.tsx',
  'app/self-host-guide.tsx',
  'app/sync-settings.tsx',
  'app/workflows.tsx',
].map(read);
const cardGapScreens = [
  'app/backup-recovery.tsx',
  'app/bank-import-preview.tsx',
  'app/experimental-modules.tsx',
  'app/self-host-guide.tsx',
  'app/sync-conflict-correction.tsx',
  'app/sync-conflicts.tsx',
  'app/sync-settings.tsx',
].map(read);

describe('responsive layout safeguards', () => {
  it('activates the compact header only below the narrow-phone breakpoint', () => {
    expect(isCompactHeaderWidth(320)).toBe(true);
    expect(isCompactHeaderWidth(360)).toBe(true);
    expect(isCompactHeaderWidth(390)).toBe(true);
    expect(isCompactHeaderWidth(430)).toBe(true);
    expect(isCompactHeaderWidth(479)).toBe(true);
    expect(isCompactHeaderWidth(480)).toBe(false);
    expect(isCompactHeaderWidth(768)).toBe(false);
  });

  it('preserves the default ScreenHeader and opts embedded back headers into compact mode conditionally', () => {
    expect(ui).toContain('compact = false, embedded = false');
    expect(ui).toContain('const resolvedCompact = compact || (isCompactHeaderWidth(width)');
    expect(ui).toContain('numberOfLines={resolvedCompact ? 2 : undefined}');
    expect(ui).toContain('styles.embeddedCompactRow');
    expect(ui).toContain('styles.embeddedCompactActions');
    expect(ui).toContain('embedded && styles.embedded');
    expect(ui).toContain('embedded: { flex: 1, minWidth: 0, paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0');
    expect(ui).not.toContain('embedded && resolvedCompact && styles.embeddedCompact, style');
    expect(ui).toContain('embeddedCompactRow: { flexDirection: "row"');
    expect(ui).toContain('embeddedCompactActions: { alignSelf: "flex-start"');
    expect(ui).not.toContain('embeddedCompactRow: { flexDirection: "column"');
    expect(syncSettings).toContain('<ScreenHeader embedded');
    expect(syncConflicts).toContain('title="Conflict Inbox"');
    expect(backupRecovery).toContain('title="Backup & Recovery"');
    expect(advancedSettings).toContain('<ScreenHeader embedded title="Advanced"');
  });

  it('uses the main Settings spacing rhythm across every settings subpage', () => {
    expect(SETTINGS_SCREEN_HEADER_BOTTOM).toBe(10);
    expect(SETTINGS_SCREEN_CONTENT_TOP).toBe(16);
    expect(SETTINGS_SCREEN_CARD_GAP).toBe(16);
    expect(settings).toContain('settingsGroup: { marginTop: theme.spacing.lg');
    expect(advancedSettings).toContain('marginTop: theme.spacing.lg');

    for (const screen of embeddedSettingsScreens) {
      expect(screen).toContain('SETTINGS_SCREEN_HEADER_BOTTOM');
    }
    for (const screen of cardGapScreens) {
      expect(screen).toContain('SETTINGS_SCREEN_CARD_GAP');
    }
  });

  it('bounds quick actions for short viewports while preserving the FAB geometry', () => {
    expect(quickActionMenuMaxHeight(568, 24)).toBe(434);
    expect(quickActionMenuMaxHeight(844, 47)).toBe(687);
    expect(quickActionMenuMaxHeight(360, 0)).toBe(250);
    expect(quickActionFabBottom(34)).toBe(60);
    expect(quickActionMenuBottom(34)).toBe(116);
    expect(quickActionMenuMaxHeight(568, 24, 34)).toBe(416);
    expect(quickActionMenuMaxHeight(200, 80, 40)).toBe(0);
    expect(quickActionMenuWidth(320, 0, 0)).toBe(296);
    expect(quickActionMenuWidth(800, 20, 20)).toBe(410);
    expect(quickActions).toContain('maxHeight: menuMaxHeight');
    expect(quickActions).toContain('<ScrollView');
    expect(quickActions).toContain('testID="quick-action-scroll"');
    expect(quickActions).toContain('bottom: fabBottom');
    expect(quickActions).toContain('width: 52');
  });

  it('uses a compact status badge instead of the vertical hosting accent', () => {
    expect(advancedSettings).toContain('styles.workflowStatusBadge');
    expect(advancedSettings).toContain('styles.workflowStatusDot');
    expect(advancedSettings).not.toContain('borderLeftWidth: 3');
  });
});
