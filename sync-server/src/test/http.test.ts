import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../server.js";
import { MemoryEventStore } from "../store.js";
import { hashPayload } from "../protocol.js";

test("HTTP health, push and pull endpoints work together", async (t) => {
  const server = createServer(new MemoryEventStore());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const payload = { description: "offline operation" };
  const operation = { protocolVersion: 1, payloadVersion: 1, opId: "op-http-1", bookId: "book-http", bookEpoch: "epoch-http", deviceId: "device-http", deviceSequence: 1, actorId: "user-http", commandType: "note.create", aggregateId: "note-http", payload, payloadHash: hashPayload(payload), clientCreatedAt: "2026-08-20T00:00:00.000Z" };
  const pushed = await fetch(`${base}/v1/sync/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookId: "book-http", operations: [operation] }) });
  assert.equal(pushed.status, 200);
  assert.equal((await fetch(`${base}/v1/sync/pull?bookId=book-http&after=0`)).status, 400);
  const pulled = await fetch(`${base}/v1/sync/pull?bookId=book-http&deviceId=device-http&after=0`);
  assert.equal(pulled.status, 200);
  const result = await pulled.json() as { events: unknown[]; cursor: number };
  assert.equal(result.events.length, 1);
  assert.equal(result.cursor, 1);
  assert.equal(typeof (result as { checkpointHash?: string }).checkpointHash, "string");
});

test("HTTP rejects a mixed-device push batch before it reaches the store", async (t) => {
  const server = createServer(new MemoryEventStore());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const makeOperation = (opId: string, deviceId: string) => {
    const payload = { value: opId };
    return { protocolVersion: 1, payloadVersion: 1, opId, bookId: "book-mixed", bookEpoch: "epoch-mixed", deviceId, deviceSequence: 1, actorId: "anonymous", commandType: "note.create", aggregateId: opId, payload, payloadHash: hashPayload(payload), clientCreatedAt: "2026-08-20T00:00:00.000Z" };
  };
  const response = await fetch(`${base}/v1/sync/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookId: "book-mixed", operations: [makeOperation("op-a", "device-a"), makeOperation("op-b", "device-b")] }),
  });
  assert.equal(response.status, 400);
});

test("HTTP snapshots expose only server-computed aggregate revisions", async (t) => {
  const store = new MemoryEventStore();
  const server = createServer(store, { recoveryStore: store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const enrolled = await fetch(`${base}/v1/sync/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookId: "book-snapshot", deviceId: "device-snapshot" }) });
  assert.equal(enrolled.status, 200);
  const enrollment = await enrolled.json() as { bookEpoch: string };
  const operationPayload = { displayName: "Canonical" };
  const operation = { protocolVersion: 1, payloadVersion: 1, opId: "op-snapshot-1", bookId: "book-snapshot", bookEpoch: enrollment.bookEpoch, deviceId: "device-snapshot", deviceSequence: 1, actorId: "anonymous", commandType: "party.patch", aggregateId: "party-snapshot", baseRevision: 0, payload: operationPayload, payloadHash: hashPayload(operationPayload), clientCreatedAt: "2026-08-20T00:00:00.000Z" };
  const pushed = await fetch(`${base}/v1/sync/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookId: "book-snapshot", operations: [operation] }) });
  assert.equal(pushed.status, 200);
  const pulled = await (await fetch(`${base}/v1/sync/pull?bookId=book-snapshot&deviceId=device-snapshot&after=0`)).json() as { cursor: number; checkpointHash: string };
  const tableNames = ["v2_books", "v2_periods", "v2_personas", "v2_parties", "v2_accounts", "v2_locations", "v2_sources", "v2_journal_entries", "v2_journal_lines", "v2_invoice_allocations", "v2_inventory_counts", "v2_members", "v2_close_books", "v2_employees", "v2_pay_runs", "v2_payslips", "v2_products", "v2_stock_moves"];
  const tables = Object.fromEntries(tableNames.map((name) => [name, name === "v2_books" ? [{ id: "book-snapshot" }] : []]));
  const payload = { schemaVersion: 1, bookId: "book-snapshot", tables };
  const uploaded = await fetch(`${base}/v1/sync/snapshot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookId: "book-snapshot", deviceId: "device-snapshot", bookEpoch: enrollment.bookEpoch, throughSequence: pulled.cursor, schemaVersion: 1, payload, payloadHash: hashPayload(payload), checkpointHash: pulled.checkpointHash, projectionHash: hashPayload(payload), aggregateRevisions: { forged: 999 } }) });
  assert.equal(uploaded.status, 201);
  const saved = await uploaded.json() as { aggregateRevisions: Record<string, number> };
  assert.deepEqual(saved.aggregateRevisions, { "party-snapshot": 1 });
  const downloaded = await (await fetch(`${base}/v1/sync/snapshot?bookId=book-snapshot&deviceId=device-snapshot`)).json() as { aggregateRevisions: Record<string, number> };
  assert.deepEqual(downloaded.aggregateRevisions, { "party-snapshot": 1 });
});
