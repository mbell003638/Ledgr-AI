import fs from 'node:fs';
import path from 'node:path';

import { isCompactHeaderWidth, quickActionMenuMaxHeight } from '../src/utils/responsiveLayout';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const ui = read('src/components/UI.tsx');
const syncSettings = read('app/sync-settings.tsx');
const quickActions = read('src/components/QuickActionMenu.tsx');
const advancedSettings = read('app/advanced-settings.tsx');

describe('responsive layout safeguards', () => {
  it('activates the compact header only below the narrow-phone breakpoint', () => {
    expect(isCompactHeaderWidth(320)).toBe(true);
    expect(isCompactHeaderWidth(360)).toBe(true);
    expect(isCompactHeaderWidth(389)).toBe(true);
    expect(isCompactHeaderWidth(390)).toBe(false);
    expect(isCompactHeaderWidth(768)).toBe(false);
  });

  it('preserves the default ScreenHeader and opts embedded back headers into compact mode conditionally', () => {
    expect(ui).toContain('compact = false, embedded = false');
    expect(ui).toContain('const resolvedCompact = compact || (isCompactHeaderWidth(width)');
    expect(ui).toContain('numberOfLines={resolvedCompact ? 1 : undefined}');
    expect(ui).toContain('styles.embeddedCompactRow');
    expect(ui).toContain('styles.embeddedCompactActions');
    expect(syncSettings).toContain('<ScreenHeader embedded');
    expect(advancedSettings).toContain('<ScreenHeader embedded title="Advanced"');
  });

  it('bounds quick actions for short viewports while preserving the FAB geometry', () => {
    expect(quickActionMenuMaxHeight(568, 24)).toBe(434);
    expect(quickActionMenuMaxHeight(844, 47)).toBe(687);
    expect(quickActionMenuMaxHeight(360, 0)).toBe(250);
    expect(quickActions).toContain('maxHeight: menuMaxHeight');
    expect(quickActions).toContain('<ScrollView');
    expect(quickActions).toContain('testID="quick-action-scroll"');
    expect(quickActions).toContain('bottom: 42');
    expect(quickActions).toContain('width: 52');
  });

  it('uses a compact status badge instead of the vertical hosting accent', () => {
    expect(advancedSettings).toContain('styles.workflowStatusBadge');
    expect(advancedSettings).toContain('styles.workflowStatusDot');
    expect(advancedSettings).not.toContain('borderLeftWidth: 3');
  });
});
