import fs from 'node:fs';
import path from 'node:path';

import { isCompactHeaderWidth, quickActionFabBottom, quickActionMenuBottom, quickActionMenuMaxHeight, quickActionMenuWidth } from '../src/utils/responsiveLayout';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const ui = read('src/components/UI.tsx');
const tabs = read('app/(tabs)/_layout.tsx');
const settings = read('app/(tabs)/settings.tsx');
const advancedSettings = read('app/advanced-settings.tsx');
const syncSettings = read('app/sync-settings.tsx');
const syncConflicts = read('app/sync-conflicts.tsx');
const backupRecovery = read('app/backup-recovery.tsx');
const quickActions = read('src/components/QuickActionMenu.tsx');

describe('Manus responsive layout safeguards', () => {
  it('uses the compact header below the narrow-phone breakpoint', () => {
    expect(isCompactHeaderWidth(320)).toBe(true);
    expect(isCompactHeaderWidth(390)).toBe(true);
    expect(isCompactHeaderWidth(430)).toBe(true);
    expect(isCompactHeaderWidth(479)).toBe(true);
    expect(isCompactHeaderWidth(480)).toBe(false);
    expect(ui).toContain('const compactHeader = compact || (isCompactHeaderWidth(width)');
    expect(ui).toContain('adjustsFontSizeToFit={compactHeader}');
    expect(ui).toContain('styles.compactRow');
    expect(ui).toContain('styles.compactTitleArea');
    expect(ui).toContain('styles.compactActions');
    expect(ui).toContain('compactRow: { flexDirection: "row"');
    expect(ui).toContain('compactActions: { alignSelf: "flex-start"');
    expect(ui).not.toContain('compactRow: { flexDirection: "column"');
    expect(syncSettings).toContain('title="Self-hosted Sync"');
    expect(syncConflicts).toContain('title="Conflict Inbox"');
    expect(backupRecovery).toContain('title="Backup & Recovery"');
    expect(tabs).toContain('fontSize: compact ? 11 : 11');
    expect(tabs).toContain('lineHeight: compact ? 14 : 14');
    expect(settings).toContain('settingsGroup: { marginTop: theme.spacing.lg');
    expect(advancedSettings).toContain('advancedHeader: { paddingTop: 20, paddingBottom: 10 }');
    expect(advancedSettings).toContain('advancedGroup: { marginTop: theme.spacing.lg');
  });

  it('keeps Quick Actions safe on short screens', () => {
    expect(quickActions).toContain('useSafeAreaInsets');
    expect(quickActions).toContain('menuMaxHeight');
    expect(quickActions).toContain('<ScrollView');
    expect(quickActions).toContain('maxHeight: menuMaxHeight');
    expect(quickActionFabBottom(34)).toBe(60);
    expect(quickActionMenuBottom(34)).toBe(116);
    expect(quickActionMenuMaxHeight(568, 24, 34)).toBe(416);
    expect(quickActionMenuMaxHeight(200, 80, 40)).toBe(0);
    expect(quickActionMenuWidth(320, 0, 0)).toBe(296);
    expect(quickActionMenuWidth(800, 20, 20)).toBe(410);
  });
});
