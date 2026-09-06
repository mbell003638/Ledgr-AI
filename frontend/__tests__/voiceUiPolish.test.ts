import fs from 'fs';
import path from 'path';

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('voice and capability UI contracts', () => {
  it('re-reads the AI capability on focus so the mic appears without a restart', () => {
    const fab = read('src/components/VoiceFab.tsx');
    // The dock lives in the tab layout and stays mounted while the user visits
    // Workspace capabilities, so a mount-only read left the mic hidden until
    // the app was restarted.
    expect(fab).toContain('useFocusEffect');
    expect(fab).toContain('isCapabilityEnabled(settings, "ai_assistant")');
    expect(fab).not.toContain(`api.getSettings().then((settings) => { if (active) setVoiceAvailable`);
  });

  it('answers the unknown-party question with one tap', () => {
    const fab = read('src/components/VoiceFab.tsx');
    expect(fab).toContain('testID="voice-fab-create-supplier"');
    expect(fab).toContain('testID="voice-fab-create-customer"');
    expect(fab).toContain('testID="voice-fab-submit-clarification"');
    expect(fab).toContain('pendingClarification?.missingField === "party_role"');
    // "supplier"/"customer" are the words the parser understands.
    expect(fab).toContain('answerClarification("supplier")');
    expect(fab).toContain('answerClarification("customer")');
  });

  it('shows a clarification as a question rather than a failure', () => {
    const fab = read('src/components/VoiceFab.tsx');
    expect(fab).toContain('pendingClarification ? "help-circle-outline" : "alert-circle-outline"');
  });

  it('never hardcodes the light error surface into a themed screen', () => {
    for (const file of ['src/components/VoiceFab.tsx', 'app/voice.tsx', 'app/inventory-form.tsx']) {
      expect(read(file)).not.toContain('#FBE8E5');
    }
    expect(read('app/voice.tsx')).toContain('backgroundColor: theme.color.errorBg');
  });

  it('marks always-on capabilities with a badge instead of a dead toggle', () => {
    const customize = read('app/customize-features.tsx');
    expect(customize).toContain('lockPill');
    expect(customize).toContain('{core ? "Always on" : "Required"}');
    expect(customize).toContain('accessibilityRole={locked ? undefined : "switch"}');
  });
});
