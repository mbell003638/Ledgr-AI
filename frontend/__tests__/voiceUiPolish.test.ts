import fs from 'fs';
import path from 'path';

const read = (relative: string) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

const CALLERS = ['app/voice.tsx', 'src/components/VoiceFab.tsx'];

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

  it('keeps speech on the phone when the user chose On-device only', () => {
    const recognizer = read('src/utils/deviceSpeechRecognizer.ts');
    const kotlin = read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrSpeechRecognizerModule.kt');
    // EXTRA_PREFER_OFFLINE is only a hint; Google's recognizer falls back to
    // its cloud service (and its consent prompt) when the offline language
    // pack is missing. The API 31 recognizer has no cloud path at all.
    expect(kotlin).toContain('createOnDeviceSpeechRecognizer');
    expect(kotlin).toContain('isOnDeviceRecognitionAvailable');
    expect(kotlin).toContain('onDeviceOnly: Boolean?');
    expect(recognizer).toContain('options.onDeviceOnly === true');
    for (const file of CALLERS) {
      expect(read(file)).toContain('onDeviceOnly: isOnDeviceInterpretation(');
    }
  });
});
