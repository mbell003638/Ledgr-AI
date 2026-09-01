import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Android native AI integration', () => {
  it('registers speech and OCR Expo modules with the ML Kit dependency', () => {
    const config = JSON.parse(read('modules/ledgr-native-ai/expo-module.config.json'));
    expect(config.android.modules).toEqual(expect.arrayContaining([
      'expo.modules.ledgrnativeai.LedgrSpeechRecognizerModule',
      'expo.modules.ledgrnativeai.LedgrLocalOcrModule',
    ]));
    expect(read('modules/ledgr-native-ai/android/build.gradle')).toContain("com.google.mlkit:text-recognition");
    const speechModule = read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrSpeechRecognizerModule.kt');
    expect(speechModule).toContain('SpeechRecognizer.createSpeechRecognizer');
    expect(speechModule).toContain('this@LedgrSpeechRecognizerModule');
    expect(speechModule).not.toContain('setRecognitionListener(this)');
    expect(speechModule).not.toContain('\\n');
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrLocalOcrModule.kt')).toContain('TextRecognition.getClient');
  });

  it('generates shortcuts metadata and bounded Assistant action URLs', () => {
    const plugin = read('plugins/withAndroidAssistant.js');
    expect(plugin).toContain('android.app.shortcuts');
    expect(plugin).toContain('record_payment');
    expect(plugin).toContain('record_expense');
    expect(plugin).toContain('record_receipt');
    expect(plugin).toContain('add_capital');
    expect(plugin).toContain('open_voice');
    expect(plugin).toContain('withStringsXml');
    expect(plugin).toContain('android:shortcutShortLabel="@string/ledgr_shortcut_ask_ai"');
    expect(plugin).toContain('android:shortcutShortLabel="@string/ledgr_shortcut_voice_assistant"');
    expect(plugin).toContain('android:shortcutShortLabel="@string/ledgr_shortcut_scan_receipt"');
    expect(plugin).not.toMatch(/android:shortcutShortLabel="(?!@string\/)/);
  });

  it('persists OCR mode and routes image URIs through local OCR', () => {
    const api = read('src/api.ts');
    const scan = read('app/scan-import.tsx');
    expect(api).toContain("AI_OCR_PROVIDER_KEY = 'ai_ocr_provider'");
    expect(api).toContain('recognizeLocalOcr(input.uri!)');
    expect(scan).toContain('uri: asset.uri');
  });
});

