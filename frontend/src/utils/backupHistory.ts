import AsyncStorage from '@react-native-async-storage/async-storage';
import { activeBookId } from '@/src/db/backend';

export type BackupHistoryEntry = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  kind: 'encrypted_export' | 'restore';
  verified: boolean;
  fileName?: string;
  note?: string;
};

const MAX_BACKUP_HISTORY = 20;

function historyKey(bookId = activeBookId()): string {
  return `ledgr:backup_history:${bookId}`;
}

export async function listBackupHistory(bookId?: string): Promise<BackupHistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(historyKey(bookId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string').slice(0, MAX_BACKUP_HISTORY) : [];
  } catch {
    return [];
  }
}

export async function recordBackupHistory(entry: Omit<BackupHistoryEntry, 'id'> & { id?: string }, bookId?: string): Promise<BackupHistoryEntry[]> {
  const next: BackupHistoryEntry = { ...entry, id: entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  const history = await listBackupHistory(bookId);
  const updated = [next, ...history.filter((item) => item.id !== next.id)].slice(0, MAX_BACKUP_HISTORY);
  await AsyncStorage.setItem(historyKey(bookId), JSON.stringify(updated));
  return updated;
}

export async function clearBackupHistory(bookId?: string): Promise<void> {
  await AsyncStorage.removeItem(historyKey(bookId));
}

export function estimateJsonSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

export { MAX_BACKUP_HISTORY, historyKey as backupHistoryKey };
