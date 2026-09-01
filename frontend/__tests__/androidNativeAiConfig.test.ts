import fs from 'fs';
import path from 'path';
import { parseExternalIntent } from '../src/utils/externalIntent';

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
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrSpeechRecognizerModule.kt')).toContain('SpeechRecognizer.createSpeechRecognizer');
    expect(read('modules/ledgr-native-ai/android/src/main/java/expo/modules/ledgrnativeai/LedgrLocalOcrModule.kt')).toContain('TextRecognition.getClient');
  });

  it('parses Assistant navigation and draft URLs into review-only intents', () => {
    expect(parseExternalIntent('ledgr://assistant?action=open_voice')).toEqual({ target: 'voice', source: 'assistant' });
    expect(parseExternalIntent('ledgr://assistant?action=record_payment&amount=100&counterparty=Amit')).toMatchObject({
      target: 'draft', action: 'payment', amount: 100, party: 'Amit', source: 'assistant',
    });
  });

  it('persists OCR mode and routes image URIs through local OCR', () => {
    const api = read('src/api.ts');
    const scan = read('app/scan-import.tsx');
    expect(api).toContain("AI_OCR_PROVIDER_KEY = 'ai_ocr_provider'");
    expect(api).toContain('recognizeLocalOcr(input.uri!)');
    expect(scan).toContain('uri: asset.uri');
  });
});
