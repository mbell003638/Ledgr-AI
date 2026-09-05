import { storage } from '../utils/storage';
import {
  encryptPayload,
  decryptPayload,
  storeBookE2EEKey,
  deriveKeyFromPassphrase,
  type EncryptedEnvelope,
} from './e2ee';
import type { SyncOperation, SyncSnapshot } from './protocol';

export type CloudProviderType = 'google_drive' | 'icloud' | 'mock';

export type CloudDriveConfig = {
  provider: CloudProviderType;
  accountEmail?: string;
  accessToken?: string;
  passphrase?: string;
  autoSyncEnabled?: boolean;
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
  if (config.provider === 'mock') {
    return mockCloudStorage;
  }
  if (config.provider === 'google_drive' && config.accessToken) {
    return new GoogleDriveApiClient(config.accessToken);
  }
  // Default to mock if not live connected
  return mockCloudStorage;
}

export async function saveCloudConfig(bookId: string, config: CloudDriveConfig): Promise<void> {
  await storage.setItem(`${CLOUD_CONFIG_PREFIX}${bookId}`, JSON.stringify(config));
  if (config.passphrase) {
    const { key } = deriveKeyFromPassphrase(config.passphrase);
    await storeBookE2EEKey(bookId, key);
  }
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

export async function uploadEncryptedDelta(
  bookId: string,
  sequence: number,
  operation: SyncOperation,
  client: ICloudStorageClient,
  key: Uint8Array
): Promise<string> {
  const envelope = encryptPayload(operation, key);
  const filename = `ledgr_${bookId}_delta_${String(sequence).padStart(8, '0')}.enc`;
  return await client.uploadFile('appDataFolder', filename, JSON.stringify(envelope));
}

export async function fetchRemoteEncryptedDeltas(
  bookId: string,
  sinceSequence: number,
  client: ICloudStorageClient,
  key: Uint8Array
): Promise<SyncOperation[]> {
  const files = await client.listFiles('appDataFolder');
  const prefix = `ledgr_${bookId}_delta_`;

  const deltaFiles = files
    .filter((f) => f.name.startsWith(prefix) && f.name.endsWith('.enc'))
    .map((f) => {
      const seqStr = f.name.slice(prefix.length, f.name.length - 4);
      const seq = parseInt(seqStr, 10);
      return { ...f, sequence: seq };
    })
    .filter((f) => !isNaN(f.sequence) && f.sequence > sinceSequence)
    .sort((a, b) => a.sequence - b.sequence);

  const operations: SyncOperation[] = [];
  for (const file of deltaFiles) {
    const rawContent = await client.downloadFile(file.id);
    const envelope = JSON.parse(rawContent) as EncryptedEnvelope;
    const op = decryptPayload<SyncOperation>(envelope, key);
    operations.push(op);
  }

  return operations;
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
