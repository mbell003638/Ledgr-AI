import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, BookMembershipAuthorizer, type SyncPrincipal } from "../auth.js";
import { ArbitrationError, DefaultAccountingArbitrator } from "../arbitration.js";
import { hashPayload, type SyncOperation } from "../protocol.js";
import { PostgresBookAuthorizer } from "../postgres.js";

const principal: SyncPrincipal = { subject: "user-1", scopes: new Set(), books: new Set(["book-1"]), claims: {} };
const operation = (payload: unknown, commandType = "note.create"): SyncOperation => ({ protocolVersion: 1, payloadVersion: 1, opId: "op-1", bookId: "book-1", bookEpoch: "epoch-1", deviceId: "device-1", deviceSequence: 1, actorId: "user-1", commandType, aggregateId: "aggregate-1", payload, payloadHash: hashPayload(payload), clientCreatedAt: "2026-08-20T00:00:00.000Z" });

test("book membership authorizer denies unlisted books", () => {
  assert.throws(() => new BookMembershipAuthorizer().authorize(principal, "book-2", "pull"), AuthorizationError);
});

test("accounting arbitrator rejects unbalanced journals", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ lines: [{ debit: 10 }, { credit: 9 }] }, "journal.post")] }), ArbitrationError);
});

test("accounting arbitrator accepts balanced journals", async () => {
  await new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ lines: [{ debit: 10 }, { credit: 10 }] }, "journal.post")] });
});

test("accounting arbitrator rejects an actor different from the authenticated principal", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({
    bookId: "book-1", principal, operations: [{ ...operation({ lines: [{ debit: 10 }, { credit: 10 }] }, "journal.post"), actorId: "other-user" }],
  }), /actor does not match/);
});

test("accounting arbitrator requires period-close revision and validates inventory counts", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ date: "2026-08-20" }, "period.close")] }), /requires a baseRevision/);
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ date: "2026-08-20", value: -1 }, "inventory.count.record"), baseRevision: 0 }] }), /non-negative/);
  await new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ date: "2026-08-20", value: 10 }, "inventory.count.record"), baseRevision: 0 }] });
});

test("accounting arbitrator validates allocation and location-transfer references", async () => {
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ amount: 5 }, "receipt.allocate"), baseRevision: 0 }] }), /requires invoiceSourceId/);
  await assert.rejects(() => new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [operation({ fromLocationId: "a", toLocationId: "a", qty: 1 }, "location.transfer_stock")] }), /distinct/);
  await new DefaultAccountingArbitrator().validate({ bookId: "book-1", principal, operations: [{ ...operation({ invoiceSourceId: "invoice-1", receiptSourceId: "receipt-1", amount: 5 }, "receipt.allocate"), baseRevision: 0 }] });
});

test("PostgreSQL authorizer rejects a revoked device", async () => {
  const pool = {
    query: async (sql: string) => sql.includes("SELECT subject, revoked_at")
      ? { rows: [{ subject: "user-1", revoked_at: "2026-08-20T00:00:00.000Z" }] }
      : { rows: [] },
  } as any;
  await assert.rejects(() => new PostgresBookAuthorizer(pool).authorize(principal, "book-1", "pull", "device-1"), /revoked/);
});
