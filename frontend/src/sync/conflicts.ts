import type { SqlRunner } from "@/src/db/schema";

export type SyncConflict = {
  conflictId: string;
  bookId: string;
  opId: string;
  canonicalOpId: string | null;
  reason: string;
  status: "open" | "resolved" | "ignored";
  basePayload: unknown;
  localPayload: unknown;
  canonicalPayload: unknown;
  createdAt: string;
  resolvedAt: string | null;
};

function json(value: string | null | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function map(row: any): SyncConflict {
  return {
    conflictId: String(row.conflict_id), bookId: String(row.book_id), opId: String(row.op_id),
    canonicalOpId: row.canonical_op_id == null ? null : String(row.canonical_op_id), reason: String(row.reason),
    status: row.status === "resolved" || row.status === "ignored" ? row.status : "open",
    basePayload: json(row.base_payload), localPayload: json(row.local_payload), canonicalPayload: json(row.canonical_payload),
    createdAt: String(row.created_at), resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
  };
}

export async function listOpenSyncConflicts(db: SqlRunner, bookId: string): Promise<SyncConflict[]> {
  const rows = await db.all<any>("SELECT * FROM sync_conflicts WHERE book_id=? AND status='open' ORDER BY created_at DESC", [bookId]);
  return rows.map(map);
}

/** Resolve only the inbox item. It deliberately does not mutate accounting rows or overwrite either payload. */
export async function markSyncConflictResolved(db: SqlRunner, conflictId: string): Promise<void> {
  await db.run("UPDATE sync_conflicts SET status='resolved',resolved_at=? WHERE conflict_id=? AND status='open'", [new Date().toISOString(), conflictId]);
}
