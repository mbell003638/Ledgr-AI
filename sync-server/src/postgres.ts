import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CanonicalEvent, hashPayload, SyncOperation } from "./protocol.js";
import { AppendValidator, EventStore, StoreConflictError, assertConflictResolutionEvent } from "./store.js";
import { PostgresAccountingDomainStateReader } from "./postgresDomainState.js";
import { AuthorizationError, Authorizer, SyncPrincipal } from "./auth.js";
import { AggregateRevisionMap, BookEpochState, CheckpointVerification, CheckpointVerificationInput, ConflictEvidence, ConflictStatus, EpochAdvanceInput, ProjectionHashRecord, PullPage, RecoveryStore, SnapshotInput, SnapshotRecord, StoredConflict } from "./recovery.js";

export type PgResult<T> = { rows: T[] };
export type PgClient = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>>; release(): void };
export type PgPool = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>>; connect(): Promise<PgClient> };
export type SyncDeviceRecord = { bookId: string; deviceId: string; subject: string; enrolledEpoch: string; enrolledAt: string; expiresAt: string; lastSeenAt?: string; revokedAt?: string; revocationReason?: string; displayName?: string; platform?: string };
export type SyncMembershipRecord = { bookId: string; subject: string; role: 'owner' | 'admin' | 'accountant' | 'editor' | 'viewer' | 'auditor'; locationIds: string[]; updatedAt: string };
export type EnrollmentCodeRecord = { codeId: string; bookId: string; code: string; role: SyncMembershipRecord['role']; locationIds: string[]; expiresAt: string };

/** PostgreSQL membership and epoch-scoped device authorization. */
export class PostgresBookAuthorizer implements Authorizer {
  constructor(private readonly pool: PgPool, private readonly options: { enrollmentTtlDays?: number } = {}) {}

  async authorize(principal: SyncPrincipal, bookId: string, action: "pull" | "push", deviceId?: string): Promise<void> {
    const global = principal.scopes.has("sync:*");
    const bookClaim = principal.books.has("*") || principal.books.has(bookId);
    const scopeAllowed = global || (bookClaim && (action === "pull" || principal.scopes.has(`sync:${action}`)));
    if (!scopeAllowed) throw new AuthorizationError(`principal is not authorized to ${action} book ${bookId}`);
    // A token claim records what the identity provider believed when it issued
    // the token; sync_memberships records what this server grants right now.
    // The claim is an additional gate, never a substitute, so a member demoted
    // to viewer cannot keep pushing on a token that still lists the book.
    // sync:* stays a deliberate server-operator escape hatch.
    if (!global) {
      const rows = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id = $1 AND subject = $2", [bookId, principal.subject])).rows;
      const role = rows[0]?.role;
      if (!role || (action === "push" && (role === "viewer" || role === "auditor"))) throw new AuthorizationError(`principal is not authorized to ${action} book ${bookId}`);
    }
    if (!deviceId) return;
    const device = (await this.pool.query<{ subject: string; revoked_at: string | Date | null; expires_at: string | Date; enrolled_epoch: string | null; book_epoch: string }>(
      `SELECT d.subject,d.revoked_at,d.expires_at,d.enrolled_epoch,b.book_epoch FROM sync_devices d
       JOIN sync_books b ON b.book_id=d.book_id WHERE d.book_id=$1 AND d.device_id=$2`,
      [bookId, deviceId],
    )).rows[0];
    if (!device) throw new AuthorizationError(`device ${deviceId} is not enrolled for book ${bookId}`);
    if (device.revoked_at) throw new AuthorizationError(`device ${deviceId} has been revoked`);
    if (new Date(device.expires_at).getTime() <= Date.now()) throw new AuthorizationError(`device ${deviceId} enrollment has expired`);
    if (device.enrolled_epoch !== device.book_epoch) throw new AuthorizationError(`device ${deviceId} must be re-enrolled for the current book epoch`);
    if (device.subject !== principal.subject && !principal.scopes.has("sync:device-admin")) throw new AuthorizationError(`device ${deviceId} belongs to another subject`);
    await this.pool.query("UPDATE sync_devices SET last_seen_at=now() WHERE book_id=$1 AND device_id=$2", [bookId, deviceId]);
  }

  async enrollDevice(principal: SyncPrincipal, bookId: string, deviceId: string): Promise<SyncDeviceRecord> {
    await this.authorize(principal, bookId, "push");
    const admin = principal.scopes.has("sync:device-admin");
    const row = (await this.pool.query<any>(
      `INSERT INTO sync_devices(book_id,device_id,subject,enrolled_epoch,enrolled_at,expires_at,last_seen_at,revoked_at,revocation_reason)
       SELECT $1,$2,$3,book_epoch,now(),now() + ($5 * interval '1 day'),now(),NULL,NULL FROM sync_books WHERE book_id=$1
       ON CONFLICT(book_id,device_id) DO UPDATE SET enrolled_epoch=EXCLUDED.enrolled_epoch,enrolled_at=now(),expires_at=EXCLUDED.expires_at,last_seen_at=now(),revoked_at=NULL,revocation_reason=NULL
       WHERE $4=true OR (sync_devices.subject=EXCLUDED.subject AND (sync_devices.revoked_at IS NULL OR sync_devices.revocation_reason='book_epoch_advanced'))
       RETURNING book_id,device_id,subject,enrolled_epoch,enrolled_at,expires_at,last_seen_at,revoked_at,revocation_reason`,
      [bookId, deviceId, principal.subject, admin, this.options.enrollmentTtlDays ?? 90],
    )).rows[0];
    if (!row) throw new AuthorizationError(`device ${deviceId} belongs to another subject`);
    return { bookId: row.book_id, deviceId: row.device_id, subject: row.subject, enrolledEpoch: row.enrolled_epoch, enrolledAt: new Date(row.enrolled_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), ...(row.last_seen_at ? { lastSeenAt: new Date(row.last_seen_at).toISOString() } : {}), ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}), ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}) };
  }

  async listDevices(principal: SyncPrincipal, bookId: string): Promise<SyncDeviceRecord[]> {
    const role = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, principal.subject])).rows[0]?.role;
    if (!principal.scopes.has("sync:device-admin") && !principal.scopes.has("sync:*") && role !== "owner" && role !== "admin") throw new AuthorizationError("device administration permission is required");
    return (await this.pool.query<any>("SELECT book_id,device_id,subject,enrolled_epoch,enrolled_at,expires_at,last_seen_at,revoked_at,revocation_reason,display_name,platform FROM sync_devices WHERE book_id=$1 ORDER BY enrolled_at", [bookId])).rows.map((row) => ({ bookId: row.book_id, deviceId: row.device_id, subject: row.subject, enrolledEpoch: row.enrolled_epoch, enrolledAt: new Date(row.enrolled_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(), ...(row.last_seen_at ? { lastSeenAt: new Date(row.last_seen_at).toISOString() } : {}), ...(row.revoked_at ? { revokedAt: new Date(row.revoked_at).toISOString() } : {}), ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}), ...(row.display_name ? { displayName: row.display_name } : {}), ...(row.platform ? { platform: row.platform } : {}) }));
  }

  async revokeDevice(principal: SyncPrincipal, bookId: string, deviceId: string, reason = "operator_revoked"): Promise<void> {
    const role = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, principal.subject])).rows[0]?.role;
    if (!principal.scopes.has("sync:device-admin") && !principal.scopes.has("sync:*") && role !== "owner" && role !== "admin") throw new AuthorizationError("device administration permission is required");
    const result = await this.pool.query<{ device_id: string }>("UPDATE sync_devices SET revoked_at=now(),revocation_reason=$3 WHERE book_id=$1 AND device_id=$2 RETURNING device_id", [bookId, deviceId, reason]);
    if (!result.rows.length) throw new AuthorizationError(`device ${deviceId} is not registered for book ${bookId}`);
  }

  private async authorizeAdministration(principal: SyncPrincipal, bookId: string): Promise<void> {
    if (principal.scopes.has("sync:*") || principal.scopes.has("sync:device-admin") || principal.scopes.has("sync:book-admin")) return;
    const role = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, principal.subject])).rows[0]?.role;
    if (role !== "owner" && role !== "admin") throw new AuthorizationError("book administration permission is required");
  }

  async createEnrollmentCode(principal: SyncPrincipal, bookId: string, role: SyncMembershipRecord['role'], locationIds: string[], ttlMinutes = 15): Promise<EnrollmentCodeRecord> {
    await this.authorizeAdministration(principal, bookId);
    if (role === 'owner') throw new AuthorizationError('one-time codes cannot delegate book ownership');
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 60) throw new AuthorizationError('enrollment-code expiry must be between 5 and 60 minutes');
    const normalizedLocations = [...new Set(locationIds.map((value) => String(value).trim()).filter(Boolean))].slice(0, 500);
    const codeId = randomUUID();
    const code = `LGR-${randomBytes(18).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    await this.pool.query("INSERT INTO sync_enrollment_codes(code_id,book_id,code_hash,created_by,role,location_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", [codeId, bookId, createHash('sha256').update(code).digest('hex'), principal.subject, role, normalizedLocations, expiresAt]);
    return { codeId, bookId, code, role, locationIds: normalizedLocations, expiresAt };
  }

  async redeemEnrollmentCode(principal: SyncPrincipal, code: string, deviceId: string, displayName?: string, platform?: string): Promise<{ bookId: string; bookEpoch: string; epochNumber: number; epochStartSequence: number; currentSequence: number; device: SyncDeviceRecord }> {
    const normalizedCode = code.trim();
    if (!/^LGR-[A-Za-z0-9_-]{20,80}$/u.test(normalizedCode)) throw new AuthorizationError('enrollment code is invalid');
    if (!deviceId.trim()) throw new AuthorizationError('device id is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query<any>("SELECT c.code_id,c.book_id,c.role,c.location_ids,c.expires_at,b.book_epoch,b.epoch_number,b.start_sequence,b.next_sequence FROM sync_enrollment_codes c JOIN sync_books b ON b.book_id=c.book_id WHERE c.code_hash=$1 AND c.used_at IS NULL FOR UPDATE", [createHash('sha256').update(normalizedCode).digest('hex')])).rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) throw new AuthorizationError('enrollment code is expired, already used, or invalid');
      const existing = (await client.query<any>("SELECT subject,revoked_at FROM sync_devices WHERE book_id=$1 AND device_id=$2", [row.book_id, deviceId.trim()])).rows[0];
      if (existing && existing.subject !== principal.subject) throw new AuthorizationError('device id is already assigned to another user');
      const device = (await client.query<any>(`INSERT INTO sync_devices(book_id,device_id,subject,enrolled_epoch,enrolled_at,expires_at,last_seen_at,revoked_at,revocation_reason,display_name,platform) VALUES($1,$2,$3,$4,now(),now() + ($5 * interval '1 day'),now(),NULL,NULL,$6,$7) ON CONFLICT(book_id,device_id) DO UPDATE SET subject=EXCLUDED.subject,enrolled_epoch=EXCLUDED.enrolled_epoch,enrolled_at=now(),expires_at=EXCLUDED.expires_at,last_seen_at=now(),revoked_at=NULL,revocation_reason=NULL,display_name=COALESCE(EXCLUDED.display_name,sync_devices.display_name),platform=COALESCE(EXCLUDED.platform,sync_devices.platform) RETURNING book_id,device_id,subject,enrolled_epoch,enrolled_at,expires_at,last_seen_at,revoked_at,revocation_reason,display_name,platform`, [row.book_id, deviceId.trim(), principal.subject, row.book_epoch, this.options.enrollmentTtlDays ?? 90, displayName?.trim() || null, platform?.trim() || null])).rows[0];
      await client.query("INSERT INTO sync_memberships(book_id,subject,role,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(book_id,subject) DO UPDATE SET role=EXCLUDED.role,updated_at=now()", [row.book_id, principal.subject, row.role]);
      await client.query("DELETE FROM sync_membership_locations WHERE book_id=$1 AND subject=$2", [row.book_id, principal.subject]);
      for (const locationId of (Array.isArray(row.location_ids) ? row.location_ids : [])) await client.query("INSERT INTO sync_membership_locations(book_id,subject,location_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [row.book_id, principal.subject, String(locationId)]);
      await client.query("UPDATE sync_enrollment_codes SET used_at=now(),used_by_device=$2 WHERE code_id=$1", [row.code_id, deviceId.trim()]);
      await client.query('COMMIT');
      return { bookId: row.book_id, bookEpoch: row.book_epoch, epochNumber: Number(row.epoch_number), epochStartSequence: Number(row.start_sequence || 1), currentSequence: Number(row.next_sequence) - 1, device: { bookId: device.book_id, deviceId: device.device_id, subject: device.subject, enrolledEpoch: device.enrolled_epoch, enrolledAt: new Date(device.enrolled_at).toISOString(), expiresAt: new Date(device.expires_at).toISOString(), ...(device.last_seen_at ? { lastSeenAt: new Date(device.last_seen_at).toISOString() } : {}), ...(device.display_name ? { displayName: device.display_name } : {}), ...(device.platform ? { platform: device.platform } : {}) } };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async renameDevice(principal: SyncPrincipal, bookId: string, deviceId: string, displayName: string, platform?: string): Promise<void> {
    await this.authorizeAdministration(principal, bookId);
    if (!displayName.trim() || displayName.length > 120) throw new AuthorizationError("device name is invalid");
    const result = await this.pool.query("UPDATE sync_devices SET display_name=$3,platform=COALESCE($4,platform) WHERE book_id=$1 AND device_id=$2 RETURNING device_id", [bookId, deviceId, displayName.trim(), platform?.trim() || null]);
    if (!result.rows.length) throw new AuthorizationError(`device ${deviceId} is not registered for book ${bookId}`);
  }

  async listMemberships(principal: SyncPrincipal, bookId: string): Promise<SyncMembershipRecord[]> {
    await this.authorizeAdministration(principal, bookId);
    const rows = (await this.pool.query<any>(`SELECT m.book_id,m.subject,m.role,m.updated_at,COALESCE(array_agg(l.location_id) FILTER (WHERE l.location_id IS NOT NULL),'{}') AS location_ids FROM sync_memberships m LEFT JOIN sync_membership_locations l ON l.book_id=m.book_id AND l.subject=m.subject WHERE m.book_id=$1 GROUP BY m.book_id,m.subject,m.role,m.updated_at ORDER BY m.subject`, [bookId])).rows;
    return rows.map((row) => ({ bookId: row.book_id, subject: row.subject, role: row.role, locationIds: Array.isArray(row.location_ids) ? row.location_ids.map(String) : [], updatedAt: new Date(row.updated_at).toISOString() }));
  }

  async upsertMembership(principal: SyncPrincipal, bookId: string, subject: string, role: SyncMembershipRecord['role']): Promise<SyncMembershipRecord> {
    await this.authorizeAdministration(principal, bookId);
    if (!subject.trim()) throw new AuthorizationError("member subject is required");
    if (role === 'owner' && principal.scopes.has('sync:*') === false) {
      const current = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, principal.subject])).rows[0]?.role;
      if (current !== 'owner') throw new AuthorizationError("only the book owner can assign ownership");
    }
    const row = (await this.pool.query<any>("INSERT INTO sync_memberships(book_id,subject,role,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(book_id,subject) DO UPDATE SET role=EXCLUDED.role,updated_at=now() RETURNING book_id,subject,role,updated_at", [bookId, subject.trim(), role])).rows[0];
    return { bookId: row.book_id, subject: row.subject, role: row.role, locationIds: [], updatedAt: new Date(row.updated_at).toISOString() };
  }

  async removeMembership(principal: SyncPrincipal, bookId: string, subject: string): Promise<void> {
    await this.authorizeAdministration(principal, bookId);
    const current = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, subject])).rows[0]?.role;
    if (!current) return;
    if (current === 'owner') throw new AuthorizationError("the book owner cannot be removed");
    await this.pool.query("DELETE FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, subject]);
  }

  async setMembershipLocations(principal: SyncPrincipal, bookId: string, subject: string, locationIds: string[]): Promise<void> {
    await this.authorizeAdministration(principal, bookId);
    const member = (await this.pool.query("SELECT 1 FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, subject])).rows[0];
    if (!member) throw new AuthorizationError("member must be assigned a role before location access");
    const normalized = [...new Set(locationIds.map((value) => String(value).trim()).filter(Boolean))].slice(0, 500);
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query("DELETE FROM sync_membership_locations WHERE book_id=$1 AND subject=$2", [bookId, subject]); for (const locationId of normalized) await client.query("INSERT INTO sync_membership_locations(book_id,subject,location_id) VALUES($1,$2,$3)", [bookId, subject, locationId]); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async authorizeOperation(principal: SyncPrincipal, operation: SyncOperation): Promise<void> {
    if (principal.scopes.has('sync:*') || principal.scopes.has('sync:book-admin')) return;
    const role = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [operation.bookId, principal.subject])).rows[0]?.role;
    if (role === 'owner' || role === 'admin') return;
    const locationIds = operationLocationIds(operation.payload);
    if (!locationIds.length) {
      // A book-wide operation carries no locationId, so location scoping cannot
      // constrain it. Returning early let a member confined to one location
      // rewrite book configuration and opening balances for the whole book.
      const scoped = (await this.pool.query<{ location_id: string }>("SELECT location_id FROM sync_membership_locations WHERE book_id=$1 AND subject=$2 LIMIT 1", [operation.bookId, principal.subject])).rows;
      if (scoped.length) throw new AuthorizationError(`principal is scoped to specific locations and cannot push book-wide operation ${operation.commandType}`);
      return;
    }
    const rows = (await this.pool.query<{ location_id: string }>("SELECT location_id FROM sync_membership_locations WHERE book_id=$1 AND subject=$2 AND location_id=ANY($3::text[])", [operation.bookId, principal.subject, locationIds])).rows;
    const allowed = new Set(rows.map((row) => row.location_id));
    const denied = locationIds.find((locationId) => !allowed.has(locationId));
    if (denied) throw new AuthorizationError(`principal is not authorized for location ${denied}`);
  }

  async authorizeBookAdmin(principal: SyncPrincipal, bookId: string, capability: "epoch" | "snapshot"): Promise<void> {
    if (principal.scopes.has("sync:*") || principal.scopes.has(`sync:${capability}-admin`) || principal.scopes.has(`sync:${capability}:write`)) return;
    const role = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id=$1 AND subject=$2", [bookId, principal.subject])).rows[0]?.role;
    if (role !== "owner" && role !== "admin") throw new AuthorizationError(`${capability} administration permission is required`);
  }
}

type EventRow = { book_id: string; book_sequence: string | number; aggregate_revision: string | number; op_id: string; payload_hash: string; operation: SyncOperation | string; accepted_at: string | Date };
type BookRow = { book_epoch: string; epoch_number: string | number; epoch_started_at: string | Date; next_sequence: string | number; start_sequence?: string | number };
type SnapshotRow = { snapshot_id: string; book_id: string; book_epoch: string; through_sequence: string | number; schema_version: number; payload: unknown; payload_hash: string; checkpoint_hash: string; aggregate_revisions: AggregateRevisionMap | string; projection_hash: string | null; created_by: string | null; created_at: string | Date };
type ProjectionRow = { book_id: string; book_epoch: string; through_sequence: string | number; source_id: string; projection_hash: string; recorded_at: string | Date };
type ConflictRow = { conflict_id: string | number; book_id: string; book_epoch: string; op_id: string; aggregate_id: string | null; canonical_op_id: string | null; reason: string; local_operation: SyncOperation | string | null; canonical_event: CanonicalEvent | string | null; base_revision: string | number | null; canonical_revision: string | number | null; details: Record<string, unknown> | string; status: ConflictStatus; resolution_type: string | null; resolution_op_id: string | null; resolved_by: string | null; created_at: string | Date; resolved_at: string | Date | null };

const jsonValue = <T>(value: T | string | null): T | null => typeof value === "string" ? JSON.parse(value) as T : value;
function event(row: EventRow): CanonicalEvent { const operation = jsonValue<SyncOperation>(row.operation); if (!operation) throw new Error("canonical event operation is missing"); return { ...operation, aggregateRevision: Number(row.aggregate_revision), bookSequence: Number(row.book_sequence), acceptedAt: new Date(row.accepted_at).toISOString() }; }
function epochState(bookId: string, row: BookRow): BookEpochState { return { bookId, bookEpoch: row.book_epoch, epochNumber: Number(row.epoch_number), epochStartSequence: Number(row.start_sequence || 1), currentSequence: Number(row.next_sequence) - 1, startedAt: new Date(row.epoch_started_at).toISOString() }; }
function operationLocationIds(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
      if ((key === 'locationId' || key === 'location_id') && typeof nested === 'string' && nested.trim()) found.add(nested.trim());
      else if (nested && typeof nested === 'object') visit(nested);
    }
  };
  visit(value);
  return [...found];
}

function aggregateRevisionMap(value: AggregateRevisionMap | string): AggregateRevisionMap {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("snapshot aggregate revisions are malformed");
  const result = Object.create(null) as AggregateRevisionMap;
  for (const [aggregateId, revision] of Object.entries(parsed)) {
    const number = Number(revision);
    if (!aggregateId || !Number.isSafeInteger(number) || number < 1) throw new Error("snapshot aggregate revisions are malformed");
    result[aggregateId] = number;
  }
  return result;
}
function snapshot(row: SnapshotRow): SnapshotRecord { return { snapshotId: row.snapshot_id, bookId: row.book_id, bookEpoch: row.book_epoch, throughSequence: Number(row.through_sequence), schemaVersion: Number(row.schema_version), payload: jsonValue(row.payload as any) as unknown, payloadHash: row.payload_hash, checkpointHash: row.checkpoint_hash, aggregateRevisions: aggregateRevisionMap(row.aggregate_revisions), ...(row.projection_hash ? { projectionHash: row.projection_hash } : {}), ...(row.created_by ? { createdBy: row.created_by } : {}), createdAt: new Date(row.created_at).toISOString() }; }
function projection(row: ProjectionRow): ProjectionHashRecord { return { bookId: row.book_id, bookEpoch: row.book_epoch, throughSequence: Number(row.through_sequence), sourceId: row.source_id, projectionHash: row.projection_hash, recordedAt: new Date(row.recorded_at).toISOString() }; }
function conflict(row: ConflictRow): StoredConflict { const local = jsonValue<SyncOperation>(row.local_operation); const canonical = jsonValue<CanonicalEvent>(row.canonical_event); const details = jsonValue<Record<string, unknown>>(row.details); return { conflictId: String(row.conflict_id), bookId: row.book_id, bookEpoch: row.book_epoch, opId: row.op_id, reason: row.reason, status: row.status, createdAt: new Date(row.created_at).toISOString(), ...(row.aggregate_id ? { aggregateId: row.aggregate_id } : {}), ...(row.canonical_op_id ? { canonicalOpId: row.canonical_op_id } : {}), ...(local ? { localOperation: local } : {}), ...(canonical ? { canonicalEvent: canonical } : {}), ...(row.base_revision === null ? {} : { baseRevision: Number(row.base_revision) }), ...(row.canonical_revision === null ? {} : { canonicalRevision: Number(row.canonical_revision) }), ...(details ? { details } : {}), ...(row.resolution_type ? { resolutionType: row.resolution_type } : {}), ...(row.resolution_op_id ? { resolutionOpId: row.resolution_op_id } : {}), ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}), ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).toISOString() } : {}) }; }
async function canonicalHash(db: { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>> }, bookId: string, bookEpoch: string, throughSequence: number): Promise<string> { const rows = (await db.query<{ op_id: string; book_sequence: string | number; aggregate_revision: string | number }>("SELECT op_id,book_sequence,aggregate_revision FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND book_sequence<=$3 ORDER BY book_sequence ASC", [bookId, bookEpoch, throughSequence])).rows; return hashPayload(rows.map((row) => ({ opId: row.op_id, bookSequence: Number(row.book_sequence), aggregateRevision: Number(row.aggregate_revision) }))); }
async function canonicalAggregateRevisions(db: { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>> }, bookId: string, bookEpoch: string, throughSequence: number): Promise<AggregateRevisionMap> {
  const rows = (await db.query<{ aggregate_id: string; revision: string | number }>(
    `SELECT operation->>'aggregateId' AS aggregate_id,MAX(aggregate_revision) AS revision
     FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND book_sequence<=$3
       AND NULLIF(operation->>'aggregateId','') IS NOT NULL
     GROUP BY operation->>'aggregateId' ORDER BY operation->>'aggregateId'`,
    [bookId, bookEpoch, throughSequence],
  )).rows;
  const result = Object.create(null) as AggregateRevisionMap;
  for (const row of rows) result[row.aggregate_id] = Number(row.revision);
  return result;
}

export class PostgresEventStore implements EventStore, RecoveryStore {
  constructor(private readonly pool: PgPool) {}

  async createBook(bookId: string, requestedEpoch?: string): Promise<BookEpochState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [bookId]);
      let row = (await client.query<BookRow>("SELECT b.book_epoch,b.epoch_number,b.epoch_started_at,b.next_sequence,e.start_sequence FROM sync_books b JOIN sync_book_epochs e ON e.book_id=b.book_id AND e.book_epoch=b.book_epoch WHERE b.book_id=$1", [bookId])).rows[0];
      if (row) { if (requestedEpoch && requestedEpoch !== row.book_epoch) throw new StoreConflictError(`book ${bookId} already has a different epoch`); await client.query("COMMIT"); return epochState(bookId, row); }
      const bookEpoch = requestedEpoch || randomUUID();
      row = (await client.query<BookRow>("INSERT INTO sync_books(book_id,book_epoch) VALUES($1,$2) RETURNING book_epoch,epoch_number,epoch_started_at,next_sequence,1::bigint AS start_sequence", [bookId, bookEpoch])).rows[0];
      if (!row) throw new Error("PostgreSQL did not create book");
      await client.query("INSERT INTO sync_book_epochs(book_id,book_epoch,epoch_number,start_sequence,started_at) VALUES($1,$2,$3,$4,$5)", [bookId, bookEpoch, row.epoch_number, row.start_sequence, row.epoch_started_at]);
      await client.query("COMMIT");
      return epochState(bookId, row);
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async getBookEpoch(bookId: string): Promise<BookEpochState | null> {
    const row = (await this.pool.query<BookRow>("SELECT b.book_epoch,b.epoch_number,b.epoch_started_at,b.next_sequence,e.start_sequence FROM sync_books b JOIN sync_book_epochs e ON e.book_id=b.book_id AND e.book_epoch=b.book_epoch WHERE b.book_id=$1", [bookId])).rows[0];
    return row ? epochState(bookId, row) : null;
  }

  async append(bookId: string, operations: SyncOperation[], validate?: AppendValidator): Promise<CanonicalEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const epoch = operations[0]?.bookEpoch;
      if (!epoch) throw new StoreConflictError("book epoch is required");
      const book = (await client.query<BookRow>("SELECT book_epoch,epoch_number,epoch_started_at,next_sequence FROM sync_books WHERE book_id=$1 FOR UPDATE", [bookId])).rows[0];
      const first = operations[0];
      if (!book) throw new StoreConflictError(`book ${bookId} must be enrolled before push`, first ? { bookId, bookEpoch: first.bookEpoch, opId: first.opId, aggregateId: first.aggregateId, reason: "book_not_enrolled", localOperation: first, baseRevision: first.baseRevision } : undefined);
      if (book.book_epoch !== epoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`, first ? { bookId, bookEpoch: first.bookEpoch, opId: first.opId, aggregateId: first.aggregateId, reason: "epoch_mismatch", localOperation: first, baseRevision: first.baseRevision, details: { currentEpoch: book.book_epoch } } : undefined);
      const accepted: CanonicalEvent[] = [];
      const seen = new Set<string>();
      for (const operation of operations) {
        const base: Omit<ConflictEvidence, "reason"> = { bookId, bookEpoch: operation.bookEpoch, opId: operation.opId, aggregateId: operation.aggregateId, localOperation: operation, baseRevision: operation.baseRevision };
        if (operation.bookId !== bookId) throw new StoreConflictError("operation bookId does not match batch bookId", { ...base, reason: "book_mismatch" });
        if (operation.bookEpoch !== book.book_epoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`, { ...base, reason: "epoch_mismatch", details: { currentEpoch: book.book_epoch } });
        if (seen.has(operation.opId)) throw new StoreConflictError(`duplicate opId in batch: ${operation.opId}`, { ...base, reason: "duplicate_batch_op_id" });
        seen.add(operation.opId);
        const existing = (await client.query<EventRow>("SELECT book_id,book_sequence,aggregate_revision,op_id,payload_hash,operation,accepted_at FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND op_id=$3", [bookId, epoch, operation.opId])).rows[0];
        if (existing) { const canonical = event(existing); if (existing.payload_hash !== operation.payloadHash) throw new StoreConflictError(`opId already exists with a different payload: ${operation.opId}`, { ...base, reason: "op_id_payload_mismatch", canonicalEvent: canonical, canonicalRevision: canonical.aggregateRevision }); accepted.push(canonical); continue; }
        if (validate) await validate({ operations: [operation], accountingStateReader: new PostgresAccountingDomainStateReader(client) });
        if (operation.dependencies?.length) {
          const present = (await client.query<{ op_id: string }>("SELECT op_id FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND op_id=ANY($3::text[])", [bookId, epoch, operation.dependencies])).rows;
          const found = new Set(present.map((item) => item.op_id));
          const missingDependencies = operation.dependencies.filter((dependency) => !found.has(dependency));
          if (missingDependencies.length) throw new StoreConflictError(`operation dependencies are not available: ${missingDependencies.join(",")}`, { ...base, reason: "dependency_missing", details: { missingDependencies } });
        }
        const sequenceExisting = (await client.query<EventRow>("SELECT book_id,book_sequence,aggregate_revision,op_id,payload_hash,operation,accepted_at FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND device_id=$3 AND device_sequence=$4", [bookId, epoch, operation.deviceId, operation.deviceSequence])).rows[0];
        if (sequenceExisting) { const canonical = event(sequenceExisting); throw new StoreConflictError(`device sequence already belongs to another operation: ${operation.deviceId}:${operation.deviceSequence}`, { ...base, reason: "device_sequence_reused", canonicalEvent: canonical, canonicalRevision: canonical.aggregateRevision }); }
        const revisionRow = (await client.query<{ revision: string | number }>("SELECT COALESCE(MAX(aggregate_revision),0) AS revision FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND operation->>'aggregateId'=$3", [bookId, epoch, operation.aggregateId])).rows[0];
        const currentRevision = Number(revisionRow?.revision || 0);
        if (operation.baseRevision !== undefined && operation.baseRevision !== null && operation.baseRevision !== currentRevision) {
          const canonicalRow = (await client.query<EventRow>("SELECT book_id,book_sequence,aggregate_revision,op_id,payload_hash,operation,accepted_at FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND operation->>'aggregateId'=$3 ORDER BY aggregate_revision DESC LIMIT 1", [bookId, epoch, operation.aggregateId])).rows[0];
          throw new StoreConflictError(`aggregate revision conflict for ${operation.aggregateId}: expected ${currentRevision}, received ${operation.baseRevision}`, { ...base, reason: "aggregate_revision_conflict", canonicalEvent: canonicalRow ? event(canonicalRow) : undefined, canonicalRevision: currentRevision });
        }
        const aggregateRevision = currentRevision + 1;
        const next = Number(book.next_sequence);
        const inserted = (await client.query<EventRow>("INSERT INTO sync_events(book_id,book_epoch,book_sequence,aggregate_revision,op_id,device_id,device_sequence,payload_hash,operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING book_id,book_sequence,aggregate_revision,op_id,payload_hash,operation,accepted_at", [bookId, epoch, next, aggregateRevision, operation.opId, operation.deviceId, operation.deviceSequence, operation.payloadHash, JSON.stringify(operation)])).rows[0];
        if (!inserted) throw new Error("PostgreSQL did not return inserted event");
        book.next_sequence = next + 1;
        await client.query("UPDATE sync_books SET next_sequence=$2,updated_at=now() WHERE book_id=$1", [bookId, book.next_sequence]);
        accepted.push(event(inserted));
      }
      await client.query("COMMIT");
      return accepted;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      let conflictError: StoreConflictError | undefined;
      if (error instanceof StoreConflictError) conflictError = error;
      else if ((error as { code?: string }).code === "23505" && operations[0]) { const operation = operations[0]; conflictError = new StoreConflictError("operation conflicts with an existing event", { bookId, bookEpoch: operation.bookEpoch, opId: operation.opId, aggregateId: operation.aggregateId, reason: "unique_constraint_conflict", localOperation: operation, baseRevision: operation.baseRevision }); }
      if (conflictError?.evidence && conflictError.evidence.reason !== "book_not_enrolled") await this.recordConflict(conflictError.evidence);
      if (conflictError) throw conflictError;
      throw error;
    } finally { client.release(); }
  }

  async pull(bookId: string, after: number, limit: number): Promise<PullPage> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<BookRow>("SELECT b.book_epoch,b.epoch_number,b.epoch_started_at,b.next_sequence,e.start_sequence FROM sync_books b JOIN sync_book_epochs e ON e.book_id=b.book_id AND e.book_epoch=b.book_epoch WHERE b.book_id=$1 FOR SHARE OF b", [bookId])).rows[0];
      if (!row) { await client.query("COMMIT"); return { events: [], cursor: after, hasMore: false, checkpointHash: hashPayload([]) }; }
      const book = epochState(bookId, row);
      if (after > book.currentSequence) throw new StoreConflictError("pull cursor is ahead of canonical history");
      const normalizedAfter = Math.max(after, book.epochStartSequence - 1);
      const rows = (await client.query<EventRow>("SELECT book_id,book_sequence,aggregate_revision,op_id,payload_hash,operation,accepted_at FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND book_sequence>$3 ORDER BY book_sequence ASC LIMIT $4", [bookId, book.bookEpoch, normalizedAfter, limit])).rows;
      const events = rows.map(event);
      const cursor = events.length ? events[events.length - 1].bookSequence : normalizedAfter;
      const more = (await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND book_sequence>$3) AS exists", [bookId, book.bookEpoch, cursor])).rows[0]?.exists ?? false;
      const checkpointHash = await canonicalHash(client, bookId, book.bookEpoch, cursor);
      await client.query("INSERT INTO sync_checkpoints(book_id,book_epoch,through_sequence,event_hash) VALUES($1,$2,$3,$4) ON CONFLICT(book_id,book_epoch,through_sequence) DO UPDATE SET event_hash=EXCLUDED.event_hash", [bookId, book.bookEpoch, cursor, checkpointHash]);
      await client.query("COMMIT");
      return { events, cursor, hasMore: more, checkpointHash, bookEpoch: book.bookEpoch, epochStartSequence: book.epochStartSequence };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async advanceEpoch(bookId: string, input: EpochAdvanceInput): Promise<BookEpochState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const book = (await client.query<BookRow>("SELECT book_epoch,epoch_number,epoch_started_at,next_sequence FROM sync_books WHERE book_id=$1 FOR UPDATE", [bookId])).rows[0];
      if (!book) throw new StoreConflictError(`book ${bookId} does not exist`);
      if (book.book_epoch !== input.expectedEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
      const current = Number(book.next_sequence) - 1;
      if (input.expectedSequence !== undefined && input.expectedSequence !== current) throw new StoreConflictError(`book sequence changed for ${bookId}`);
      const nextEpoch = input.newEpoch || randomUUID();
      if ((await client.query("SELECT 1 FROM sync_book_epochs WHERE book_id=$1 AND book_epoch=$2", [bookId, nextEpoch])).rows.length) throw new StoreConflictError(`book epoch has already been used for ${bookId}`);
      const timestamp = new Date().toISOString();
      const nextNumber = Number(book.epoch_number) + 1;
      await client.query("UPDATE sync_book_epochs SET ended_at=$3,end_sequence=$4 WHERE book_id=$1 AND book_epoch=$2", [bookId, book.book_epoch, timestamp, current]);
      await client.query("INSERT INTO sync_book_epochs(book_id,book_epoch,epoch_number,start_sequence,previous_epoch,reason,advanced_by,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [bookId, nextEpoch, nextNumber, book.next_sequence, book.book_epoch, input.reason, input.advancedBy, timestamp]);
      await client.query("UPDATE sync_books SET book_epoch=$2,epoch_number=$3,epoch_started_at=$4,updated_at=$4 WHERE book_id=$1", [bookId, nextEpoch, nextNumber, timestamp]);
      await client.query("UPDATE sync_devices SET revoked_at=COALESCE(revoked_at,$2),revocation_reason=COALESCE(revocation_reason,'book_epoch_advanced') WHERE book_id=$1", [bookId, timestamp]);
      await client.query("COMMIT");
      return { bookId, bookEpoch: nextEpoch, epochNumber: nextNumber, epochStartSequence: Number(book.next_sequence), currentSequence: current, startedAt: timestamp, previousEpoch: book.book_epoch, reason: input.reason, advancedBy: input.advancedBy };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async saveSnapshot(bookId: string, input: SnapshotInput): Promise<SnapshotRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const book = (await client.query<BookRow>("SELECT b.book_epoch,b.epoch_number,b.epoch_started_at,b.next_sequence,e.start_sequence FROM sync_books b JOIN sync_book_epochs e ON e.book_id=b.book_id AND e.book_epoch=b.book_epoch WHERE b.book_id=$1 FOR UPDATE OF b", [bookId])).rows[0];
      if (!book || book.book_epoch !== input.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
      if (input.throughSequence < Number(book.start_sequence || 1) - 1 || input.throughSequence > Number(book.next_sequence) - 1) throw new StoreConflictError("snapshot sequence is outside the current epoch");
      const checkpointHash = await canonicalHash(client, bookId, input.bookEpoch, input.throughSequence);
      if (checkpointHash !== input.checkpointHash) throw new StoreConflictError("snapshot checkpoint does not match canonical history");
      const aggregateRevisions = await canonicalAggregateRevisions(client, bookId, input.bookEpoch, input.throughSequence);
      const payloadHash = hashPayload(input.payload);
      if (input.payloadHash && input.payloadHash !== payloadHash) throw new StoreConflictError("snapshot payload hash does not match payload");
      const row = (await client.query<SnapshotRow>(
        `INSERT INTO sync_snapshots(snapshot_id,book_id,book_epoch,through_sequence,schema_version,payload,payload_hash,checkpoint_hash,aggregate_revisions,projection_hash,created_by)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11)
         ON CONFLICT(book_id,book_epoch,through_sequence,payload_hash) DO UPDATE SET checkpoint_hash=EXCLUDED.checkpoint_hash,aggregate_revisions=EXCLUDED.aggregate_revisions,projection_hash=EXCLUDED.projection_hash,created_by=EXCLUDED.created_by
         RETURNING *`,
        [randomUUID(), bookId, input.bookEpoch, input.throughSequence, input.schemaVersion, JSON.stringify(input.payload), payloadHash, checkpointHash, JSON.stringify(aggregateRevisions), input.projectionHash || null, input.createdBy || null],
      )).rows[0];
      if (!row) throw new Error("PostgreSQL did not save snapshot");
      await client.query("COMMIT");
      return snapshot(row);
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async latestSnapshot(bookId: string, bookEpoch?: string): Promise<SnapshotRecord | null> {
    const epoch = bookEpoch || (await this.getBookEpoch(bookId))?.bookEpoch;
    if (!epoch) return null;
    const row = (await this.pool.query<SnapshotRow>("SELECT * FROM sync_snapshots WHERE book_id=$1 AND book_epoch=$2 ORDER BY through_sequence DESC,created_at DESC LIMIT 1", [bookId, epoch])).rows[0];
    return row ? snapshot(row) : null;
  }

  async verifyCheckpoint(bookId: string, input: CheckpointVerificationInput): Promise<CheckpointVerification> {
    const book = await this.getBookEpoch(bookId);
    if (!book || book.bookEpoch !== input.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
    if (input.throughSequence < book.epochStartSequence - 1 || input.throughSequence > book.currentSequence) throw new StoreConflictError("checkpoint sequence is outside the current epoch");
    const serverEventHash = await canonicalHash(this.pool, bookId, input.bookEpoch, input.throughSequence);
    const verifiedAt = new Date().toISOString();
    await this.pool.query("INSERT INTO sync_checkpoints(book_id,book_epoch,through_sequence,event_hash,last_verified_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(book_id,book_epoch,through_sequence) DO UPDATE SET event_hash=EXCLUDED.event_hash,last_verified_at=EXCLUDED.last_verified_at", [bookId, input.bookEpoch, input.throughSequence, serverEventHash, verifiedAt]);
    let projectionHashMatches: boolean | undefined;
    if (input.projectionHash) {
      const peers = await this.listProjectionHashes(bookId, input.bookEpoch, input.throughSequence);
      projectionHashMatches = peers.every((item) => item.sourceId === (input.sourceId || "unknown") || item.projectionHash === input.projectionHash);
      await this.recordProjectionHash(bookId, { bookEpoch: input.bookEpoch, throughSequence: input.throughSequence, sourceId: input.sourceId || "unknown", projectionHash: input.projectionHash });
    }
    return { bookId, bookEpoch: input.bookEpoch, throughSequence: input.throughSequence, serverEventHash, ...(input.eventHash ? { suppliedEventHash: input.eventHash } : {}), eventHashMatches: input.eventHash ? input.eventHash === serverEventHash : true, ...(projectionHashMatches === undefined ? {} : { projectionHashMatches }), verifiedAt };
  }

  async recordProjectionHash(bookId: string, input: Omit<ProjectionHashRecord, "bookId" | "recordedAt">): Promise<ProjectionHashRecord> {
    const book = await this.getBookEpoch(bookId);
    if (!book || book.bookEpoch !== input.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
    if (input.throughSequence < book.epochStartSequence - 1 || input.throughSequence > book.currentSequence) throw new StoreConflictError("projection sequence is outside the current epoch");
    const row = (await this.pool.query<ProjectionRow>("INSERT INTO sync_projection_hashes(book_id,book_epoch,through_sequence,source_id,projection_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(book_id,book_epoch,through_sequence,source_id) DO UPDATE SET projection_hash=EXCLUDED.projection_hash,recorded_at=now() RETURNING *", [bookId, input.bookEpoch, input.throughSequence, input.sourceId, input.projectionHash])).rows[0];
    if (!row) throw new Error("PostgreSQL did not save projection hash");
    return projection(row);
  }

  async listProjectionHashes(bookId: string, bookEpoch: string, throughSequence: number): Promise<ProjectionHashRecord[]> {
    return (await this.pool.query<ProjectionRow>("SELECT * FROM sync_projection_hashes WHERE book_id=$1 AND book_epoch=$2 AND through_sequence=$3 ORDER BY source_id", [bookId, bookEpoch, throughSequence])).rows.map(projection);
  }

  async recordConflict(input: ConflictEvidence): Promise<StoredConflict> {
    const row = (await this.pool.query<ConflictRow>(
      `INSERT INTO sync_conflicts(book_id,book_epoch,op_id,aggregate_id,canonical_op_id,reason,local_operation,canonical_event,base_revision,canonical_revision,details)
       SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb FROM sync_books WHERE book_id=$1
       ON CONFLICT(book_id,book_epoch,op_id,reason) WHERE status='open' DO NOTHING RETURNING *`,
      [input.bookId, input.bookEpoch, input.opId, input.aggregateId || null, input.canonicalEvent?.opId || null, input.reason, input.localOperation ? JSON.stringify(input.localOperation) : null, input.canonicalEvent ? JSON.stringify(input.canonicalEvent) : null, input.baseRevision ?? null, input.canonicalRevision ?? null, JSON.stringify(input.details || {})],
    )).rows[0];
    if (row) return conflict(row);
    const prior = (await this.pool.query<ConflictRow>("SELECT * FROM sync_conflicts WHERE book_id=$1 AND book_epoch=$2 AND op_id=$3 AND reason=$4 AND status='open' ORDER BY conflict_id DESC LIMIT 1", [input.bookId, input.bookEpoch, input.opId, input.reason])).rows[0];
    if (!prior) throw new Error(`cannot persist conflict because book ${input.bookId} does not exist`);
    return conflict(prior);
  }

  async listConflicts(bookId: string, status?: ConflictStatus): Promise<StoredConflict[]> {
    const rows = status
      ? (await this.pool.query<ConflictRow>("SELECT * FROM sync_conflicts WHERE book_id=$1 AND status=$2 ORDER BY created_at DESC", [bookId, status])).rows
      : (await this.pool.query<ConflictRow>("SELECT * FROM sync_conflicts WHERE book_id=$1 ORDER BY created_at DESC", [bookId])).rows;
    return rows.map(conflict);
  }

  async resolveConflict(bookId: string, conflictId: string, resolution: { resolutionType: string; resolutionOpId?: string; resolvedBy: string }): Promise<StoredConflict> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = (await client.query<BookRow>("SELECT b.book_epoch,b.epoch_number,b.epoch_started_at,b.next_sequence,e.start_sequence FROM sync_books b JOIN sync_book_epochs e ON e.book_id=b.book_id AND e.book_epoch=b.book_epoch WHERE b.book_id=$1 FOR UPDATE", [bookId])).rows[0];
      if (!state) throw new StoreConflictError(`book ${bookId} does not exist`);
      let row = (await client.query<ConflictRow>("SELECT * FROM sync_conflicts WHERE conflict_id=$1 AND book_id=$2 FOR UPDATE", [conflictId, bookId])).rows[0];
      if (!row) throw new StoreConflictError(`conflict ${conflictId} does not exist`);
      const stored = conflict(row);
      if (resolution.resolutionOpId) {
        const linked = (await client.query<EventRow>("SELECT book_id,book_sequence,aggregate_revision,op_id,payload_hash,operation,accepted_at FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND op_id=$3", [bookId, state.book_epoch, resolution.resolutionOpId])).rows[0];
        if (!linked) throw new StoreConflictError("conflict resolution operation does not belong to the active book epoch");
        assertConflictResolutionEvent(stored, resolution.resolutionType, event(linked));
      }
      if (stored.status === "open") row = (await client.query<ConflictRow>("UPDATE sync_conflicts SET status='resolved',resolution_type=$3,resolution_op_id=$4,resolved_by=$5,resolved_at=now() WHERE conflict_id=$1 AND book_id=$2 RETURNING *", [conflictId, bookId, resolution.resolutionType, resolution.resolutionOpId || null, resolution.resolvedBy])).rows[0]!;
      await client.query("COMMIT");
      return conflict(row);
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

export async function runSyncMigrations(pool: PgPool): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("../migrations/001_sync.sql", import.meta.url)), "utf8");
  await pool.query(sql);
}
