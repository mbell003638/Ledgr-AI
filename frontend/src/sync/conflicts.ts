import type { SqlRunner } from '@/src/db/schema';
import { createSyncId } from './ids';
import { hashPayload, type CanonicalSyncOperation, type SyncOperation } from './protocol';
import { enqueueSyncOperation, makeSyncOperation, nextDeviceSequence } from './outbox';
import { getSyncProfile, markSyncRecoveryRequired } from './coordinator';
import { withSyncDatabaseMutationLock } from './databaseMutex';

export type SyncConflict = {
  conflictId: string;
  bookId: string;
  opId: string;
  canonicalOpId: string | null;
  aggregateId: string | null;
  commandType: string | null;
  reason: string;
  status: 'open' | 'resolved' | 'ignored';
  basePayload: unknown;
  localPayload: unknown;
  canonicalPayload: unknown;
  remoteOperation: CanonicalSyncOperation | null;
  blockingBookSequence: number | null;
  canonicalRevision: number | null;
  baseRevision: number | null;
  actorId: string | null;
  deviceId: string | null;
  businessDate: string | null;
  hasRetainedLocalOperation: boolean;
  mergePermitted: boolean;
  createdAt: string;
  resolvedAt: string | null;
};

export type SyncCorrectionAccount = { id: string; code: string; name: string; type: string };

export type ConflictResolutionType = 'keep_canonical' | 'audited_correction' | 'merge';
export type ConflictResolutionOptions = {
  type: ConflictResolutionType;
  payload?: unknown;
  correctionCommandType?: 'accounting.correction.post' | 'accounting.correction.reverse';
};

const now = () => new Date().toISOString();
let savepointSequence = 0;

function json(value: string | null | undefined): any {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function canMerge(commandType: string | null, local: any, canonical: any): boolean {
  if (!commandType || !['party.patch', 'product.patch', 'location.patch', 'book.config.patch'].includes(commandType)) return false;
  const a = local?.patch; const b = canonical?.patch;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  return !Object.keys(a).some((key) => Object.prototype.hasOwnProperty.call(b, key));
}

function map(row: any): SyncConflict {
  const localPayload = json(row.local_payload); const canonicalPayload = json(row.canonical_payload);
  const commandType = row.command_type == null ? null : String(row.command_type);
  return {
    conflictId: String(row.conflict_id), bookId: String(row.book_id), opId: String(row.op_id),
    canonicalOpId: row.canonical_op_id == null ? null : String(row.canonical_op_id),
    aggregateId: row.aggregate_id == null ? null : String(row.aggregate_id), commandType,
    reason: String(row.reason), status: row.status === 'resolved' || row.status === 'ignored' ? row.status : 'open',
    basePayload: json(row.base_payload), localPayload, canonicalPayload,
    remoteOperation: json(row.remote_operation),
    blockingBookSequence: row.blocking_book_sequence == null ? null : Number(row.blocking_book_sequence),
    canonicalRevision: row.canonical_revision == null ? null : Number(row.canonical_revision),
    baseRevision: row.local_base_revision == null ? null : Number(row.local_base_revision),
    actorId: row.actor_id == null ? null : String(row.actor_id), deviceId: row.device_id == null ? null : String(row.device_id),
    businessDate: row.business_date == null ? null : String(row.business_date),
    hasRetainedLocalOperation: row.retained_op_id != null,
    mergePermitted: row.retained_op_id != null && canMerge(commandType, localPayload, canonicalPayload),
    createdAt: String(row.created_at), resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
  };
}

export async function listOpenSyncConflicts(db: SqlRunner, bookId: string): Promise<SyncConflict[]> {
  return (await db.all<any>(`SELECT c.*,o.op_id AS retained_op_id,o.actor_id,o.device_id,o.business_date,o.base_revision AS local_base_revision
    FROM sync_conflicts c LEFT JOIN sync_outbox o ON o.op_id=c.op_id
    WHERE c.book_id=? AND c.status='open' ORDER BY c.created_at DESC`, [bookId])).map(map);
}

/** Active chart accounts from the exact Business Account being corrected. */
export async function listSyncCorrectionAccounts(db: SqlRunner, bookId: string): Promise<SyncCorrectionAccount[]> {
  const rows = await db.all<any>('SELECT id,code,name,type FROM v2_accounts WHERE book_id=? AND active=1 ORDER BY code,name,id', [bookId]);
  return rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    type: String(row.type),
  }));
}

function operationFromRow(row: any): SyncOperation {
  return {
    protocolVersion: 1, payloadVersion: 1, opId: String(row.op_id), bookId: String(row.book_id), bookEpoch: String(row.book_epoch),
    deviceId: String(row.device_id), deviceSequence: Number(row.device_sequence), actorId: String(row.actor_id),
    commandType: String(row.command_type), aggregateId: String(row.aggregate_id), baseRevision: row.base_revision == null ? null : Number(row.base_revision),
    dependencies: json(row.dependencies) || [], payload: json(row.payload), payloadHash: String(row.payload_hash), clientCreatedAt: String(row.client_created_at),
    ...(row.business_date ? { businessDate: String(row.business_date) } : {}),
  };
}

function mergedPayload(conflict: SyncConflict): unknown {
  if (!conflict.mergePermitted) throw new Error('Merge is not permitted for this conflict');
  const local: any = conflict.localPayload; const canonical: any = conflict.canonicalPayload;
  return { ...canonical, ...local, patch: { ...canonical.patch, ...local.patch } };
}

/**
 * Source intent is retained. Keep-canonical writes an exact ignored-event marker;
 * correction and merge create a new dependent semantic operation and require a
 * domain applier so accounting history is never edited directly.
 */
export async function resolveSyncConflict(db: SqlRunner, bookId: string, conflictId: string, options: ConflictResolutionOptions): Promise<string | null> {
  return withSyncDatabaseMutationLock(() => resolveSyncConflictLocked(db, bookId, conflictId, options));
}

async function resolveSyncConflictLocked(db: SqlRunner, bookId: string, conflictId: string, options: ConflictResolutionOptions): Promise<string | null> {
  const row = await db.first<any>(`SELECT c.*,o.op_id AS retained_op_id,o.actor_id,o.device_id,o.business_date,o.base_revision AS local_base_revision
    FROM sync_conflicts c LEFT JOIN sync_outbox o ON o.op_id=c.op_id
    WHERE c.conflict_id=? AND c.book_id=? AND c.status='open'`, [conflictId, bookId]);
  if (!row) throw new Error('Sync conflict is no longer open');
  const conflict = map(row); const profile = await getSyncProfile(db, bookId);
  if (!profile?.bookEpoch) throw new Error('Re-enroll sync before resolving this conflict');
  let resolutionOpId: string | null = null;
  const savepoint = `sync_conflict_resolution_${++savepointSequence}`;
  await db.exec(`SAVEPOINT ${savepoint}`);
  try {
    if (options.type === 'keep_canonical') {
      await db.run("UPDATE sync_outbox SET status='rejected',last_error=?,updated_at=? WHERE op_id=? AND status='conflict'", ['Kept canonical operation during conflict resolution', now(), conflict.opId]);
    } else {
      const sourceRow = await db.first<any>('SELECT * FROM sync_outbox WHERE op_id=?', [conflict.opId]);
      if (!sourceRow) throw new Error('The retained local operation is unavailable for correction');
      const source = operationFromRow(sourceRow);
      const payload = options.type === 'merge' ? mergedPayload(conflict) : options.payload;
      let resolutionBusinessDate = source.businessDate;
      if (options.type === 'audited_correction') {
        const value: any = payload;
        if (!value || typeof value !== 'object' || typeof value.reason !== 'string' || !value.reason.trim() || (!value.conflictId && !value.correctsOperationId && !value.correctsSourceId)) throw new Error('Audited correction requires a reason and an explicit conflict, operation, or source audit link');
        if (options.correctionCommandType !== 'accounting.correction.reverse' && (!value.posting || !Array.isArray(value.posting.lines))) throw new Error('Audited correction requires an explicit balanced posting; the original create command will not be replayed');
        const correctionDate = options.correctionCommandType === 'accounting.correction.reverse' ? value.date : value.posting?.date;
        if (typeof correctionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(correctionDate)) throw new Error('Audited correction requires an explicit correction business date');
        resolutionBusinessDate = correctionDate;
      }
      const sequence = await nextDeviceSequence(db, bookId, profile.deviceId, profile.bookEpoch);
      const operation = makeSyncOperation({
        bookId, bookEpoch: profile.bookEpoch, deviceId: profile.deviceId, deviceSequence: sequence, actorId: profile.actorId,
        commandType: options.type === 'audited_correction' ? (options.correctionCommandType || 'accounting.correction.post') : source.commandType, aggregateId: source.aggregateId,
        baseRevision: conflict.canonicalRevision ?? source.baseRevision,
        dependencies: [...new Set([...source.dependencies, ...(conflict.canonicalOpId ? [conflict.canonicalOpId] : [])])],
        payload, payloadHash: hashPayload(payload), clientCreatedAt: now(), ...(resolutionBusinessDate ? { businessDate: resolutionBusinessDate } : {}),
      });
      await enqueueSyncOperation(db, operation);
      resolutionOpId = operation.opId;
      await db.run("UPDATE sync_outbox SET status='rejected',last_error=?,updated_at=? WHERE op_id=? AND status='conflict'", ['Superseded by audited conflict resolution', now(), source.opId]);
    }
    const timestamp = now();
    await db.run("UPDATE sync_conflicts SET status='resolved',resolution_type=?,resolution_op_id=?,resolved_at=? WHERE conflict_id=?", [options.type, resolutionOpId, timestamp, conflictId]);
    await db.run('INSERT INTO sync_conflict_resolutions(resolution_id,conflict_id,book_id,resolution_type,resolution_op_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [createSyncId(), conflictId, bookId, options.type, resolutionOpId, 'pending', timestamp, timestamp]);
    await markSyncRecoveryRequired(db, bookId, 'Conflict decision recorded; install the canonical snapshot to remove rejected local intent and replay preserved work');
    await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return resolutionOpId;
  } catch (error) {
    try { await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); await db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* retain original */ }
    throw error;
  }
}

/** Compatibility helper: review now means the explicit keep-canonical decision. */
export async function markSyncConflictResolved(db: SqlRunner, conflictId: string): Promise<void> {
  const row = await db.first<{ book_id: string }>('SELECT book_id FROM sync_conflicts WHERE conflict_id=?', [conflictId]);
  if (!row) return;
  await resolveSyncConflict(db, String(row.book_id), conflictId, { type: 'keep_canonical' });
}
