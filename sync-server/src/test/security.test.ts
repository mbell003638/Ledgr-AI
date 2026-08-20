import assert from "node:assert/strict";
import test from "node:test";
import { AuthorizationError, BookMembershipAuthorizer, type SyncPrincipal } from "../auth.js";
import { ArbitrationError, DefaultAccountingArbitrator } from "../arbitration.js";
import { hashPayload, type SyncOperation } from "../protocol.js";

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
