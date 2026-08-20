import type { SqlRunner } from '../db/schema';
import { storage } from '../utils/storage';
import { createSyncId } from './ids';
import {
  hashPayload,
  type SyncBookState,
  type SyncOperation,
  type SyncOutboxRow,
} from './protocol';
import {
  listPendingSyncOperations,
  makeSyncOperation,
  markSyncOperationAccepted,
  markSyncOperationFailed,
  nextDeviceSequence,
  readSyncBookState,
  withSyncOperation,
  writeSyncBookState,
} from './outbox';

const DEVICE_KEY = 'ledgr:sync:device-id';
const tokenKey = (bookId: string) => `ledgr:sync:${bookId}:access-token`;
const now = () => new Date().toISOString();

export type SyncProfile = {
  bookId: string;
  serverUrl: string;
  userId: string;
  deviceId: string;
  actorId: string;
  bookEpoch: string;
  enabled: boolean;
  updatedAt: string;
};

export type SyncMutation = {
  commandType: string;
  aggregateType?: string;
  aggregateId: string;
  payload: unknown;
  baseRevision?: number | null;
  dependencies?: string[];
  businessDate?: string;
};

export type SyncStatus = {
  enabled: boolean;
  configured: boolean;
  serverUrl?: string;
  pending: number;
  conflicts: number;
  lastError?: string;
};

function validServerUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Sync server URL is invalid'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Sync server URL must use HTTPS (HTTP is allowed only for local development)');
  return url;
}

async function deviceId(): Promise<string> {
  const existing = await storage.secureGet<string | null>(DEVICE_KEY, null);
  if (existing) return existing;
  const created = createSyncId();
  await storage.secureSet(DEVICE_KEY, created);
  return created;
}

export async function getSyncProfile(db: SqlRunner, bookId: string): Promise<SyncProfile | null> {
  const row = await db.first<any>('SELECT * FROM sync_profiles WHERE id=?', [bookId]);
  if (!row) return null;
  return {
    bookId,
    serverUrl: String(row.server_url),
    userId: String(row.user_id || ''),
    deviceId: String(row.device_id || ''),
    actorId: String(row.actor_id || row.user_id || ''),
    bookEpoch: String(row.book_epoch || ''),
    enabled: Boolean(row.enabled),
    updatedAt: String(row.updated_at),
  };
}

export async function configureSync(db: SqlRunner, input: { bookId: string; serverUrl: string; userId: string; actorId?: string; accessToken?: string; enabled?: boolean }): Promise<SyncProfile> {
  const bookId = input.bookId.trim();
  if (!bookId) throw new Error('A Business Account is required for sync');
  const serverUrl = validServerUrl(input.serverUrl);
  const device = await deviceId();
  const existing = await getSyncProfile(db, bookId);
  const epoch = existing?.bookEpoch || createSyncId();
  const timestamp = now();
  await db.run(
    `INSERT INTO sync_profiles(id,server_url,user_id,device_id,actor_id,book_epoch,enabled,protocol_version,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT(id) DO UPDATE SET server_url=excluded.server_url,user_id=excluded.user_id,
       device_id=excluded.device_id,actor_id=excluded.actor_id,book_epoch=excluded.book_epoch,
       enabled=excluded.enabled,updated_at=excluded.updated_at`,
    [bookId, serverUrl, input.userId.trim(), device, (input.actorId || input.userId).trim(), epoch, input.enabled === false ? 0 : 1, timestamp, timestamp],
  );
  const state: SyncBookState = (await readSyncBookState(db, bookId)) || { bookId, bookEpoch: epoch, serverCursor: 0, updatedAt: timestamp };
  if (state.bookEpoch !== epoch) throw new Error('Sync book epoch mismatch; re-enrollment is required');
  await writeSyncBookState(db, { ...state, updatedAt: timestamp });
  if (input.accessToken !== undefined) await storage.secureSet(tokenKey(bookId), input.accessToken.trim());
  return (await getSyncProfile(db, bookId))!;
}

export async function disableSync(db: SqlRunner, bookId: string): Promise<void> {
  await db.run('UPDATE sync_profiles SET enabled=0,updated_at=? WHERE id=?', [now(), bookId]);
}

export async function getSyncStatus(db: SqlRunner, bookId: string): Promise<SyncStatus> {
  const profile = await getSyncProfile(db, bookId);
  const pendingRow = await db.first<{ count: number; last_error?: string }>("SELECT COUNT(*) AS count, MAX(last_error) AS last_error FROM sync_outbox WHERE book_id=? AND status IN ('pending','retryable')", [bookId]);
  const conflictRow = await db.first<{ count: number }>("SELECT COUNT(*) AS count FROM sync_conflicts WHERE book_id=? AND status='open'", [bookId]);
  return { enabled: Boolean(profile?.enabled), configured: Boolean(profile), ...(profile ? { serverUrl: profile.serverUrl } : {}), pending: Number(pendingRow?.count || 0), conflicts: Number(conflictRow?.count || 0), ...(pendingRow?.last_error ? { lastError: pendingRow.last_error } : {}) };
}

export async function withSyncedMutation<T>(db: SqlRunner, mutation: SyncMutation, apply: () => Promise<T>): Promise<T> {
  const context = await db.first<any>("SELECT value FROM meta WHERE key='v2_active_book_id'");
  const bookId = String(context?.value || '');
  const profile = bookId ? await getSyncProfile(db, bookId) : null;
  if (!profile?.enabled) return apply();
  const state = (await readSyncBookState(db, bookId)) || { bookId, bookEpoch: profile.bookEpoch, serverCursor: 0, updatedAt: now() };
  const sequence = await nextDeviceSequence(db, bookId, profile.deviceId, state.bookEpoch);
  const revisionRow = mutation.baseRevision === undefined && mutation.aggregateType
    ? await db.first<{ revision: number }>('SELECT revision FROM sync_entity_revisions WHERE book_id=? AND aggregate_type=? AND aggregate_id=?', [bookId, mutation.aggregateType, mutation.aggregateId])
    : null;
  const payload = mutation.payload;
  const operation = makeSyncOperation({
    bookId, bookEpoch: state.bookEpoch, deviceId: profile.deviceId, deviceSequence: sequence,
    actorId: profile.actorId, commandType: mutation.commandType, aggregateId: mutation.aggregateId,
    baseRevision: mutation.baseRevision === undefined ? (revisionRow ? Number(revisionRow.revision) : null) : mutation.baseRevision,
    dependencies: mutation.dependencies || [], payload, payloadHash: hashPayload(payload), clientCreatedAt: now(),
    ...(mutation.businessDate ? { businessDate: mutation.businessDate } : {}),
  });
  return withSyncOperation(db, operation, apply);
}

class SyncHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function request(profile: SyncProfile, path: string, init: RequestInit, token: string): Promise<any> {
  const response = await fetch(`${profile.serverUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SyncHttpError(response.status, String(body?.message || `Sync request failed (${response.status})`));
  return body;
}

async function recordConflict(db: SqlRunner, operation: SyncOperation, reason: string, canonical?: SyncOperation): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO sync_conflicts(conflict_id,book_id,op_id,canonical_op_id,reason,local_payload,canonical_payload,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    [createSyncId(), operation.bookId, operation.opId, canonical?.opId || null, reason, JSON.stringify(operation.payload), canonical ? JSON.stringify(canonical.payload) : null, now()],
  );
}

export type RemoteOperationApplier = (db: SqlRunner, operation: SyncOperation) => Promise<void>;

export async function syncNow(db: SqlRunner, bookId: string, applyRemote?: RemoteOperationApplier): Promise<SyncStatus> {
  const profile = await getSyncProfile(db, bookId);
  if (!profile?.enabled) return getSyncStatus(db, bookId);
  const token = await storage.secureGet<string | null>(tokenKey(bookId), null);
  if (!token) throw new Error('Sync access token is missing; open Sync Settings to enroll this device');
  const pending = await listPendingSyncOperations(db, bookId, 100);
  if (pending.length) {
    try {
      const pushed = await request(profile, '/v1/sync/push', { method: 'POST', body: JSON.stringify({ bookId, operations: pending }) }, token);
      for (const accepted of Array.isArray(pushed.accepted) ? pushed.accepted : []) await markSyncOperationAccepted(db, String(accepted.opId), Number(accepted.bookSequence));
    } catch (error: any) {
      const permanent = error instanceof SyncHttpError && (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 409);
      for (const operation of pending) await markSyncOperationFailed(db, operation.opId, permanent ? (error.status === 409 ? 'conflict' : 'rejected') : 'retryable', error?.message || 'Sync push failed');
    }
  }
  const state = (await readSyncBookState(db, bookId)) || { bookId, bookEpoch: profile.bookEpoch, serverCursor: 0, updatedAt: now() };
  const pulled = await request(profile, `/v1/sync/pull?bookId=${encodeURIComponent(bookId)}&after=${state.serverCursor}&limit=100`, { method: 'GET' }, token);
  for (const event of Array.isArray(pulled.events) ? pulled.events : []) {
    const already = await db.first<{ op_id: string }>('SELECT op_id FROM sync_applied_ops WHERE op_id=?', [event.opId]);
    if (!already) {
      const local = await db.first<any>('SELECT * FROM sync_outbox WHERE op_id=?', [event.opId]);
      try {
        if (!local && applyRemote) await applyRemote(db, event as SyncOperation);
        else if (!local && !applyRemote) throw new Error('No remote operation applier is registered');
        await db.run('INSERT OR IGNORE INTO sync_applied_ops(op_id,book_id,book_sequence,applied_at) VALUES(?,?,?,?)', [event.opId, bookId, event.bookSequence, now()]);
      } catch (error: any) {
        await recordConflict(db, event as SyncOperation, error?.message || 'Remote operation could not be applied');
      }
    }
  }
  await writeSyncBookState(db, { ...state, serverCursor: Number(pulled.cursor || state.serverCursor), updatedAt: now() });
  return getSyncStatus(db, bookId);
}

export async function listSyncConflicts(db: SqlRunner, bookId: string): Promise<any[]> {
  return db.all<any>("SELECT * FROM sync_conflicts WHERE book_id=? AND status='open' ORDER BY created_at DESC", [bookId]);
}

export async function resolveSyncConflict(db: SqlRunner, conflictId: string): Promise<void> {
  await db.run("UPDATE sync_conflicts SET status='resolved',resolved_at=? WHERE conflict_id=? AND status='open'", [now(), conflictId]);
}

export function isSyncOutboxRow(value: unknown): value is SyncOutboxRow { return Boolean(value && typeof value === 'object' && 'opId' in value); }
