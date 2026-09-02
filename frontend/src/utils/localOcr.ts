/* eslint-disable @typescript-eslint/no-require-imports */
function nativeRuntime(): { NativeModules: Record<string, unknown>; Platform: { OS: string } } {
  try { return require('react-native'); } catch { return { NativeModules: {}, Platform: { OS: 'unknown' } }; }
}

export type LocalOcrStatus = { supported: boolean; available: boolean; reason?: string };
type NativeLocalOcr = {
  isAvailable?: () => boolean | Promise<boolean>;
  recognize: (uri: string, language?: string) => string | Promise<string>;
  recognizePdf?: (uri: string, maxPages?: number) => string | Promise<string>;
};

function nativeModule(): NativeLocalOcr | null {
  const { NativeModules, Platform } = nativeRuntime();
  if (Platform.OS !== 'android') return null;
  try {
    return require('expo-modules-core').requireOptionalNativeModule('LedgrLocalOcr')
      || (NativeModules as any).LedgrLocalOcr
      || null;
  } catch { return (NativeModules as any).LedgrLocalOcr || null; }
}

/** Optional native OCR boundary; extracted text must still pass scan/import review. */
export async function getLocalOcrStatus(): Promise<LocalOcrStatus> {
  const { Platform } = nativeRuntime();
  const module = nativeModule();
  if (!module) return { supported: Platform.OS === 'android', available: false, reason: Platform.OS === 'android' ? 'Local OCR is available in a native build only.' : 'Local OCR is supported only on Android.' };
  try {
    const available = module.isAvailable ? await module.isAvailable() : true;
    return { supported: true, available, reason: available ? undefined : 'No local OCR engine is enabled on this device.' };
  } catch { return { supported: true, available: false, reason: 'Could not query the local OCR engine.' }; }
}

export async function recognizeLocalOcr(uri: string, language?: string): Promise<string> {
  if (!uri.trim()) throw new Error('A receipt image is required for local OCR.');
  const module = nativeModule();
  if (!module) throw new Error('Local OCR requires an Android native build. Choose a configured vision provider instead.');
  const looksPdf = /\.pdf($|\?)/i.test(uri) || uri.toLowerCase().includes('application/pdf');
  const text = looksPdf && module.recognizePdf
    ? await module.recognizePdf(uri, 8)
    : await module.recognize(uri, language);
  if (!String(text || '').trim()) throw new Error('Local OCR did not detect readable text.');
  return String(text).trim();
}
