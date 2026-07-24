import { Platform, Share } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Share plain text via native share sheet (WhatsApp/SMS/email).
 * On web, uses navigator.share() if available, else clipboard fallback.
 */
export async function sharePlainText(text: string, title = "Ledgr") {
  if (Platform.OS === "web") {
    try {
      if (typeof navigator !== "undefined" && (navigator as any).share) {
        await (navigator as any).share({ title, text });
        return;
      }
    } catch { /* user cancelled */ }
    // Fallback: copy to clipboard
    if (typeof navigator !== "undefined" && (navigator as any).clipboard) {
      await (navigator as any).clipboard.writeText(text);
      // eslint-disable-next-line no-alert
      window.alert("Copied to clipboard!\n\nPaste it in WhatsApp / email.");
    }
    return;
  }
  await Share.share({ message: text, title });
}

/**
 * Share a JSON payload as a file.
 * On web: triggers a browser download.
 * On mobile: writes to a temp file and opens the native share sheet.
 */
export async function shareJsonFile(filename: string, data: any) {
  const json = JSON.stringify(data, null, 2);

  if (Platform.OS === "web") {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    return;
  }

  const file = new File(Paths.cache, filename);
  try { file.create({ overwrite: true }); } catch { /* may already exist */ }
  file.write(json);
  const can = await Sharing.isAvailableAsync();
  if (can) {
    await Sharing.shareAsync(file.uri, { mimeType: "application/json", dialogTitle: filename });
  }
}

/**
 * Pick a JSON file from the device and return its parsed contents.
 * On web: uses <input type="file">.
 * On mobile: uses expo-document-picker.
 */
export async function pickJsonFile(): Promise<any | null> {
  if (Platform.OS === "web") {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = async (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return resolve(null);
        const text = await file.text();
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      };
      input.click();
    });
  }

  // Dynamic import to avoid loading on web
  const DocumentPicker = await import("expo-document-picker");
  const res = await DocumentPicker.getDocumentAsync({ type: "application/json", copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.[0]) return null;
  const uri = res.assets[0].uri;
  const file = new File(uri);
  const text = file.textSync();
  try { return JSON.parse(text); } catch { return null; }
}
