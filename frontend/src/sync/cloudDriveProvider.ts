import { storage } from '../utils/storage';
import {
  encryptPayload,
  decryptPayload,
  storeBookE2EEKey,
  deriveKeyFromPassphrase,
  bytesToBase64,
  base64ToBytes,
  type EncryptedEnvelope,
} from './e2ee';
import type { SyncOperation, SyncSnapshot } from './protocol';

export type CloudProviderType = 'google_drive' | 'mock';

export type CloudDriveConfig = {
  provider: CloudProviderType;
  accountEmail?: string;
  accessToken?: string;
  passphrase?: string;
  autoSyncEnabled?: boolean;
  /**
   * Base64 salt this book's key was derived with. PBKDF2 with a fresh random
   * salt gives a different key every call, so without keeping it a second
   * device entering the same passphrase derives a key that cannot decrypt
   * anything the first device wrote.
   */
  keySalt?: string;
};

export type CloudDriveStatus = {
  provider: CloudProviderType;
  configured: boolean;
  authenticated: boolean;
  accountEmail?: string;
  lastSyncAt?: string;
  lastError?: string;
  remoteSequence: number;
};

const CLOUD_CONFIG_PREFIX = 'ledgr:sync:cloud:config:';

// In-memory / Mock storage adapter to enable unit tests and offline testing
export interface ICloudStorageClient {
  listFiles(folder: string): Promise<{ id: string; name: string; modifiedTime: string }[]>;
  uploadFile(folder: string, filename: string, content: string): Promise<string>;
  downloadFile(fileIdOrName: string): Promise<string>;
  deleteFile(fileIdOrName: string): Promise<void>;
}

class MockCloudStorageClient implements ICloudStorageClient {
  private files = new Map<string, string>();

  async listFiles(_folder: string): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const results: { id: string; name: string; modifiedTime: string }[] = [];
    for (const name of this.files.keys()) {
      results.push({ id: name, name, modifiedTime: new Date().toISOString() });
    }
    return results;
  }

  async uploadFile(_folder: string, filename: string, content: string): Promise<string> {
    this.files.set(filename, content);
    return filename;
  }

  async downloadFile(filename: string): Promise<string> {
    const content = this.files.get(filename);
    if (!content) throw new Error(`File not found: ${filename}`);
    return content;
  }

  async deleteFile(filename: string): Promise<void> {
    this.files.delete(filename);
  }

  clear() {
    this.files.clear();
  }
}

export const mockCloudStorage = new MockCloudStorageClient();

// Google Drive AppData Folder API client
class GoogleDriveApiClient implements ICloudStorageClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
  }

  async listFiles(): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const q = encodeURIComponent("'appDataFolder' in parents and trashed = false");
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Google Drive list failed: ${res.statusText}`);
    const data = await res.json() as { files?: { id: string; name: string; modifiedTime: string }[] };
    return data.files || [];
  }

  async uploadFile(_folder: string, filename: string, content: string): Promise<string> {
    // Multipart upload to appDataFolder
    const metadata = JSON.stringify({
      name: filename,
      parents: ['appDataFolder'],
    });
    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      metadata +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      content +
      closeDelimiter;

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    });
    if (!res.ok) throw new Error(`Google Drive upload failed: ${res.statusText}`);
    const data = await res.json() as { id: string };
    return data.id;
  }

  async downloadFile(fileId: string): Promise<string> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Google Drive download failed: ${res.statusText}`);
    return await res.text();
  }

  async deleteFile(fileId: string): Promise<void> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Google Drive delete failed: ${res.statusText}`);
  }
}

export function getStorageClient(config: CloudDriveConfig): ICloudStorageClient {
  if (config.provider === 'mock') return mockCloudStorage;
  if (config.provider === 'google_drive') {
    if (!config.accessToken) throw new Error('Reconnect the Google account to sync: this device has no valid access token.');
    return new GoogleDriveApiClient(config.accessToken);
  }
  // Falling back to the in-memory mock here would report a successful sync
  // while writing to a store that disappears with the process. An expired
  // token or an unsupported provider has to surface, not silently discard
  // the book.
  throw new Error(`Cloud sync provider "${config.provider}" is not available on this device.`);
}

export async function saveCloudConfig(bookId: string, config: CloudDriveConfig): Promise<void> {
  let stored = config;
  if (config.passphrase) {
    // Reuse the book's existing salt when there is one, so re-entering the
    // passphrase on this device reproduces the same key rather than orphaning
    // everything already uploaded.
    const existingSalt = config.keySalt ? base64ToBytes(config.keySalt) : undefined;
    const { key, salt } = deriveKeyFromPassphrase(config.passphrase, existingSalt);
    await storeBookE2EEKey(bookId, key);
    stored = { ...config, keySalt: bytesToBase64(salt) };
  }
  await storage.setItem(`${CLOUD_CONFIG_PREFIX}${bookId}`, JSON.stringify(stored));
}

/**
 * Re-derives this book's key on a device that has the passphrase but not the
 * key: the salt travels in plaintext beside the ciphertext, which is what a
 * salt is for, so a second device can join with the passphrase alone.
 */
export async function adoptRemoteKey(bookId: string, passphrase: string, client: ICloudStorageClient): Promise<Uint8Array | null> {
  const files = await client.listFiles('appDataFolder');
  const prefix = `ledgr_${bookId}_`;
  for (const file of files.filter((row) => row.name.startsWith(prefix) && row.name.endsWith('.enc'))) {
    try {
      const envelope = JSON.parse(await client.downloadFile(file.id)) as EncryptedEnvelope;
      if (!envelope.salt) continue;
      const { key } = deriveKeyFromPassphrase(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
      // Prove the passphrase before adopting the key, so a typo fails here
      // rather than silently writing undecryptable deltas later.
      decryptPayload(envelope, key);
      await storeBookE2EEKey(bookId, key);
      const config = await getCloudConfig(bookId);
      if (config) await storage.setItem(`${CLOUD_CONFIG_PREFIX}${bookId}`, JSON.stringify({ ...config, keySalt: envelope.salt }));
      return key;
    } catch { /* wrong passphrase or unreadable file: keep looking */ }
  }
  return null;
}

export async function getCloudConfig(bookId: string): Promise<CloudDriveConfig | null> {
  const raw = await storage.getItem<string | null>(`${CLOUD_CONFIG_PREFIX}${bookId}`, null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CloudDriveConfig;
  } catch {
    return null;
  }
}

export function deltaFilename(bookId: string, deviceId: string, sequence: number): string {
  // The device id is part of the name because two devices reach the same
  // sequence number independently. Sharing a name let one device's operation
  // hide another's: both files existed, but the cursor moved past the pair
  // after reading one, and the other was never applied.
  const safeDevice = String(deviceId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return `ledgr_${bookId}_${safeDevice}_delta_${String(sequence).padStart(8, '0')}.enc`;
}

export async function uploadEncryptedDelta(
  bookId: string,
  sequence: number,
  operation: SyncOperation,
  client: ICloudStorageClient,
  key: Uint8Array,
  saltBytes?: Uint8Array
): Promise<string> {
  const envelope = encryptPayload(operation, key, saltBytes);
  const filename = deltaFilename(bookId, operation.deviceId, sequence);
  return await client.uploadFile('appDataFolder', filename, JSON.stringify(envelope));
}

/**
 * Reads every device's deltas and returns them in a deterministic order.
 *
 * The cursor is kept per device rather than as one number for the whole book:
 * devices number their operations independently, so a single cursor advanced
 * past one device's sequence 5 would permanently skip every other device's
 * sequence 5. Ordering falls back to (clientCreatedAt, deviceId,
 * deviceSequence), which is unique and identical on every device, so all
 * devices converge on the same history without a server to arbitrate.
 */
export async function fetchRemoteEncryptedDeltas(
  bookId: string,
  since: number | Record<string, number>,
  client: ICloudStorageClient,
  key: Uint8Array
): Promise<SyncOperation[]> {
  const files = await client.listFiles('appDataFolder');
  const prefix = `ledgr_${bookId}_`;
  const cursors: Record<string, number> = typeof since === 'number' ? {} : (since || {});
  const floor = typeof since === 'number' ? since : 0;

  const candidates = files
    .filter((f) => f.name.startsWith(prefix) && f.name.includes('_delta_') && f.name.endsWith('.enc'))
    .map((f) => {
      const rest = f.name.slice(prefix.length, f.name.length - 4);
      const marker = rest.lastIndexOf('_delta_');
      if (marker < 0) return null;
      const deviceId = rest.slice(0, marker);
      const sequence = parseInt(rest.slice(marker + '_delta_'.length), 10);
      if (!deviceId || Number.isNaN(sequence)) return null;
      return { ...f, deviceId, sequence };
    })
    .filter((f): f is { id: string; name: string; modifiedTime: string; deviceId: string; sequence: number } => f !== null)
    .filter((f) => f.sequence > Math.max(floor, cursors[f.deviceId] ?? 0));

  const operations: SyncOperation[] = [];
  for (const file of candidates) {
    try {
      const envelope = JSON.parse(await client.downloadFile(file.id)) as EncryptedEnvelope;
      operations.push(decryptPayload<SyncOperation>(envelope, key));
    } catch {
      // A single unreadable delta must not strand every later one; it is
      // skipped and will be retried on the next pull.
    }
  }

  return operations.sort((a, b) => (
    a.clientCreatedAt.localeCompare(b.clientCreatedAt)
    || a.deviceId.localeCompare(b.deviceId)
    || a.deviceSequence - b.deviceSequence
  ));
}

/** Highest sequence seen per device, for use as the next pull cursor. */
export function cursorsFromOperations(
  operations: SyncOperation[],
  previous: Record<string, number> = {},
): Record<string, number> {
  const next = { ...previous };
  for (const operation of operations) {
    next[operation.deviceId] = Math.max(next[operation.deviceId] ?? 0, operation.deviceSequence);
  }
  return next;
}

export async function uploadEncryptedSnapshot(
  bookId: string,
  snapshot: SyncSnapshot,
  client: ICloudStorageClient,
  key: Uint8Array
): Promise<string> {
  const envelope = encryptPayload(snapshot, key);
  const filename = `ledgr_${bookId}_snapshot_${snapshot.bookEpoch}.enc`;
  return await client.uploadFile('appDataFolder', filename, JSON.stringify(envelope));
}

export async function downloadEncryptedSnapshot(
  bookId: string,
  epoch: string,
  client: ICloudStorageClient,
  key: Uint8Array
): Promise<SyncSnapshot | null> {
  const filename = `ledgr_${bookId}_snapshot_${epoch}.enc`;
  const files = await client.listFiles('appDataFolder');
  const match = files.find((f) => f.name === filename);
  if (!match) return null;

  const rawContent = await client.downloadFile(match.id);
  const envelope = JSON.parse(rawContent) as EncryptedEnvelope;
  return decryptPayload<SyncSnapshot>(envelope, key);
}
