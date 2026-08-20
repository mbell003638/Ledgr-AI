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
