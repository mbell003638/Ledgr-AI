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
  const pulled = await fetch(`${base}/v1/sync/pull?bookId=book-http&after=0`);
  assert.equal(pulled.status, 200);
  const result = await pulled.json() as { events: unknown[]; cursor: number };
  assert.equal(result.events.length, 1);
  assert.equal(result.cursor, 1);
});
