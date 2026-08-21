import { createServer as createHttpServer, IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import { EventStore, StoreConflictError } from "./store.js";
import { MAX_BATCH_SIZE, PAYLOAD_VERSION, PROTOCOL_VERSION, ProtocolError, SyncOperation, parsePushRequest } from "./protocol.js";
import { AnonymousAuthenticator, AuthenticationError, AuthorizationError, Authenticator, Authorizer, BookMembershipAuthorizer, SyncPrincipal } from "./auth.js";
import { AccountingArbitrator, ArbitrationError, NoopAccountingArbitrator } from "./arbitration.js";
import { ConflictStatus, RecoveryStore } from "./recovery.js";
import { FixedWindowRateLimiter, SyncMetrics, logRequest, remoteRateKey, requestId, safeTokenEqual } from "./operations.js";
import { DomainArbitrationFailure } from "./domainArbitration.js";
import { validateSnapshotProjection } from "./snapshotAccountingProjection.js";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function text(response: ServerResponse, status: number, value: string, contentType = "text/plain; charset=utf-8"): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.end(value);
}

async function body(request: IncomingMessage, maximumBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) throw new ProtocolError("request body is too large", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) throw new ProtocolError("request body is required");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProtocolError("request body must be valid JSON"); }
}

function record(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ProtocolError(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new ProtocolError("cursor/limit must be a valid non-negative integer");
  return parsed;
}

function numberField(value: unknown, field: string, minimum = 0): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new ProtocolError(`${field} must be a safe integer`);
  return result;
}

function bearer(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization;
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/iu.exec(value);
  return match?.[1];
}

function requireOperationsToken(request: IncomingMessage, expected: string | undefined): void {
  if (!expected || !safeTokenEqual(bearer(request.headers), expected)) throw new AuthenticationError("operations token is required");
}

function requireScope(principal: SyncPrincipal, ...scopes: string[]): void {
  if (!principal.scopes.has("sync:*") && !scopes.some((scope) => principal.scopes.has(scope))) throw new AuthorizationError(`one of these scopes is required: ${scopes.join(", ")}`);
}

type SyncRole = "owner" | "admin" | "accountant" | "editor" | "viewer" | "auditor";

type DeviceAdministration = Authorizer & {
  enrollDevice?: (principal: SyncPrincipal, bookId: string, deviceId: string) => Promise<unknown>;
  listDevices?: (principal: SyncPrincipal, bookId: string) => Promise<unknown[]>;
  revokeDevice?: (principal: SyncPrincipal, bookId: string, deviceId: string, reason?: string) => Promise<void>;
  renameDevice?: (principal: SyncPrincipal, bookId: string, deviceId: string, displayName: string, platform?: string) => Promise<void>;
  listMemberships?: (principal: SyncPrincipal, bookId: string) => Promise<unknown[]>;
  upsertMembership?: (principal: SyncPrincipal, bookId: string, subject: string, role: SyncRole) => Promise<unknown>;
  removeMembership?: (principal: SyncPrincipal, bookId: string, subject: string) => Promise<void>;
  setMembershipLocations?: (principal: SyncPrincipal, bookId: string, subject: string, locationIds: string[]) => Promise<void>;
  authorizeOperation?: (principal: SyncPrincipal, operation: SyncOperation) => Promise<void>;
  createEnrollmentCode?: (principal: SyncPrincipal, bookId: string, role: SyncRole, locationIds: string[], ttlMinutes?: number) => Promise<unknown>;
  redeemEnrollmentCode?: (principal: SyncPrincipal, code: string, deviceId: string, displayName?: string, platform?: string) => Promise<unknown>;
  authorizeBookAdmin?: (principal: SyncPrincipal, bookId: string, capability: "epoch" | "snapshot") => Promise<void>;
};

export type ServerOptions = {
  authenticator?: Authenticator;
  authorizer?: Authorizer;
  arbitrator?: AccountingArbitrator;
  recoveryStore?: RecoveryStore;
  deviceAdministration?: DeviceAdministration;
  production?: boolean;
  corsOrigin?: string;
  readiness?: () => Promise<void>;
  rateLimiter?: FixedWindowRateLimiter;
  metrics?: SyncMetrics;
  operationsToken?: string;
  maxBodyBytes?: number;
  trustProxy?: boolean;
  health?: () => Promise<Record<string, unknown>>;
};

type PushItemResult = { opId: string; status: "accepted" | "duplicate" | "conflict" | "rejected" | "retryable"; bookSequence?: number; conflictId?: string; message?: string };

export function createServer(store: EventStore, options: ServerOptions = {}): Server {
  const authenticator = options.authenticator ?? new AnonymousAuthenticator();
  const authorizer = options.authorizer ?? new BookMembershipAuthorizer();
  const devices = options.deviceAdministration ?? authorizer as DeviceAdministration;
  const arbitrator = options.arbitrator ?? new NoopAccountingArbitrator();
  const recovery = options.recoveryStore;
  const limiter = options.rateLimiter ?? new FixedWindowRateLimiter(300, 60_000);
  const metrics = options.metrics ?? new SyncMetrics();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 100 * 1024 * 1024) throw new Error("maxBodyBytes must be between 1 KiB and 100 MiB");
  metrics.set("ready", 0);
  metrics.set("inflight_requests", 0);
  let inflight = 0;

  return createHttpServer(async (request, response) => {
    const started = Date.now();
    const id = requestId(request.headers["x-request-id"]);
    const path = (() => { try { return new URL(request.url ?? "/", "http://localhost").pathname; } catch { return "/invalid"; } })();
    const forwarded = options.trustProxy && typeof request.headers["x-forwarded-for"] === "string"
      ? request.headers["x-forwarded-for"].split(",")[0]?.trim()
      : undefined;
    const remoteKey = remoteRateKey(forwarded || request.socket.remoteAddress);
    let errorCode: string | undefined;
    inflight += 1;
    metrics.set("inflight_requests", inflight);
    metrics.increment("requests_total");
    response.setHeader("x-request-id", id);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("access-control-allow-origin", options.corsOrigin ?? "*");
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    response.once("finish", () => {
      inflight = Math.max(0, inflight - 1);
      metrics.set("inflight_requests", inflight);
      logRequest({ requestId: id, method: request.method || "UNKNOWN", path, status: response.statusCode, durationMs: Date.now() - started, remoteKey, ...(errorCode ? { errorCode } : {}) });
    });
    if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
    const rate = limiter.allow(remoteKey);
    if (!rate.allowed) { response.setHeader("retry-after", String(rate.retryAfterSeconds)); errorCode = "rate_limited"; json(response, 429, { error: "rate_limited", message: "Too many requests" }); return; }

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/healthz") { json(response, 200, { status: "ok", service: "ledgr-sync-server" }); return; }
      if (request.method === "GET" && url.pathname === "/readyz") {
        requireOperationsToken(request, options.operationsToken);
        try { await options.readiness?.(); metrics.set("ready", 1); json(response, 200, { status: "ready" }); }
        catch { metrics.set("ready", 0); errorCode = "not_ready"; json(response, 503, { status: "not_ready" }); }
        return;
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        requireOperationsToken(request, options.operationsToken);
        text(response, 200, metrics.render(), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/ops/health") {
        requireOperationsToken(request, options.operationsToken);
        let dependencies: Record<string, unknown> = { status: 'not_configured' };
        try { dependencies = await options.health?.() || dependencies; } catch (error) { dependencies = { status: 'unhealthy', message: error instanceof Error ? error.message : 'dependency check failed' }; }
        let ready = metrics.get('ready') === 1;
        if (!ready) { try { await options.readiness?.(); metrics.set('ready', 1); ready = true; } catch { metrics.set('ready', 0); } }
        const status = ready && dependencies.status !== 'unhealthy' ? 'healthy' : 'degraded';
        json(response, status === 'healthy' ? 200 : 503, { status, at: new Date().toISOString(), liveness: { status: 'healthy' }, readiness: { status: ready ? 'ready' : 'not_ready' }, sync: { status: 'healthy', metrics: metrics.render() }, dependencies });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        json(response, 200, { protocolVersion: PROTOCOL_VERSION, payloadVersion: PAYLOAD_VERSION, maxBatchSize: MAX_BATCH_SIZE, features: ["cursor-pull", "idempotent-operations", "semantic-operations", "per-operation-results", "aggregate-revisions", "epoch-recovery", "snapshots", "checkpoint-verification", "conflict-resolution", "device-revocation", "one-time-enrollment", "location-scopes", "operations-health", ...(options.production ? ["oidc-auth", "postgres-event-store", "accounting-arbitration"] : ["in-memory-reference-store"])], productionReady: options.production === true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/enrollment-codes") {
        if (!devices.createEnrollmentCode) throw new ProtocolError("one-time enrollment codes are unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const role = requiredString(input.role || "viewer", "role", 30);
        if (!["admin", "accountant", "editor", "viewer", "auditor"].includes(role)) throw new ProtocolError("role is invalid");
        if (!Array.isArray(input.locationIds) || input.locationIds.some((value) => typeof value !== "string")) throw new ProtocolError("locationIds must be an array of strings");
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        const ttlMinutes = input.ttlMinutes === undefined ? undefined : Number(input.ttlMinutes);
        json(response, 201, { enrollment: await devices.createEnrollmentCode(principal, bookId, role as SyncRole, input.locationIds as string[], ttlMinutes) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/enroll-code/redeem") {
        if (!devices.redeemEnrollmentCode) throw new ProtocolError("one-time enrollment codes are unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const code = requiredString(input.code, "code", 100);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        json(response, 200, { enrollment: await devices.redeemEnrollmentCode(principal, code, deviceId, typeof input.displayName === "string" ? input.displayName : undefined, typeof input.platform === "string" ? input.platform : undefined) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/enroll") {
        if (!recovery) throw new ProtocolError("sync enrollment is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push");
        const state = await recovery.createBook(bookId);
        const device = devices.enrollDevice ? await devices.enrollDevice(principal, bookId, deviceId) : undefined;
        const snapshot = await recovery.latestSnapshot(bookId, state.bookEpoch);
        json(response, 200, { ...state, device, snapshotAvailable: Boolean(snapshot), snapshotThroughSequence: snapshot?.throughSequence });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sync/snapshot") {
        if (!recovery) throw new ProtocolError("sync snapshots are unavailable", 501);
        const bookId = requiredString(url.searchParams.get("bookId"), "bookId", 120);
        const deviceId = requiredString(url.searchParams.get("deviceId"), "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "pull", deviceId);
        const snapshot = await recovery.latestSnapshot(bookId);
        if (!snapshot) { json(response, 404, { error: "snapshot_not_found", message: "No validated snapshot is available for this book epoch" }); return; }
        json(response, 200, snapshot);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/snapshot") {
        if (!recovery) throw new ProtocolError("sync snapshots are unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        if (devices.authorizeBookAdmin) await devices.authorizeBookAdmin(principal, bookId, "snapshot");
        else requireScope(principal, "sync:snapshot", "sync:snapshot:write");
        const snapshotInput = { bookEpoch: requiredString(input.bookEpoch, "bookEpoch", 120), throughSequence: numberField(input.throughSequence, "throughSequence"), schemaVersion: numberField(input.schemaVersion, "schemaVersion", 1), payload: input.payload, payloadHash: requiredString(input.payloadHash, "payloadHash", 128), checkpointHash: requiredString(input.checkpointHash, "checkpointHash", 128), projectionHash: requiredString(input.projectionHash, "projectionHash", 128), createdBy: principal.subject };
        try {
          validateSnapshotProjection({ through_sequence: snapshotInput.throughSequence, schema_version: snapshotInput.schemaVersion, payload: snapshotInput.payload, payload_hash: snapshotInput.payloadHash, checkpoint_hash: snapshotInput.checkpointHash, projection_hash: snapshotInput.projectionHash }, bookId);
        } catch (error) {
          if (error instanceof DomainArbitrationFailure) throw new ProtocolError(error.message);
          throw error;
        }
        const saved = await recovery.saveSnapshot(bookId, snapshotInput);
        json(response, 201, saved);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/checkpoints/verify") {
        if (!recovery) throw new ProtocolError("checkpoint verification is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const principal = await authenticator.authenticate(request.headers);
        const sourceId = requiredString(input.sourceId, "sourceId", 120);
        await authorizer.authorize(principal, bookId, "pull", sourceId);
        const result = await recovery.verifyCheckpoint(bookId, { bookEpoch: requiredString(input.bookEpoch, "bookEpoch", 120), throughSequence: numberField(input.throughSequence, "throughSequence"), ...(typeof input.eventHash === "string" ? { eventHash: input.eventHash } : {}), ...(typeof input.projectionHash === "string" ? { projectionHash: input.projectionHash } : {}), ...(sourceId ? { sourceId } : {}) });
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/epoch/advance") {
        if (!recovery) throw new ProtocolError("epoch recovery is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        if (devices.authorizeBookAdmin) await devices.authorizeBookAdmin(principal, bookId, "epoch");
        else requireScope(principal, "sync:epoch-admin", "sync:book-admin");
        const result = await recovery.advanceEpoch(bookId, { expectedEpoch: requiredString(input.expectedEpoch, "expectedEpoch", 120), ...(input.expectedSequence === undefined ? {} : { expectedSequence: numberField(input.expectedSequence, "expectedSequence") }), reason: requiredString(input.reason, "reason", 500), advancedBy: principal.subject });
        json(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sync/devices") {
        if (!devices.listDevices) throw new ProtocolError("device listing is unavailable", 501);
        const bookId = requiredString(url.searchParams.get("bookId"), "bookId", 120);
        const deviceId = requiredString(url.searchParams.get("deviceId"), "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "pull", deviceId);
        json(response, 200, { devices: await devices.listDevices(principal, bookId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/devices/revoke") {
        if (!devices.revokeDevice) throw new ProtocolError("device revocation is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const callerDeviceId = requiredString(input.callerDeviceId, "callerDeviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", callerDeviceId);
        await devices.revokeDevice(principal, bookId, deviceId, typeof input.reason === "string" ? input.reason : undefined);
        json(response, 200, { revoked: true, bookId, deviceId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/devices/rename") {
        if (!devices.renameDevice) throw new ProtocolError("device renaming is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const callerDeviceId = requiredString(input.callerDeviceId, "callerDeviceId", 120);
        const displayName = requiredString(input.displayName, "displayName", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", callerDeviceId);
        await devices.renameDevice(principal, bookId, deviceId, displayName, typeof input.platform === "string" ? input.platform : undefined);
        json(response, 200, { renamed: true, bookId, deviceId, displayName });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sync/memberships") {
        if (!devices.listMemberships) throw new ProtocolError("membership administration is unavailable", 501);
        const bookId = requiredString(url.searchParams.get("bookId"), "bookId", 120);
        const deviceId = requiredString(url.searchParams.get("deviceId"), "deviceId", 120);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "pull", deviceId);
        json(response, 200, { memberships: await devices.listMemberships(principal, bookId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/memberships") {
        if (!devices.upsertMembership) throw new ProtocolError("membership administration is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const subject = requiredString(input.subject, "subject", 200);
        const role = requiredString(input.role, "role", 30);
        if (!["owner", "admin", "accountant", "editor", "viewer", "auditor"].includes(role)) throw new ProtocolError("role is invalid");
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        json(response, 200, { membership: await devices.upsertMembership(principal, bookId, subject, role as SyncRole) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/memberships/remove") {
        if (!devices.removeMembership) throw new ProtocolError("membership administration is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const subject = requiredString(input.subject, "subject", 200);
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        await devices.removeMembership(principal, bookId, subject);
        json(response, 200, { removed: true, bookId, subject });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/memberships/locations") {
        if (!devices.setMembershipLocations) throw new ProtocolError("location-scope administration is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const subject = requiredString(input.subject, "subject", 200);
        if (!Array.isArray(input.locationIds) || input.locationIds.some((value) => typeof value !== "string")) throw new ProtocolError("locationIds must be an array of strings");
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        await devices.setMembershipLocations(principal, bookId, subject, input.locationIds as string[]);
        json(response, 200, { updated: true, bookId, subject, locationIds: input.locationIds });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sync/conflicts") {
        if (!recovery) throw new ProtocolError("server conflict history is unavailable", 501);
        const bookId = requiredString(url.searchParams.get("bookId"), "bookId", 120);
        const deviceId = requiredString(url.searchParams.get("deviceId"), "deviceId", 120);
        const status = url.searchParams.get("status") as ConflictStatus | null;
        if (status && !["open", "resolved", "superseded"].includes(status)) throw new ProtocolError("conflict status is invalid");
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "pull", deviceId);
        json(response, 200, { conflicts: await recovery.listConflicts(bookId, status || undefined) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/conflicts/resolve") {
        if (!recovery) throw new ProtocolError("server conflict resolution is unavailable", 501);
        const input = record(await body(request, maxBodyBytes));
        const bookId = requiredString(input.bookId, "bookId", 120);
        const deviceId = requiredString(input.deviceId, "deviceId", 120);
        const conflictId = requiredString(input.conflictId, "conflictId", 120);
        const resolutionType = requiredString(input.resolutionType, "resolutionType", 40);
        if (!["keep_canonical", "correction", "merge"].includes(resolutionType)) throw new ProtocolError("resolutionType is invalid");
        const resolutionOpId = typeof input.resolutionOpId === "string" && input.resolutionOpId ? input.resolutionOpId : undefined;
        if (resolutionType !== "keep_canonical" && !resolutionOpId) throw new ProtocolError("correction and merge resolutions require resolutionOpId");
        const principal = await authenticator.authenticate(request.headers);
        await authorizer.authorize(principal, bookId, "push", deviceId);
        const resolved = await recovery.resolveConflict(bookId, conflictId, { resolutionType, ...(resolutionOpId ? { resolutionOpId } : {}), resolvedBy: principal.subject });
        json(response, 200, resolved);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync/push") {
        const requestValue = parsePushRequest(await body(request, maxBodyBytes));
        const principal = await authenticator.authenticate(request.headers);
        const deviceId = requestValue.operations[0]?.deviceId;
        if (requestValue.operations.some((operation) => operation.deviceId !== deviceId)) throw new ProtocolError("a push batch must contain one deviceId");
        await authorizer.authorize(principal, requestValue.bookId, "push", deviceId);
        const accepted: unknown[] = [];
        const results: PushItemResult[] = [];
        for (const operation of requestValue.operations) {
          try {
            if (devices.authorizeOperation) await devices.authorizeOperation(principal, operation);
            const events = await store.append(requestValue.bookId, [operation], (validation) => arbitrator.validate({ bookId: requestValue.bookId, operations: validation.operations, principal, accountingStateReader: validation.accountingStateReader }));
            const item = events[0];
            if (!item) throw new Error("event store did not return an accepted operation");
            accepted.push(item);
            results.push({ opId: operation.opId, status: "accepted", bookSequence: item.bookSequence });
            metrics.increment("push_operations_total");
          } catch (error) {
            if (error instanceof ArbitrationError) {
              const failedOperation = error.operation ?? operation;
              const evidence = { bookId: failedOperation.bookId, bookEpoch: failedOperation.bookEpoch, opId: failedOperation.opId, aggregateId: failedOperation.aggregateId, reason: error.code, localOperation: failedOperation, baseRevision: failedOperation.baseRevision, details: { ...(error.details || {}), message: error.message } };
              const stored = recovery ? await recovery.recordConflict(evidence) : undefined;
              const status = error.code === "INVALID_ACCOUNTING_COMMAND" ? "rejected" : "conflict";
              results.push({ opId: operation.opId, status, ...(stored ? { conflictId: stored.conflictId } : {}), message: error.message });
              metrics.increment(status === "conflict" ? "conflicts_total" : "rejected_total");
              continue;
            }
            if (error instanceof StoreConflictError) {
              const evidence = error.evidence;
              const stored = recovery && evidence ? await recovery.recordConflict(evidence) : undefined;
              const status = evidence?.reason === "dependency_missing" ? "retryable" : "conflict";
              results.push({ opId: operation.opId, status, ...(stored ? { conflictId: stored.conflictId } : {}), message: error.message });
              metrics.increment(status === "conflict" ? "conflicts_total" : "errors_total");
              continue;
            }
            results.push({ opId: operation.opId, status: "retryable", message: "Temporary server failure" });
            metrics.increment("errors_total");
          }
        }
        json(response, 200, { accepted, results, cursor: accepted.reduce<number>((max, value) => Math.max(max, Number((value as any).bookSequence || 0)), 0) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/sync/pull") {
        const bookId = requiredString(url.searchParams.get("bookId"), "bookId", 120);
        const principal = await authenticator.authenticate(request.headers);
        const deviceId = requiredString(url.searchParams.get("deviceId"), "deviceId", 120);
        await authorizer.authorize(principal, bookId, "pull", deviceId);
        const after = positiveInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
        const requestedLimit = positiveInteger(url.searchParams.get("limit"), MAX_BATCH_SIZE, MAX_BATCH_SIZE);
        if (requestedLimit < 1) throw new ProtocolError("limit must be at least 1");
        const pulled = await store.pull(bookId, after, Math.min(requestedLimit, MAX_BATCH_SIZE));
        metrics.increment("pull_events_total", pulled.events.length);
        json(response, 200, pulled);
        return;
      }

      json(response, 404, { error: "not_found" });
    } catch (error) {
      metrics.increment("errors_total");
      if (error instanceof ProtocolError) { errorCode = "invalid_request"; json(response, error.status, { error: "invalid_request", message: error.message }); return; }
      if (error instanceof AuthenticationError) { errorCode = "unauthorized"; response.setHeader("www-authenticate", "Bearer"); json(response, error.status, { error: "unauthorized", message: error.message }); return; }
      if (error instanceof AuthorizationError) { errorCode = "forbidden"; json(response, error.status, { error: "forbidden", message: error.message }); return; }
      if (error instanceof ArbitrationError) { errorCode = error.code; json(response, error.status, { error: "accounting_conflict", code: error.code, message: error.message, details: error.details }); return; }
      if (error instanceof StoreConflictError) { errorCode = error.evidence?.reason || "conflict"; json(response, 409, { error: "conflict", message: error.message }); return; }
      errorCode = "internal_error";
      console.error(JSON.stringify({ level: "error", event: "request_failure", requestId: id, name: error instanceof Error ? error.name : "UnknownError" }));
      json(response, 500, { error: "internal_error" });
    }
  });
}
