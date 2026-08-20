import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CanonicalEvent, hashPayload, SyncOperation } from "./protocol.js";
import { EventStore, StoreConflictError } from "./store.js";
import { AuthorizationError, Authorizer, SyncPrincipal } from "./auth.js";

export type PgResult<T> = { rows: T[] };
export type PgClient = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>>; release(): void };
export type PgPool = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>>; connect(): Promise<PgClient> };

/** Optional database-backed membership authorizer. Token claims remain a fast path for bootstrap/admin scopes. */
export class PostgresBookAuthorizer implements Authorizer {
  constructor(private readonly pool: PgPool) {}
  async authorize(principal: SyncPrincipal, bookId: string, action: "pull" | "push", deviceId?: string): Promise<void> {
    const claimAllowed = principal.books.has("*") || principal.books.has(bookId) || principal.scopes.has("sync:*") || principal.scopes.has(`sync:${action}`);
    if (!claimAllowed) {
      const rows = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id = $1 AND subject = $2", [bookId, principal.subject])).rows;
      const role = rows[0]?.role;
      if (!role || (action === "push" && role === "viewer")) throw new AuthorizationError(`principal is not authorized to ${action} book ${bookId}`);
    }
    if (deviceId) {
      const device = (await this.pool.query<{ subject: string; revoked_at: string | Date | null }>(
        "SELECT subject, revoked_at FROM sync_devices WHERE book_id = $1 AND device_id = $2",
        [bookId, deviceId],
      )).rows[0];
      if (device?.revoked_at) throw new AuthorizationError(`device ${deviceId} has been revoked`);
      if (device && device.subject !== principal.subject && !principal.scopes.has("sync:device-admin")) {
        throw new AuthorizationError(`device ${deviceId} belongs to another subject`);
      }
      if (!device) {
        await this.pool.query(
          "INSERT INTO sync_devices(book_id, device_id, subject) VALUES ($1, $2, $3) ON CONFLICT (book_id, device_id) DO NOTHING",
          [bookId, deviceId, principal.subject],
        );
      }
    }
  }

  async revokeDevice(principal: SyncPrincipal, bookId: string, deviceId: string): Promise<void> {
    if (!principal.scopes.has("sync:device-admin")) throw new AuthorizationError("device administration scope is required");
    const result = await this.pool.query<{ device_id: string }>("UPDATE sync_devices SET revoked_at = now() WHERE book_id = $1 AND device_id = $2 RETURNING device_id", [bookId, deviceId]);
    if (result.rows.length === 0) throw new AuthorizationError(`device ${deviceId} is not registered for book ${bookId}`);
  }
}

type EventRow = { book_id: string; book_sequence: string | number; aggregate_revision: string | number; op_id: string; payload_hash: string; operation: SyncOperation; accepted_at: string | Date };
type BookRow = { book_epoch: string; next_sequence: string | number };

function event(row: EventRow): CanonicalEvent {
  const operation = typeof row.operation === "string" ? JSON.parse(row.operation) as SyncOperation : row.operation;
  return { ...operation, aggregateRevision: Number(row.aggregate_revision), bookSequence: Number(row.book_sequence), acceptedAt: new Date(row.accepted_at).toISOString() };
}

/** PostgreSQL implementation. The caller owns pool lifecycle and must run migrations first. */
export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: PgPool) {}

  async append(bookId: string, operations: SyncOperation[]): Promise<CanonicalEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const epoch = operations[0]?.bookEpoch;
      if (!epoch) throw new StoreConflictError("book epoch is required");
      await client.query("INSERT INTO sync_books(book_id, book_epoch) VALUES ($1, $2) ON CONFLICT (book_id) DO NOTHING", [bookId, epoch]);
      const book = (await client.query<BookRow>("SELECT book_epoch, next_sequence FROM sync_books WHERE book_id = $1 FOR UPDATE", [bookId])).rows[0];
      if (!book || book.book_epoch !== epoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
      const accepted: CanonicalEvent[] = [];
      const seen = new Set<string>();
      for (const operation of operations) {
        if (operation.bookId !== bookId) throw new StoreConflictError("operation bookId does not match batch bookId");
        if (seen.has(operation.opId)) throw new StoreConflictError(`duplicate opId in batch: ${operation.opId}`);
        seen.add(operation.opId);
        const existing = (await client.query<EventRow>("SELECT book_id, book_sequence, op_id, payload_hash, operation, accepted_at FROM sync_events WHERE op_id = $1", [operation.opId])).rows[0];
        if (existing) {
          if (existing.payload_hash !== operation.payloadHash) throw new StoreConflictError(`opId already exists with a different payload: ${operation.opId}`);
          accepted.push(event(existing));
          continue;
        }
        const sequenceKey = await client.query<{ op_id: string }>("SELECT op_id FROM sync_events WHERE book_id = $1 AND device_id = $2 AND device_sequence = $3", [bookId, operation.deviceId, operation.deviceSequence]);
        if (sequenceKey.rows.length > 0) throw new StoreConflictError(`device sequence already belongs to another operation: ${operation.deviceId}:${operation.deviceSequence}`);
        const revisionRow = (await client.query<{ revision: string | number }>(
          "SELECT COALESCE(MAX(aggregate_revision), 0) AS revision FROM sync_events WHERE book_id = $1 AND operation->>'aggregateId' = $2",
          [bookId, operation.aggregateId],
        )).rows[0];
        const currentRevision = Number(revisionRow?.revision || 0);
        if (operation.baseRevision !== undefined && operation.baseRevision !== null && operation.baseRevision !== currentRevision) {
          throw new StoreConflictError(`aggregate revision conflict for ${operation.aggregateId}: expected ${currentRevision}, received ${operation.baseRevision}`);
        }
        const aggregateRevision = currentRevision + 1;
        const next = Number(book.next_sequence);
        const inserted = (await client.query<EventRow>(
          "INSERT INTO sync_events(book_id, book_sequence, aggregate_revision, op_id, device_id, device_sequence, payload_hash, operation) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING book_id, book_sequence, aggregate_revision, op_id, payload_hash, operation, accepted_at",
          [bookId, next, aggregateRevision, operation.opId, operation.deviceId, operation.deviceSequence, operation.payloadHash, JSON.stringify(operation)],
        )).rows[0];
        if (!inserted) throw new Error("PostgreSQL did not return inserted event");
        book.next_sequence = next + 1;
        await client.query("UPDATE sync_books SET next_sequence = $2 WHERE book_id = $1", [bookId, book.next_sequence]);
        accepted.push(event(inserted));
      }
      await client.query("COMMIT");
      return accepted;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof StoreConflictError && operations[0]) {
        await this.pool.query(
          "INSERT INTO sync_conflicts(book_id, op_id, reason, details) VALUES ($1, $2, $3, $4::jsonb)",
          [bookId, operations[0].opId, error.message, JSON.stringify({ operationCount: operations.length })],
        ).catch(() => undefined);
      }
      if (error instanceof StoreConflictError) throw error;
      const code = (error as { code?: string }).code;
      if (code === "23505") throw new StoreConflictError("operation conflicts with an existing event");
      throw error;
    } finally { client.release(); }
  }

  async pull(bookId: string, after: number, limit: number) {
    const rows = (await this.pool.query<EventRow>(
      "SELECT book_id, book_sequence, aggregate_revision, op_id, payload_hash, operation, accepted_at FROM sync_events WHERE book_id = $1 AND book_sequence > $2 ORDER BY book_sequence ASC LIMIT $3",
      [bookId, after, limit],
    )).rows;
    const events = rows.map(event);
    const cursor = events.length > 0 ? events[events.length - 1].bookSequence : after;
    const more = (await this.pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM sync_events WHERE book_id = $1 AND book_sequence > $2) AS exists", [bookId, cursor])).rows[0]?.exists ?? false;
    const checkpointRows = (await this.pool.query<{ op_id: string; book_sequence: string | number; aggregate_revision: string | number }>(
      "SELECT op_id, book_sequence, aggregate_revision FROM sync_events WHERE book_id = $1 AND book_sequence <= $2 ORDER BY book_sequence ASC",
      [bookId, cursor],
    )).rows;
    const checkpointHash = hashPayload(checkpointRows.map((row) => ({ opId: row.op_id, bookSequence: Number(row.book_sequence), aggregateRevision: Number(row.aggregate_revision) })));
    return { events, cursor, hasMore: more, checkpointHash };
  }
}

export async function runSyncMigrations(pool: PgPool): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("../migrations/001_sync.sql", import.meta.url)), "utf8");
  await pool.query(sql);
}
