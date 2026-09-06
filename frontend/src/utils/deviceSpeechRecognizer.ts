/* eslint-disable @typescript-eslint/no-require-imports */
function nativeRuntime(): { NativeModules: Record<string, unknown>; Platform: { OS: string } } {
  try { return require('react-native'); } catch { return { NativeModules: {}, Platform: { OS: 'unknown' } }; }
}

export type DeviceSpeechStatus = {
  supported: boolean;
  available: boolean;
  reason?: string;
};

export type DeviceSpeechCallbacks = {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (error: { code?: string; message: string }) => void;
  onEnd?: () => void;
};

type NativeSpeechRecognizer = {
  isAvailable?: () => Promise<boolean> | boolean;
  start: (locale?: string, onDeviceOnly?: boolean) => Promise<void> | void;
  isOnDeviceAvailable?: () => Promise<boolean> | boolean;
  cancel?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  destroy?: () => Promise<void> | void;
  addListener?: (event: string, listener: (payload: any) => void) => { remove: () => void };
};

/**
 * Capability boundary for Android's device speech service.
 *
 * The native module is intentionally optional: Expo Go and web builds remain
 * usable, while a development/release build can provide `LedgrSpeechRecognizer`
 * without coupling the JS voice flow to a specific third-party package.
 */
function nativeModule(): NativeSpeechRecognizer | null {
  const { NativeModules, Platform } = nativeRuntime();
  if (Platform.OS !== "android") return null;
  try {
    return require('expo-modules-core').requireOptionalNativeModule("LedgrSpeechRecognizer")
      || (NativeModules as any).LedgrSpeechRecognizer
      || null;
  } catch { return (NativeModules as any).LedgrSpeechRecognizer || null; }
}

async function ensureMicrophonePermission(): Promise<void> {
  try {
    const audio = require('expo-audio');
    const permission = await audio.AudioModule?.requestRecordingPermissionsAsync?.();
    if (permission && !permission.granted) {
      throw new Error('Microphone permission is required for Android device recognition.');
    }
  } catch (error: any) {
    if (/permission/i.test(String(error?.message || error))) throw error;
  }
}

export async function getDeviceSpeechStatus(): Promise<DeviceSpeechStatus> {
  const { Platform } = nativeRuntime();
  const module = nativeModule();
  if (!module) {
    return {
      supported: Platform.OS === "android",
      available: false,
      reason: Platform.OS === "android"
        ? "Android device recognition is available in a native build only."
        : "Device speech recognition is supported only on Android.",
    };
  }
  try {
    const available = module.isAvailable ? await module.isAvailable() : true;
    return { supported: true, available, reason: available ? undefined : "No speech service is enabled on this device." };
  } catch {
    return { supported: true, available: false, reason: "Could not query the Android speech service." };
  }
}

export async function startDeviceSpeechRecognition(
  callbacks: DeviceSpeechCallbacks,
  options: { locale?: string; onDeviceOnly?: boolean } = {},
): Promise<() => Promise<void>> {
  const module = nativeModule();
  if (!module) {
    throw new Error("Android device recognition requires a native Ledgr build. Choose a cloud voice provider or install the native build.");
  }


  await ensureMicrophonePermission();

  const subscriptions = [
    module.addListener?.("partial", (payload) => callbacks.onPartial?.(String(payload?.text || payload || ""))),
    module.addListener?.("final", (payload) => callbacks.onFinal?.(String(payload?.text || payload || ""))),
    module.addListener?.("error", (payload) => callbacks.onError?.({ code: payload?.code, message: String(payload?.message || "Speech recognition failed.") })),
    module.addListener?.("end", () => callbacks.onEnd?.()),
  ].filter(Boolean) as { remove: () => void }[];

  try {
    await module.start(options.locale, options.onDeviceOnly === true);
  } catch (error: any) {
    subscriptions.forEach((subscription) => subscription.remove());
    const message = String(error?.message || error || "Could not start speech recognition.");
    throw new Error(/busy|already/i.test(message)
      ? "Voice recognition is already running. Stop it before trying again."
      : message);
  }

  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    try { await (module.stop ? module.stop() : module.cancel?.()); } finally {
      subscriptions.forEach((subscription) => subscription.remove());
    }
  };
}

export async function cancelDeviceSpeechRecognition(): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.cancel?.();
  await module.destroy?.();
}

export type DeviceSpeechErrorCode = 'UNAVAILABLE' | 'PERMISSION_DENIED' | 'NETWORK' | 'NO_RESULT' | 'CANCELLED' | 'BUSY' | 'UNKNOWN';
export class DeviceSpeechError extends Error { readonly code: DeviceSpeechErrorCode; constructor(code: DeviceSpeechErrorCode, message: string) { super(message); this.name = 'DeviceSpeechError'; this.code = code; } }
export type DeviceSpeechBridge = { isAvailable?: () => boolean | Promise<boolean>; startListening: (options?: { locale?: string; partialResults?: boolean; onDeviceOnly?: boolean }) => void | Promise<void>; stopListening?: () => void | Promise<void>; cancelListening?: () => void | Promise<void>; addListener: (event: 'partial' | 'result' | 'final' | 'error' | 'end', listener: (payload?: unknown) => void) => { remove: () => void } };
function deviceSpeechError(payload: unknown): DeviceSpeechError {
  const rawCode = String((payload as any)?.code || '').toUpperCase();
  const code: DeviceSpeechErrorCode = rawCode.includes('PERMISSION') ? 'PERMISSION_DENIED'
    : rawCode.includes('NETWORK') || rawCode.includes('SERVER') ? 'NETWORK'
      : rawCode.includes('NO_MATCH') || rawCode.includes('NO_RESULT') || rawCode.includes('TIMEOUT') ? 'NO_RESULT'
        : rawCode.includes('CANCEL') || rawCode.includes('CLIENT') ? 'CANCELLED'
          : rawCode.includes('BUSY') ? 'BUSY'
            : rawCode.includes('UNAVAILABLE') ? 'UNAVAILABLE' : 'UNKNOWN';
  const fallback = code === 'PERMISSION_DENIED' ? 'Microphone permission was denied.'
    : code === 'NETWORK' ? 'The speech recognition service is unavailable over the current network.'
      : code === 'NO_RESULT' ? 'No speech was detected.'
        : code === 'BUSY' ? 'Voice recognition is already running.'
          : code === 'CANCELLED' ? 'Voice input was cancelled.' : 'Speech recognition failed.';
  return new DeviceSpeechError(code, String((payload as any)?.message || fallback));
}
export function getDeviceSpeechBridge(): DeviceSpeechBridge | undefined {
  const injected = (globalThis as any).__LEDGR_DEVICE_SPEECH_RECOGNIZER__;
  if (injected && typeof injected.startListening === 'function' && typeof injected.addListener === 'function') return injected;
  const module = nativeModule();
  if (!module?.start || !module.addListener) return undefined;
  return {
    isAvailable: module.isAvailable,
    startListening: async (options) => {
      await ensureMicrophonePermission();
      await module.start(options?.locale, options?.onDeviceOnly === true);
    },
    stopListening: module.stop,
    cancelListening: module.cancel,
    addListener: (event, listener) => module.addListener!(event === 'result' ? 'final' : event, listener),
  };
}
export async function isDeviceSpeechAvailable(bridge = getDeviceSpeechBridge()): Promise<boolean> { if (!bridge) return (await getDeviceSpeechStatus()).available; try { return bridge.isAvailable ? await bridge.isAvailable() : true; } catch { return false; } }
export class DeviceSpeechSession {
  private settled = false; private removers: (() => void)[] = []; private resolvePromise!: (text: string) => void; private rejectPromise!: (error: DeviceSpeechError) => void;
  readonly promise: Promise<string>;
  constructor(private readonly bridge: DeviceSpeechBridge, options?: { locale?: string; onDeviceOnly?: boolean }) {
    this.promise = new Promise((resolve, reject) => { this.resolvePromise = resolve; this.rejectPromise = reject; });
    const sub = (event: any, fn: (payload?: unknown) => void) => { const x = this.bridge.addListener(event, fn); this.removers.push(() => x.remove()); };
    sub('partial', () => undefined); const finish = (p?: unknown) => { const t = typeof p === 'string' ? p : String((p as any)?.text || ''); if (t.trim()) { this.settled = true; this.cleanup(); this.resolvePromise(t.trim()); } };
    sub('result', finish); sub('final', finish); sub('error', (p) => { if (!this.settled) { this.settled = true; this.cleanup(); this.rejectPromise(deviceSpeechError(p)); } }); sub('end', () => { if (!this.settled) { this.settled = true; this.cleanup(); this.rejectPromise(new DeviceSpeechError('NO_RESULT', 'No speech was detected.')); } });
    Promise.resolve(this.bridge.startListening({ ...options, partialResults: true })).catch((error) => { if (!this.settled) { this.settled = true; this.cleanup(); this.rejectPromise(deviceSpeechError(error)); } });
  }
  async stop(): Promise<void> { await this.bridge.stopListening?.(); }
  cancel(): void { if (!this.settled) { void this.bridge.cancelListening?.(); this.settled = true; this.cleanup(); this.rejectPromise(new DeviceSpeechError('CANCELLED', 'Voice input was cancelled.')); } }
  private cleanup(): void { this.removers.splice(0).forEach((remove) => remove()); }
}
