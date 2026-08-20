import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { exportBackup, importBackup } from '@/src/db/local';
import { activeSqlRunner } from '@/src/db/backend';
import { V2AppService } from '../appService';

type SyncStatus = 'never' | 'synced' | 'offline' | 'conflict' | 'error';

type SyncConfig = {
  enabled: boolean;
  baseUrl: string;
  workspaceId: string;
  deviceId: string;
  hasToken: boolean;
  autoSync: boolean;
};

type SyncState = SyncConfig & {
  provider: 'self_hosted';
  etag: string | null;
  lastLocalHash: string | null;
  lastSyncAt: string | null;
  status: SyncStatus;
  lastError: string | null;
};

type StoredConfig = {
  enabled?: boolean;
  baseUrl?: string;
  workspaceId?: string;
  deviceId?: string;
  autoSync?: boolean;
};

type FetchLike = typeof fetch;

const PROVIDER = 'self_hosted';
const KIND = 'ledger_sync';
const TOKEN_PREFIX = 'ledgr.self-hosted-sync.token.';
const DEVICE_PREFIX = 'ledgr.self-hosted-sync.device.';

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function now(): string { return new Date().toISOString(); }
function cleanUrl(value: string): string { return String(value || '').trim().replace(/\/+$/, ''); }
function json(value: unknown): string { return JSON.stringify(value ?? {}); }
function parseJson<T>(value: unknown, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) as T : (value as T) || fallback; } catch { return fallback; }
}

/** Stable non-secret fingerprint used for optimistic concurrency, not authentication. */
export function snapshotFingerprint(snapshot: unknown): string {
  const source = JSON.stringify(snapshot);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function validateBaseUrl(baseUrl: string): string {
  const normalized = cleanUrl(baseUrl);
  if (!/^https?:\/\//i.test(normalized)) throw new Error('Self-host sync URL must start with http:// or https://. Use https:// outside a trusted local network.');
  return normalized;
}

async function secureGet(key: string): Promise<string | null> {
  try {
    const secure = await SecureStore.getItemAsync(key);
    if (secure) return secure;
  } catch { /* web and unsupported devices fall back to local browser storage */ }
  try { return await AsyncStorage.getItem(key); } catch { return null; }
}

async function secureSet(key: string, value: string): Promise<boolean> {
  try { await SecureStore.setItemAsync(key, value); return true; } catch { /* use browser storage when device secure storage is unavailable */ }
  try { await AsyncStorage.setItem(key, value); return true; } catch { return false; }
}

async function getContext() {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('Self-host sync requires SQLite storage.');
  const context = await new V2AppService(runner).activeContext();
  if (!context) throw new Error('No active versioned V2 book is available for sync.');
  return { runner, context };
}

async function deviceIdFor(bookId: string, configured?: string): Promise<string> {
  if (configured?.trim()) return configured.trim();
  const key = `${DEVICE_PREFIX}${bookId}`;
  const existing = await secureGet(key);
  if (existing) return existing;
  const created = uid('device');
  await secureSet(key, created);
  return created;
}

async function integrationRow(runner: any, bookId: string): Promise<any | null> {
  return runner.first('SELECT * FROM v2_integrations WHERE book_id=? AND provider=? AND kind=?', [bookId, PROVIDER, KIND]);
}

async function syncStateRow(runner: any, bookId: string): Promise<any | null> {
  return runner.first('SELECT * FROM v2_sync_state WHERE book_id=? AND provider=?', [bookId, PROVIDER]);
}

async function readConfig(runner: any, bookId: string): Promise<{ row: any | null; config: StoredConfig; token: string | null; deviceId: string }> {
  const row = await integrationRow(runner, bookId);
  const config = parseJson<StoredConfig>(row?.config, {});
  const deviceId = await deviceIdFor(bookId, config.deviceId);
  const token = await secureGet(`${TOKEN_PREFIX}${bookId}`);
  return { row, config, token, deviceId };
}

async function writeState(runner: any, bookId: string, state: Partial<{ remoteBookId: string; deviceId: string; etag: string | null; lastLocalHash: string | null; lastSyncAt: string | null; status: SyncStatus; lastError: string | null; conflictPayload: Record<string, unknown> }>): Promise<void> {
  const existing = await syncStateRow(runner, bookId);
  const timestamp = now();
  const id = existing?.id || uid('sync_state');
  const remoteBookId = state.remoteBookId ?? existing?.remote_book_id ?? bookId;
  const deviceId = state.deviceId ?? existing?.device_id ?? uid('device');
  await runner.run(`INSERT INTO v2_sync_state(id,book_id,provider,remote_book_id,device_id,etag,last_local_hash,last_sync_at,status,last_error,conflict_payload,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(book_id,provider) DO UPDATE SET remote_book_id=excluded.remote_book_id,device_id=excluded.device_id,etag=excluded.etag,last_local_hash=excluded.last_local_hash,last_sync_at=excluded.last_sync_at,status=excluded.status,last_error=excluded.last_error,conflict_payload=excluded.conflict_payload,updated_at=excluded.updated_at`, [
    id, bookId, PROVIDER, remoteBookId, deviceId, state.etag ?? existing?.etag ?? null, state.lastLocalHash ?? existing?.last_local_hash ?? null,
    state.lastSyncAt ?? existing?.last_sync_at ?? null, state.status ?? existing?.status ?? 'never', state.lastError ?? existing?.last_error ?? null,
    json(state.conflictPayload ?? parseJson(existing?.conflict_payload, {})), timestamp,
  ]);
}

async function request(baseUrl: string, token: string | null, path: string, init: RequestInit = {}, fetchImpl: FetchLike = fetch): Promise<any> {
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  if (init.body != null) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(body?.message || body?.error || `Self-host sync request failed (${response.status}).`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function configureSelfHostedSync(input: { baseUrl: string; workspaceId?: string; token?: string; enabled?: boolean; autoSync?: boolean }): Promise<SyncState> {
  const { runner, context } = await getContext();
  const baseUrl = validateBaseUrl(input.baseUrl);
  const deviceId = await deviceIdFor(context.bookId);
  const existing = await integrationRow(runner, context.bookId);
  const existingConfig = parseJson<StoredConfig>(existing?.config, {});
  if (input.token?.trim()) await secureSet(`${TOKEN_PREFIX}${context.bookId}`, input.token.trim());
  const config: StoredConfig = {
    ...existingConfig,
    enabled: input.enabled ?? true,
    baseUrl,
    workspaceId: input.workspaceId?.trim() || existingConfig.workspaceId || context.bookId,
    deviceId,
    autoSync: input.autoSync ?? existingConfig.autoSync ?? false,
  };
  const timestamp = now();
  await runner.run(`INSERT INTO v2_integrations(id,book_id,provider,kind,display_name,enabled,config,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(book_id,provider,kind) DO UPDATE SET display_name=excluded.display_name,enabled=excluded.enabled,config=excluded.config,updated_at=excluded.updated_at`, [
    existing?.id || uid('integration'), context.bookId, PROVIDER, KIND, 'User-owned Ledgr sync', config.enabled ? 1 : 0, json(config), existing?.created_at || timestamp, timestamp,
  ]);
  await writeState(runner, context.bookId, { remoteBookId: config.workspaceId, deviceId, status: 'never', lastError: null });
  return getSelfHostedSyncState();
}

export async function disableSelfHostedSync(): Promise<void> {
  const { runner, context } = await getContext();
  await runner.run('UPDATE v2_integrations SET enabled=0,updated_at=? WHERE book_id=? AND provider=? AND kind=?', [now(), context.bookId, PROVIDER, KIND]);
  await writeState(runner, context.bookId, { status: 'never', lastError: null });
}

export async function getSelfHostedSyncState(): Promise<SyncState> {
  const { runner, context } = await getContext();
  const { row, config, token, deviceId } = await readConfig(runner, context.bookId);
  const state = await syncStateRow(runner, context.bookId);
  return {
    provider: PROVIDER,
    enabled: Boolean(row?.enabled && config.enabled !== false),
    baseUrl: config.baseUrl || '',
    workspaceId: config.workspaceId || state?.remote_book_id || context.bookId,
    deviceId,
    hasToken: Boolean(token),
    autoSync: Boolean(config.autoSync),
    etag: state?.etag || null,
    lastLocalHash: state?.last_local_hash || null,
    lastSyncAt: state?.last_sync_at || null,
    status: (state?.status || 'never') as SyncStatus,
    lastError: state?.last_error || null,
  };
}

export async function testSelfHostedSyncConnection(): Promise<{ ok: true; serverVersion?: string }> {
  const { runner, context } = await getContext();
  const { config, token } = await readConfig(runner, context.bookId);
  const baseUrl = validateBaseUrl(config.baseUrl || '');
  return request(baseUrl, token, '/v1/sync/health');
}

async function configuredRequest(): Promise<{ runner: any; context: any; config: StoredConfig; token: string | null; state: any; baseUrl: string; workspaceId: string; deviceId: string }> {
  const { runner, context } = await getContext();
  const { config, token, row, deviceId } = await readConfig(runner, context.bookId);
  if (!row?.enabled || config.enabled === false) throw new Error('Self-host sync is disabled.');
  const baseUrl = validateBaseUrl(config.baseUrl || '');
  const workspaceId = config.workspaceId?.trim() || context.bookId;
  const state = await syncStateRow(runner, context.bookId);
  return { runner, context, config, token, state, baseUrl, workspaceId, deviceId };
}

export async function pushSelfHostedSnapshot(fetchImpl: FetchLike = fetch): Promise<SyncState> {
  const { runner, context, token, state, baseUrl, workspaceId, deviceId } = await configuredRequest();
  const snapshot = await exportBackup();
  const localHash = snapshotFingerprint(snapshot);
  try {
    const body = await request(baseUrl, token, '/v1/sync/push', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, deviceId, baseSnapshotHash: state?.etag || null, snapshot, snapshotHash: localHash }),
    }, fetchImpl);
    await writeState(runner, context.bookId, { remoteBookId: workspaceId, deviceId, etag: body.etag || null, lastLocalHash: localHash, lastSyncAt: now(), status: 'synced', lastError: null, conflictPayload: {} });
    return getSelfHostedSyncState();
  } catch (error: any) {
    if (error?.status === 409) {
      await writeState(runner, context.bookId, { remoteBookId: workspaceId, deviceId, status: 'conflict', lastError: 'The self-hosted copy changed on another device.', conflictPayload: { remoteEtag: error.body?.remoteEtag || null, remoteHash: error.body?.remoteHash || null } });
    } else {
      await writeState(runner, context.bookId, { status: 'offline', lastError: error?.message || 'Self-host sync is unreachable.' });
    }
    throw error;
  }
}

export async function pullSelfHostedSnapshot(options: { force?: boolean } = {}, fetchImpl: FetchLike = fetch): Promise<SyncState> {
  const { runner, context, token, state, baseUrl, workspaceId, deviceId } = await configuredRequest();
  const currentSnapshot = await exportBackup();
  const currentHash = snapshotFingerprint(currentSnapshot);
  const hasUnpushedLocalEdits = Boolean(state?.last_local_hash && state.last_local_hash !== currentHash);
  if (hasUnpushedLocalEdits && !options.force) {
    await writeState(runner, context.bookId, { status: 'conflict', lastError: 'Local offline edits must be pushed or explicitly replaced before pulling remote data.' });
    throw new Error('Local offline edits are not synced. Choose Push local or Replace local with remote first.');
  }
  try {
    const body = await request(baseUrl, token, `/v1/sync/pull?workspaceId=${encodeURIComponent(workspaceId)}`, {}, fetchImpl);
    if (!body.snapshot) throw new Error('The self-hosted server returned no Ledgr snapshot.');
    const remoteHash = body.snapshotHash || snapshotFingerprint(body.snapshot);
    const unknownLocalState = !state?.last_local_hash && !state?.last_sync_at;
    if (unknownLocalState && remoteHash !== currentHash && !options.force) {
      await writeState(runner, context.bookId, { remoteBookId: workspaceId, deviceId, etag: body.etag || null, status: 'conflict', lastError: 'This device has not synchronized before and the remote snapshot differs from its local book.', conflictPayload: { remoteEtag: body.etag || null, remoteHash } });
      throw new Error('This device has local data and the remote snapshot differs. Choose Use remote to replace it explicitly.');
    }
    await importBackup(body.snapshot);
    const restoredHash = snapshotFingerprint(body.snapshot);
    await writeState(runner, context.bookId, { remoteBookId: workspaceId, deviceId, etag: body.etag || null, lastLocalHash: restoredHash, lastSyncAt: now(), status: 'synced', lastError: null, conflictPayload: {} });
    return getSelfHostedSyncState();
  } catch (error: any) {
    if (error?.status === 404) throw new Error('No remote snapshot exists yet. Push this device first.');
    if (/remote snapshot differs|local offline edits are not synced/i.test(error?.message || '')) throw error;
    await writeState(runner, context.bookId, { status: 'offline', lastError: error?.message || 'Self-host sync is unreachable.' });
    throw error;
  }
}

export async function resolveSelfHostedConflict(strategy: 'push_local' | 'use_remote', fetchImpl: FetchLike = fetch): Promise<SyncState> {
  if (strategy === 'push_local') return pushSelfHostedSnapshot(fetchImpl);
  return pullSelfHostedSnapshot({ force: true }, fetchImpl);
}

export async function syncSelfHostedNow(fetchImpl: FetchLike = fetch): Promise<SyncState> {
  const state = await getSelfHostedSyncState();
  if (!state.etag) return pushSelfHostedSnapshot(fetchImpl);
  return pushSelfHostedSnapshot(fetchImpl);
}

export const selfHostedSync = {
  configure: configureSelfHostedSync,
  disable: disableSelfHostedSync,
  getState: getSelfHostedSyncState,
  testConnection: testSelfHostedSyncConnection,
  push: pushSelfHostedSnapshot,
  pull: pullSelfHostedSnapshot,
  resolveConflict: resolveSelfHostedConflict,
  syncNow: syncSelfHostedNow,
};
