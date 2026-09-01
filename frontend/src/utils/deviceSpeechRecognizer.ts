import { NativeModules, Platform } from "react-native";

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
  start: (locale?: string) => Promise<void> | void;
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
  if (Platform.OS !== "android") return null;
  return (NativeModules as any).LedgrSpeechRecognizer || null;
}

export async function getDeviceSpeechStatus(): Promise<DeviceSpeechStatus> {
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
  options: { locale?: string } = {},
): Promise<() => Promise<void>> {
  const module = nativeModule();
  if (!module) {
    throw new Error("Android device recognition requires a native Ledgr build. Choose a cloud voice provider or install the native build.");
  }

  const subscriptions = [
    module.addListener?.("partial", (payload) => callbacks.onPartial?.(String(payload?.text || payload || ""))),
    module.addListener?.("final", (payload) => callbacks.onFinal?.(String(payload?.text || payload || ""))),
    module.addListener?.("error", (payload) => callbacks.onError?.({ code: payload?.code, message: String(payload?.message || "Speech recognition failed.") })),
    module.addListener?.("end", () => callbacks.onEnd?.()),
  ].filter(Boolean) as { remove: () => void }[];

  try {
    await module.start(options.locale);
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
