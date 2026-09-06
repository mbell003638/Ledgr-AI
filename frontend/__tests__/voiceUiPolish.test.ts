import fs from 'fs';
import path from 'path';

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('voice UI contracts', () => {
  it('never hardcodes the light error surface into a themed screen', () => {
    // The palette already ships an errorBg for every theme; the pale pink
    // literal rendered as a light panel inside the dark app.
    for (const file of ['src/components/VoiceFab.tsx', 'app/voice.tsx', 'app/inventory-form.tsx']) {
      const source = read(file);
      expect(source).not.toContain('#FBE8E5');
      expect(source).not.toContain('#e3342f');
    }
    expect(read('app/voice.tsx')).toContain('backgroundColor: theme.color.errorBg');
    expect(read('src/components/VoiceFab.tsx')).toContain('theme.color.errorBg');
  });

  it('shows a clarification as a question rather than a failure', () => {
    const fab = read('src/components/VoiceFab.tsx');
    expect(fab).toContain('(createProposal || pendingClarification) ? "help-circle" : "alert-circle"');
  });

  it('stacks the party choices full width instead of squeezing them', () => {
    const fab = read('src/components/VoiceFab.tsx');
    expect(fab).toContain('stackedBtn');
    expect(fab).toContain('alignItems: "stretch"');
    expect(fab).toContain('continueDraft("supplier")');
    expect(fab).toContain('continueDraft("customer")');
  });

  it('reads its button text colour from the theme', () => {
    const fab = read('src/components/VoiceFab.tsx');
    const errorBlock = fab.slice(fab.indexOf('phase === "error" ? ('), fab.indexOf('</Animated.View>', fab.indexOf('phase === "error" ? (')));
    expect(errorBlock).toContain('theme.color.onBrandPrimary');
    expect(errorBlock).not.toContain('color: "#000"');
  });
});
