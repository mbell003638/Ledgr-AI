import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CanonicalEvent, SyncOperation } from "./protocol.js";
import { EventStore, StoreConflictError } from "./store.js";
import { AuthorizationError, Authorizer, SyncPrincipal } from "./auth.js";

export type PgResult<T> = { rows: T[] };
export type PgClient = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>>; release(): void };
export type PgPool = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<T>>; connect(): Promise<PgClient> };

/** Optional database-backed membership authorizer. Token claims remain a fast path for bootstrap/admin scopes. */
export class PostgresBookAuthorizer implements Authorizer {
  constructor(private readonly pool: PgPool) {}
  async authorize(principal: SyncPrincipal, bookId: string, action: "pull" | "push"): Promise<void> {
    if (principal.books.has("*") || principal.books.has(bookId) || principal.scopes.has("sync:*") || principal.scopes.has(`sync:${action}`)) return;
    const rows = (await this.pool.query<{ role: string }>("SELECT role FROM sync_memberships WHERE book_id = $1 AND subject = $2", [bookId, principal.subject])).rows;
    const role = rows[0]?.role;
    if (!role || (action === "push" && role === "viewer")) throw new AuthorizationError(`principal is not authorized to ${action} book ${bookId}`);
  }
}

type EventRow = { book_id: string; book_sequence: string | number; op_id: string; payload_hash: string; operation: SyncOperation; accepted_at: string | Date };
type BookRow = { book_epoch: string; next_sequence: string | number };

function event(row: EventRow): CanonicalEvent {
  const operation = typeof row.operation === "string" ? JSON.parse(row.operation) as SyncOperation : row.operation;
  return { ...operation, bookSequence: Number(row.book_sequence), acceptedAt: new Date(row.accepted_at).toISOString() };
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
        const next = Number(book.next_sequence);
        const inserted = (await client.query<EventRow>(
          "INSERT INTO sync_events(book_id, book_sequence, op_id, device_id, device_sequence, payload_hash, operation) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING book_id, book_sequence, op_id, payload_hash, operation, accepted_at",
          [bookId, next, operation.opId, operation.deviceId, operation.deviceSequence, operation.payloadHash, JSON.stringify(operation)],
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
      "SELECT book_id, book_sequence, op_id, payload_hash, operation, accepted_at FROM sync_events WHERE book_id = $1 AND book_sequence > $2 ORDER BY book_sequence ASC LIMIT $3",
      [bookId, after, limit],
    )).rows;
    const events = rows.map(event);
    const cursor = events.length > 0 ? events[events.length - 1].bookSequence : after;
    const more = (await this.pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM sync_events WHERE book_id = $1 AND book_sequence > $2) AS exists", [bookId, cursor])).rows[0]?.exists ?? false;
    return { events, cursor, hasMore: more };
  }
}

export async function runSyncMigrations(pool: PgPool): Promise<void> {
  const sql = await readFile(fileURLToPath(new URL("../migrations/001_sync.sql", import.meta.url)), "utf8");
  await pool.query(sql);
}
