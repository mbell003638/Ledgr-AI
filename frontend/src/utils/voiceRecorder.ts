import { AudioModule, setAudioModeAsync, type AudioRecorder } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

export type CapturedVoice = { audioBase64: string; mime: string };

/**
 * Starts a recorder without preparing an already-prepared expo-audio instance.
 * Stopped recorders remain usable, so only call prepare when canRecord is false.
 */
export async function startVoiceRecorder(recorder: AudioRecorder): Promise<void> {
  if (recorder.getStatus().isRecording || recorder.isRecording) {
    await recorder.stop().catch(() => {});
  }
  const permission = await AudioModule.requestRecordingPermissionsAsync();
  if (!permission.granted) throw new Error("Microphone permission is required to use voice entry.");
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  if (!recorder.getStatus().canRecord) await recorder.prepareToRecordAsync();
  recorder.record();
}

/** Stops the current recording and returns a provider-neutral base64 payload. */
export async function captureVoiceRecording(recorder: AudioRecorder): Promise<CapturedVoice> {
  if (recorder.getStatus().isRecording || recorder.isRecording) await recorder.stop();
  const uri = recorder.uri;
  if (!uri) throw new Error("No audio was captured. Try again.");

  if (Platform.OS === "web") {
    const response = await fetch(uri);
    const blob = await response.blob();
    const audioBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || "");
        const encoded = result.split(",")[1];
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
  };
}

/** Stops an active recorder during cancel, close, or unmount without surfacing cleanup errors. */
export async function cancelVoiceRecorder(recorder: AudioRecorder): Promise<void> {
  if (recorder.getStatus().isRecording || recorder.isRecording) await recorder.stop().catch(() => {});
}
