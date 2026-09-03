import { AudioModule, setAudioModeAsync, type AudioRecorder } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { runWithSystemPrompt } from "@/src/utils/systemPrompt";

export type CapturedVoice = { audioBase64: string; mime: string; uploadUri?: string };

const recorderTails = new WeakMap<object, Promise<void>>();
const pendingStarts = new WeakMap<object, Promise<void>>();

function recorderIsRecording(recorder: AudioRecorder): boolean {
  return recorder.getStatus().isRecording || recorder.isRecording;
}

function alreadyPreparedMessage(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as { message?: unknown; cause?: { message?: unknown } } : null;
  const text = [record?.message, record?.cause?.message, String(error ?? "")].join(" ");
  return /already been prepared|already prepared|current session before preparing/i.test(text);
}

/** Maps Expo/Hermes recorder failures to a short, actionable message. */
export function friendlyVoiceError(error: unknown, fallback = "Voice processing failed"): string {
  const record = error && typeof error === "object" ? error as { message?: unknown; cause?: { message?: unknown } } : null;
  const text = [record?.message, record?.cause?.message, String(error ?? "")].join(" ");
  if (alreadyPreparedMessage(error) || /prepareToRecordAsync/i.test(text)) {
    return "The microphone was still finishing the last take. Tap Try Again.";
  }
  if (/ArrayBuffer|ArrayBufferView|blobs from/i.test(text)) {
    return "This phone cannot upload the recording that way. Use Android device speech, or try again.";
  }
  const message = typeof record?.message === "string" && record.message.trim() ? record.message : fallback;
  return message;
}

function runExclusive<T>(recorder: AudioRecorder, operation: () => Promise<T>): Promise<T> {
  const key = recorder as object;
  const previous = recorderTails.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  recorderTails.set(key, tail);
  return current.finally(() => {
    if (recorderTails.get(key) === tail) recorderTails.delete(key);
  });
}

/**
 * Starts recording once even when two UI events arrive before permission or
 * preparation finishes. Expo can retain a prepared recorder after stop, so a
 * second prepare call must be avoided.
 */
export function startVoiceRecorder(recorder: AudioRecorder): Promise<void> {
  const key = recorder as object;
  const existing = pendingStarts.get(key);
  if (existing) return existing;

  const start = runExclusive(recorder, async () => {
    if (recorderIsRecording(recorder)) return;
    const permission = await runWithSystemPrompt(() => AudioModule.requestRecordingPermissionsAsync());
    if (!permission.granted) throw new Error("Microphone access is required to use the voice assistant.");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    if (!recorder.getStatus().canRecord) {
      try {
        await recorder.prepareToRecordAsync();
      } catch (error: any) {
        if (!alreadyPreparedMessage(error)) throw error;
        try { await recorder.stop(); } catch { /* already idle; skip a second prepare */ }
      }
    }
    if (!recorderIsRecording(recorder)) recorder.record();
  });

  pendingStarts.set(key, start);
  return start.finally(() => {
    if (pendingStarts.get(key) === start) pendingStarts.delete(key);
  });
}

/** Stops the recording and returns both cross-provider base64 and a native upload URI. */
export function captureVoiceRecording(recorder: AudioRecorder): Promise<CapturedVoice> {
  return runExclusive(recorder, async () => {
    if (recorderIsRecording(recorder)) await recorder.stop();
    const uri = recorder.uri;
    if (!uri) throw new Error("No audio was captured. Try again.");

    if (Platform.OS === "web") {
      const response = await fetch(uri);
      const blob = await response.blob();
      const audioBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const encoded = String(reader.result || "").split(",")[1];
          if (encoded) resolve(encoded);
          else reject(new Error("Could not read the recorded audio."));
        };
        reader.onerror = () => reject(new Error("Could not read the recorded audio."));
        reader.readAsDataURL(blob);
      });
      return { audioBase64, mime: "audio/webm" };
    }

    return {
      audioBase64: await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
      mime: "audio/m4a",
      uploadUri: uri,
    };
  });
}

/** Stops an active recorder during cancel, close, or unmount without surfacing cleanup errors. */
export function cancelVoiceRecorder(recorder: AudioRecorder): Promise<void> {
  return runExclusive(recorder, async () => {
    if (recorderIsRecording(recorder)) await recorder.stop().catch(() => {});
  });
}
