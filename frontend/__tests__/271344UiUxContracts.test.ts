import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) => fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');
const readSource = (relativePath: string) => fs.readFileSync(path.join(root, 'src', relativePath), 'utf8');

describe('271344 UI/UX remediation contracts', () => {
  it('keeps the Home first-entry reminder on a single bounded surface', () => {
    const home = readApp('(tabs)/index.tsx');
    expect(home).toContain('shadowEnabled={false}');
    expect(home).toContain('style={{ borderRadius: theme.radius.lg, marginBottom: 16 }}');
    expect(home).toContain('boxShadow: "none"');
    expect(home).not.toContain('shadowOffset: { width: 0, height: 10 }');
  });

  it('keeps compact Ask AI voice waveform visible beside the mic', () => {
    const ask = readApp('ask.tsx');
    const orb = readSource('components/VoiceOrb.tsx');
    expect(ask).toContain('askVoiceInline');
    expect(ask).toContain('overflow: "visible"');
    expect(ask).toContain('boxShadow: "none"');
    expect(orb).toContain('const bars = compact ? BAR_HEIGHTS.slice(3, 10) : BAR_HEIGHTS');
    expect(orb).toContain('waveCompact');
    expect(orb).toContain('overflow: "visible"');
    expect(ask).toContain('Stop Ask AI voice input');
    expect(ask).toContain('Cancel Ask AI voice input');
  });

  it('keeps Reports cards single-surface and location chips stable on narrow screens', () => {
    const reports = readApp('(tabs)/reports.tsx');
    expect(reports).toContain('shadowEnabled={false} surfaceColor={theme.color.surfaceSecondary}');
    expect(reports).toContain('minWidth: 118');
    expect(reports).toContain('flexShrink: 0');
    expect(reports).toContain('alignItems: "center"');
    expect(reports).toContain('justifyContent: "center"');
    expect(reports).toContain('textAlign: "center"');
    expect(reports).toContain('textAlignVertical: "center"');
    expect(reports).toContain('includeFontPadding: false');
    expect(reports).toContain('minHeight: 40, height: 40, alignItems: "center", justifyContent: "center"');
    expect(reports).toContain('lineHeight: 18, textAlign: "center", textAlignVertical: "center", includeFontPadding: false');
    expect(reports).toContain('visibleSegments.map((s)');
    expect(reports).toContain('Summary');
    expect(reports).toContain('P&L');
    expect(reports).toContain('Balance');
    expect(reports).toContain('Sales Reg');
    expect(reports).toContain('loadedQueryKey');
    expect(reports).toContain('if (loading || refreshing || !hasLoaded.current) return;');
    expect(reports).toContain('minWidth: 92');
    expect(reports).toContain('textAlign: "right"');
  });

  it('uses transparent inset accordion rows in both Settings surfaces', () => {
    const settings = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    for (const source of [settings, advanced]) {
      expect(source).toContain('paddingHorizontal: 0');
      expect(source).toContain('marginHorizontal: 0');
      expect(source).toContain('borderWidth: 0');
      expect(source).toContain('backgroundColor: "transparent"');
      expect(source).toContain('lineHeight: 18');
    }
  });
});
