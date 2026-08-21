import assert from "node:assert/strict";
import test from "node:test";
import { hashPayload, SyncOperation } from "../protocol.js";
import { MemoryEventStore, StoreConflictError } from "../store.js";

function operation(opId: string, sequence: number, payload: unknown): SyncOperation {
  return { protocolVersion: 1, payloadVersion: 1, opId, bookId: "book-a", bookEpoch: "epoch-a", deviceId: "device-a", deviceSequence: sequence, actorId: "user-a", commandType: "party.patch", aggregateId: "party-a", payload, payloadHash: hashPayload(payload), clientCreatedAt: "2026-08-20T00:00:00.000Z" };
}

test("append assigns book sequences and retries are idempotent", async () => {
  const store = new MemoryEventStore();
  const first = await store.append("book-a", [operation("op-1", 1, { name: "A" })]);
  const retry = await store.append("book-a", [operation("op-1", 1, { name: "A" })]);
  assert.equal(first[0].bookSequence, 1);
  assert.deepEqual(retry[0], first[0]);
});

test("reusing an operation id with another payload is rejected", async () => {
  const store = new MemoryEventStore();
  await store.append("book-a", [operation("op-1", 1, { name: "A" })]);
  await assert.rejects(() => store.append("book-a", [operation("op-1", 1, { name: "B" })]), StoreConflictError);
});

test("pull uses an exclusive cursor and reports more pages", async () => {
  const store = new MemoryEventStore();
  await store.append("book-a", [operation("op-1", 1, { name: "A" }), operation("op-2", 2, { name: "B" })]);
  const page = await store.pull("book-a", 0, 1);
  assert.equal(page.events.length, 1);
  assert.equal(page.cursor, 1);
  assert.equal(page.hasMore, true);
});

test("rejects stale epochs and reused device sequences", async () => {
  const store = new MemoryEventStore();
  await store.append("book-a", [operation("op-1", 1, { name: "A" })]);
  await assert.rejects(() => store.append("book-a", [{ ...operation("op-2", 2, { name: "B" }), bookEpoch: "epoch-old" }]), StoreConflictError);
  await assert.rejects(() => store.append("book-a", [operation("op-3", 1, { name: "C" })]), StoreConflictError);
});

test("does not partially append a conflicting batch", async () => {
  const store = new MemoryEventStore();
  await assert.rejects(() => store.append("book-a", [
    operation("op-1", 1, { name: "A" }),
    operation("op-2", 1, { name: "B" }),
  ]), /device sequence is duplicated/);
  const pulled = await store.pull("book-a", 0, 10);
  assert.equal(pulled.events.length, 0);
});

test("accepts independent operations from two offline devices in canonical order", async () => {
  const store = new MemoryEventStore();
  const first = { ...operation("op-a", 1, { amount: 10 }), deviceId: "device-a", actorId: "user-a", aggregateId: "sale-a" };
  const second = { ...operation("op-b", 1, { amount: 20 }), deviceId: "device-b", actorId: "user-b", aggregateId: "sale-b" };
  const accepted = await store.append("book-a", [first, second]);
  assert.deepEqual(accepted.map((event) => event.bookSequence), [1, 2]);
  assert.deepEqual(accepted.map((event) => event.aggregateRevision), [1, 1]);
  const deviceA = await store.pull("book-a", 0, 10);
  const deviceB = await store.pull("book-a", 0, 10);
  assert.deepEqual(deviceA.events.map((event) => event.opId), deviceB.events.map((event) => event.opId));
  assert.equal(typeof deviceA.checkpointHash, "string");
});

test("rejects stale same-aggregate edits instead of last-write-wins", async () => {
  const store = new MemoryEventStore();
  const first = { ...operation("op-rev-1", 1, { name: "A" }), aggregateId: "party-1", baseRevision: 0 };
  await store.append("book-a", [first]);
  const stale = { ...operation("op-rev-2", 1, { name: "B" }), deviceId: "device-b", actorId: "user-b", aggregateId: "party-1", baseRevision: 0 };
  await assert.rejects(() => store.append("book-a", [stale]), /aggregate revision conflict/);
});

test("payload hashing matches JSON transport semantics", () => {
  assert.equal(hashPayload({ b: undefined, a: [undefined, 1] }), hashPayload({ a: [null, 1] }));
});

test("epoch replacement preserves history and isolates the active pull cursor", async () => {
  const store = new MemoryEventStore();
  await store.createBook("book-a", "epoch-a");
  await store.append("book-a", [operation("op-old", 1, { name: "Old" })]);
  const advanced = await store.advanceEpoch("book-a", { expectedEpoch: "epoch-a", expectedSequence: 1, newEpoch: "epoch-b", reason: "restore", advancedBy: "owner-a" });
  assert.equal(advanced.previousEpoch, "epoch-a");
  assert.equal(advanced.epochStartSequence, 2);
  const fresh = { ...operation("op-new", 1, { name: "New" }), bookEpoch: "epoch-b" };
  await store.append("book-a", [fresh]);
  const page = await store.pull("book-a", 0, 10);
  assert.deepEqual(page.events.map((event) => event.opId), ["op-new"]);
  assert.equal(page.cursor, 2);
  await assert.rejects(() => store.append("book-a", [{ ...operation("op-stale", 2, { name: "Stale" }), bookEpoch: "epoch-a" }]), /epoch mismatch/);
});

test("snapshots and projection checkpoints fail closed on mismatches", async () => {
  const store = new MemoryEventStore();
  await store.createBook("book-a", "epoch-a");
  await store.append("book-a", [operation("op-1", 1, { name: "A" })]);
  const checkpoint = await store.verifyCheckpoint("book-a", { bookEpoch: "epoch-a", throughSequence: 1 });
  await assert.rejects(() => store.saveSnapshot("book-a", { bookEpoch: "epoch-a", throughSequence: 1, schemaVersion: 1, payload: { book: "A" }, payloadHash: "wrong", checkpointHash: checkpoint.serverEventHash }), /payload hash/);
  const saved = await store.saveSnapshot("book-a", { bookEpoch: "epoch-a", throughSequence: 1, schemaVersion: 1, payload: { book: "A" }, checkpointHash: checkpoint.serverEventHash, projectionHash: "projection-a" });
  assert.deepEqual({ ...saved.aggregateRevisions }, { "party-a": 1 });
  assert.equal((await store.latestSnapshot("book-a"))?.snapshotId, saved.snapshotId);
  const first = await store.verifyCheckpoint("book-a", { bookEpoch: "epoch-a", throughSequence: 1, eventHash: checkpoint.serverEventHash, projectionHash: "projection-a", sourceId: "device-a" });
  assert.equal(first.eventHashMatches, true);
  assert.equal(first.projectionHashMatches, true);
  const divergent = await store.verifyCheckpoint("book-a", { bookEpoch: "epoch-a", throughSequence: 1, eventHash: checkpoint.serverEventHash, projectionHash: "projection-b", sourceId: "device-b" });
  assert.equal(divergent.projectionHashMatches, false);
});

test("snapshot aggregate revisions are server-computed at the checkpoint", async () => {
  const store = new MemoryEventStore();
  await store.createBook("book-a", "epoch-a");
  await store.append("book-a", [
    { ...operation("op-a1", 1, { name: "A1" }), aggregateId: "aggregate-a", baseRevision: 0 },
    { ...operation("op-a2", 2, { name: "A2" }), aggregateId: "aggregate-a", baseRevision: 1 },
    { ...operation("op-b1", 3, { name: "B1" }), aggregateId: "aggregate-b", baseRevision: 0 },
  ]);
  const checkpoint = await store.verifyCheckpoint("book-a", { bookEpoch: "epoch-a", throughSequence: 2 });
  const input = { bookEpoch: "epoch-a", throughSequence: 2, schemaVersion: 1, payload: { book: "A" }, checkpointHash: checkpoint.serverEventHash, aggregateRevisions: { attacker: 999 } };
  const saved = await store.saveSnapshot("book-a", input);
  assert.deepEqual({ ...saved.aggregateRevisions }, { "aggregate-a": 2 });
  assert.equal("attacker" in saved.aggregateRevisions, false);
});

test("conflict correction resolution requires canonical dependency and audit link", async () => {
  const store = new MemoryEventStore();
  await store.createBook("book-a", "epoch-a");
  const canonical = (await store.append("book-a", [{ ...operation("op-canonical", 1, { name: "Canonical" }), aggregateId: "party-1", baseRevision: 0 }]))[0];
  const local = { ...operation("op-local", 1, { name: "Local" }), deviceId: "device-b", aggregateId: "party-1", baseRevision: 0 };
  const conflict = await store.recordConflict({ bookId: "book-a", bookEpoch: "epoch-a", opId: local.opId, aggregateId: local.aggregateId, reason: "aggregate_revision_conflict", localOperation: local, canonicalEvent: canonical, baseRevision: 0, canonicalRevision: 1 });
  const correctionPayload = { conflictId: conflict.conflictId, reason: "Correct classification", posting: { date: "2026-08-20", lines: [{ debit: 10 }, { credit: 10 }] } };
  const correction = {
    ...operation("op-correction", 2, correctionPayload),
    commandType: "accounting.correction.post",
    aggregateId: "party-1",
    baseRevision: 1,
    dependencies: [canonical.opId],
  };
  await store.append("book-a", [correction]);
  const resolved = await store.resolveConflict("book-a", conflict.conflictId, { resolutionType: "correction", resolutionOpId: correction.opId, resolvedBy: "owner-a" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolutionOpId, correction.opId);
});
