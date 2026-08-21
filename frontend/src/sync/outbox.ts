import type { SqlRunner } from '../db/schema';
import { withDeterministicAccountingIds } from '../accountingV2/runtimeIds';
import { createSyncId } from './ids';
import { withSyncDatabaseMutationLock } from './databaseMutex';
import { assertSyncOperation, SYNC_PAYLOAD_VERSION, SYNC_PROTOCOL_VERSION, type SyncBookState, type SyncOperation, type SyncOperationStatus, type SyncOutboxRow } from './protocol';

let savepointSequence = 0;

const nowIso = () => new Date().toISOString();

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

export async function nextDeviceSequence(db: SqlRunner, bookId: string, deviceId: string, bookEpoch: string): Promise<number> {
  const row = await db.first<{ next_sequence: number }>('SELECT next_sequence FROM sync_device_state WHERE book_id=? AND device_id=?', [bookId, deviceId]);
  const next = Math.max(1, Number(row?.next_sequence || 1));
  const updatedAt = nowIso();
  await db.run(
    `INSERT INTO sync_device_state(book_id,device_id,book_epoch,next_sequence,updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(book_id,device_id) DO UPDATE SET book_epoch=excluded.book_epoch,next_sequence=excluded.next_sequence,updated_at=excluded.updated_at`,
    [bookId, deviceId, bookEpoch, next + 1, updatedAt],
  );
  return next;
}

export function makeSyncOperation(input: Omit<SyncOperation, 'protocolVersion' | 'payloadVersion' | 'opId'> & { opId?: string }): SyncOperation {
  const operation: SyncOperation = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    payloadVersion: SYNC_PAYLOAD_VERSION,
    opId: input.opId || createSyncId(),
    ...input,
  };
  assertSyncOperation(operation);
  return operation;
}

/** Insert an operation inside the caller's existing SQLite transaction/savepoint. */
export async function enqueueSyncOperation(db: SqlRunner, operation: SyncOperation, status: SyncOperationStatus = 'pending'): Promise<void> {
  assertSyncOperation(operation);
  const timestamp = nowIso();
  await db.run(
    `INSERT INTO sync_outbox(
      op_id,book_id,book_epoch,device_id,device_sequence,actor_id,command_type,aggregate_id,
      base_revision,dependencies,payload,payload_hash,client_created_at,business_date,status,
      attempts,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      operation.opId, operation.bookId, operation.bookEpoch, operation.deviceId, operation.deviceSequence,
      operation.actorId, operation.commandType, operation.aggregateId, operation.baseRevision,
      JSON.stringify(operation.dependencies), JSON.stringify(operation.payload), operation.payloadHash,
      operation.clientCreatedAt, operation.businessDate || null, status, 0, timestamp, timestamp,
    ],
  );
}

/** Apply a local domain mutation and enqueue its semantic operation atomically. */
export async function withSyncOperation<T>(db: SqlRunner, operation: SyncOperation, apply: () => Promise<T>, finalize?: (result: T, operation: SyncOperation) => SyncOperation, status: SyncOperationStatus = 'pending'): Promise<T> {
  return withSyncDatabaseMutationLock(() => withSyncOperationLocked(db, operation, apply, finalize, status));
}

/** Caller already owns the global SQLite mutation lock. */
export async function withSyncOperationLocked<T>(db: SqlRunner, operation: SyncOperation, apply: () => Promise<T>, finalize?: (result: T, operation: SyncOperation) => SyncOperation, status: SyncOperationStatus = 'pending'): Promise<T> {
  const savepoint = `sync_outbox_${++savepointSequence}`;
  await db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = await withDeterministicAccountingIds(operation.opId, apply);
    await enqueueSyncOperation(db, finalize ? finalize(result, operation) : operation, status);
    await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try {
      await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch { /* preserve the original failure */ }
    throw error;
  }
}

function mapOutbox(row: any): SyncOutboxRow {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    payloadVersion: SYNC_PAYLOAD_VERSION,
    opId: String(row.op_id), bookId: String(row.book_id), bookEpoch: String(row.book_epoch),
    deviceId: String(row.device_id), deviceSequence: Number(row.device_sequence), actorId: String(row.actor_id),
    commandType: String(row.command_type), aggregateId: String(row.aggregate_id),
    baseRevision: row.base_revision == null ? null : Number(row.base_revision),
    dependencies: parseJson<string[]>(row.dependencies, []), payload: parseJson(row.payload, null),
    payloadHash: String(row.payload_hash), clientCreatedAt: String(row.client_created_at),
    ...(row.business_date ? { businessDate: String(row.business_date) } : {}),
    status: row.status as SyncOperationStatus, attempts: Number(row.attempts || 0),
    ...(row.next_retry_at ? { nextRetryAt: String(row.next_retry_at) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.accepted_book_sequence == null ? {} : { acceptedBookSequence: Number(row.accepted_book_sequence) }),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export async function listPendingSyncOperations(db: SqlRunner, bookId: string, limit = 100, bookEpoch?: string): Promise<SyncOutboxRow[]> {
  const rows = await db.all<any>(
    `SELECT * FROM sync_outbox WHERE book_id=?${bookEpoch ? ' AND book_epoch=?' : ''} AND status IN ('pending','retryable') AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY device_sequence LIMIT ?`,
    [bookId, ...(bookEpoch ? [bookEpoch] : []), nowIso(), Math.max(1, Math.min(500, Math.floor(limit)))],
  );
  return rows.map(mapOutbox);
}

export async function markSyncOperationAccepted(db: SqlRunner, opId: string, bookSequence: number): Promise<void> {
  await db.run('UPDATE sync_outbox SET status=\'accepted\',accepted_book_sequence=?,updated_at=? WHERE op_id=?', [bookSequence, nowIso(), opId]);
}

export async function markSyncOperationFailed(db: SqlRunner, opId: string, status: Extract<SyncOperationStatus, 'retryable' | 'conflict' | 'rejected'>, error?: string): Promise<void> {
  const row = await db.first<{ attempts: number }>('SELECT attempts FROM sync_outbox WHERE op_id=?', [opId]);
  const attempts = Number(row?.attempts || 0) + 1;
  const delayMs = Math.min(24 * 60 * 60 * 1000, 1000 * (2 ** Math.min(10, attempts)) + Math.floor(Math.random() * 1000));
  const nextRetryAt = status === 'retryable' ? new Date(Date.now() + delayMs).toISOString() : null;
  await db.run('UPDATE sync_outbox SET status=?,attempts=?,next_retry_at=?,last_error=?,updated_at=? WHERE op_id=?', [status, attempts, nextRetryAt, error || null, nowIso(), opId]);
}

export async function readSyncBookState(db: SqlRunner, bookId: string): Promise<SyncBookState | null> {
  const row = await db.first<any>('SELECT * FROM sync_book_state WHERE book_id=?', [bookId]);
  if (!row) return null;
  return { bookId, bookEpoch: String(row.book_epoch), serverCursor: Number(row.server_cursor || 0), ...(row.snapshot_hash ? { snapshotHash: String(row.snapshot_hash) } : {}), ...(row.projection_hash ? { projectionHash: String(row.projection_hash) } : {}), ...(row.last_verified_at ? { lastVerifiedAt: String(row.last_verified_at) } : {}), ...(row.epoch_number == null ? {} : { epochNumber: Number(row.epoch_number) }), epochStartSequence: Number(row.epoch_start_sequence || 0), updatedAt: String(row.updated_at) };
}

export async function writeSyncBookState(db: SqlRunner, state: SyncBookState): Promise<void> {
  await db.run(
    `INSERT INTO sync_book_state(book_id,book_epoch,server_cursor,snapshot_hash,projection_hash,last_verified_at,epoch_number,epoch_start_sequence,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(book_id) DO UPDATE SET book_epoch=excluded.book_epoch,server_cursor=excluded.server_cursor,snapshot_hash=excluded.snapshot_hash,projection_hash=excluded.projection_hash,last_verified_at=excluded.last_verified_at,epoch_number=excluded.epoch_number,epoch_start_sequence=excluded.epoch_start_sequence,updated_at=excluded.updated_at`,
    [state.bookId, state.bookEpoch, state.serverCursor, state.snapshotHash || null, state.projectionHash || null, state.lastVerifiedAt || null, state.epochNumber ?? null, state.epochStartSequence || 0, state.updatedAt],
  );
}
