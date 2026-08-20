import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import { EventStore, StoreConflictError } from "./store.js";
import { MAX_BATCH_SIZE, PROTOCOL_VERSION, ProtocolError, parsePushRequest } from "./protocol.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(data);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ProtocolError("request body is too large", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new ProtocolError("request body is required");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ProtocolError("request body must be valid JSON"); }
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new ProtocolError("cursor/limit must be a valid non-negative integer");
  return parsed;
}

export function createServer(store: EventStore): Server {
  return createHttpServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type, authorization");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") { json(response, 200, { status: "ok", service: "ledgr-sync-server" }); return; }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        json(response, 200, { protocolVersion: PROTOCOL_VERSION, maxBatchSize: MAX_BATCH_SIZE, features: ["cursor-pull", "idempotent-operations", "in-memory-reference-store"], productionReady: false }); return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sync/push") {
        const result = parsePushRequest(await body(request));
        const accepted = await store.append(result.bookId, result.operations);
        json(response, 200, { accepted, cursor: accepted.reduce((max, item) => Math.max(max, item.bookSequence), 0) }); return;
      }
      if (request.method === "GET" && url.pathname === "/v1/sync/pull") {
        const bookId = url.searchParams.get("bookId");
        if (!bookId) throw new ProtocolError("bookId query parameter is required");
        const after = positiveInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
        const requestedLimit = positiveInteger(url.searchParams.get("limit"), MAX_BATCH_SIZE, MAX_BATCH_SIZE);
        if (requestedLimit < 1) throw new ProtocolError("limit must be at least 1");
        const limit = Math.min(requestedLimit, MAX_BATCH_SIZE);
        json(response, 200, await store.pull(bookId, after, limit)); return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ProtocolError) { json(response, error.status, { error: "invalid_request", message: error.message }); return; }
      if (error instanceof StoreConflictError) { json(response, 409, { error: "conflict", message: error.message }); return; }
      console.error(error);
      json(response, 500, { error: "internal_error" });
    }
  });
}
