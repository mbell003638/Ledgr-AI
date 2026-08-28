import fs from 'node:fs';
import path from 'node:path';

import { isCompactHeaderWidth } from '../src/utils/responsiveLayout';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const ui = read('src/components/UI.tsx');
const quickActions = read('src/components/QuickActionMenu.tsx');

describe('Manus responsive layout safeguards', () => {
  it('uses the compact header below the narrow-phone breakpoint', () => {
    expect(isCompactHeaderWidth(320)).toBe(true);
    expect(isCompactHeaderWidth(389)).toBe(true);
    expect(isCompactHeaderWidth(390)).toBe(false);
    expect(ui).toContain('const compactHeader = compact || (isCompactHeaderWidth(width)');
    expect(ui).toContain('adjustsFontSizeToFit={compactHeader}');
  });

  it('keeps Quick Actions safe on short screens', () => {
    expect(quickActions).toContain('useSafeAreaInsets');
    expect(quickActions).toContain('menuMaxHeight');
    expect(quickActions).toContain('<ScrollView');
    expect(quickActions).toContain('maxHeight: menuMaxHeight');
  });
});
