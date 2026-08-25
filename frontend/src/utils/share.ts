import { Platform, Share } from "react-native";
import { File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
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
 * Save a JSON backup without opening a share sheet.
 * Web downloads to the browser's configured download folder. Android uses the
 * system folder picker so the user chooses durable external storage. iOS saves
 * inside Ledgr's app documents; the Share action can then export it elsewhere.
 */
export async function saveJsonFile(filename: string, data: any): Promise<{ uri: string; destination: "download" | "folder" | "app-documents" }> {
  const json = JSON.stringify(data, null, 2);

  if (Platform.OS === "web") {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }, 100);
    return { uri: filename, destination: "download" };
  }

  if (Platform.OS === "android") {
    const access = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!access.granted) throw new Error("Choose a folder to save the backup, or cancel and use Share instead.");
    const uri = await FileSystem.StorageAccessFramework.createFileAsync(access.directoryUri, filename, "application/json");
    await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
    return { uri, destination: "folder" };
  }

  const directory = FileSystem.documentDirectory;
  if (!directory) throw new Error("This device did not provide a local documents folder. Use Share instead.");
  const uri = `${directory}${filename}`;
  await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
  return { uri, destination: "app-documents" };
}

/**
 * Discriminated result for pickJsonFile so callers can tell a user CANCEL apart
 * from an UNREADABLE / CORRUPTED file. [M1]
 *   - { ok: true, data }        → a JSON file was picked and parsed
 *   - { ok: false, reason: 'cancelled' } → user dismissed the picker (silent)
 *   - { ok: false, reason: 'invalid' }   → file couldn't be read or wasn't valid
 *                                          JSON (e.g. a truncated WhatsApp transfer)
 */
export type PickJsonResult =
  | { ok: true; data: any }
  | { ok: false; reason: "cancelled" | "invalid" };

/**
 * Pick a JSON file from the device and return its parsed contents.
 * On web: uses <input type="file">.
 * On mobile: uses expo-document-picker.
 *
 * Previously this resolved `null` for BOTH cancel and parse failure, so a
 * corrupted backup silently no-op'd. It now returns a discriminated result. [M1]
 */
export async function pickJsonFile(): Promise<PickJsonResult> {
  if (Platform.OS === "web") {
    return new Promise<PickJsonResult>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.onchange = async (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return resolve({ ok: false, reason: "cancelled" });
        try {
          const text = await file.text();
          resolve({ ok: true, data: JSON.parse(text) });
        } catch {
          resolve({ ok: false, reason: "invalid" });
        }
      };
      // If the dialog is dismissed without choosing a file, onchange never fires
      // on most browsers; that's an acceptable silent no-op (matches cancel).
      input.click();
    });
  }

  // Dynamic import to avoid loading on web
  const DocumentPicker = await import("expo-document-picker");
  const res = await DocumentPicker.getDocumentAsync({ type: "application/json", copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.[0]) return { ok: false, reason: "cancelled" };
  try {
    const uri = res.assets[0].uri;
    const file = new File(uri);
    const text = file.textSync();
    return { ok: true, data: JSON.parse(text) };
  } catch {
    // File read failure or invalid JSON — a truncated/corrupted transfer.
    return { ok: false, reason: "invalid" };
  }
}
