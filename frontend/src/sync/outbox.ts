import type { SqlRunner } from '../db/schema';
import { createSyncId } from './ids';
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
export async function withSyncOperation<T>(db: SqlRunner, operation: SyncOperation, apply: () => Promise<T>): Promise<T> {
  const savepoint = `sync_outbox_${++savepointSequence}`;
  await db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = await apply();
    await enqueueSyncOperation(db, operation);
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

export async function listPendingSyncOperations(db: SqlRunner, bookId: string, limit = 100): Promise<SyncOutboxRow[]> {
  const rows = await db.all<any>(
    `SELECT * FROM sync_outbox WHERE book_id=? AND status IN ('pending','retryable') ORDER BY device_sequence LIMIT ?`,
    [bookId, Math.max(1, Math.min(500, Math.floor(limit)))],
  );
  return rows.map(mapOutbox);
}

export async function markSyncOperationAccepted(db: SqlRunner, opId: string, bookSequence: number): Promise<void> {
  await db.run('UPDATE sync_outbox SET status=\'accepted\',accepted_book_sequence=?,updated_at=? WHERE op_id=?', [bookSequence, nowIso(), opId]);
}

export async function markSyncOperationFailed(db: SqlRunner, opId: string, status: Extract<SyncOperationStatus, 'retryable' | 'conflict' | 'rejected'>, error?: string): Promise<void> {
  await db.run('UPDATE sync_outbox SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE op_id=?', [status, error || null, nowIso(), opId]);
}

export async function readSyncBookState(db: SqlRunner, bookId: string): Promise<SyncBookState | null> {
  const row = await db.first<any>('SELECT * FROM sync_book_state WHERE book_id=?', [bookId]);
  if (!row) return null;
  return { bookId, bookEpoch: String(row.book_epoch), serverCursor: Number(row.server_cursor || 0), ...(row.snapshot_hash ? { snapshotHash: String(row.snapshot_hash) } : {}), updatedAt: String(row.updated_at) };
}

export async function writeSyncBookState(db: SqlRunner, state: SyncBookState): Promise<void> {
  await db.run(
    `INSERT INTO sync_book_state(book_id,book_epoch,server_cursor,snapshot_hash,updated_at) VALUES(?,?,?,?,?)
     ON CONFLICT(book_id) DO UPDATE SET book_epoch=excluded.book_epoch,server_cursor=excluded.server_cursor,snapshot_hash=excluded.snapshot_hash,updated_at=excluded.updated_at`,
    [state.bookId, state.bookEpoch, state.serverCursor, state.snapshotHash || null, state.updatedAt],
  );
}
