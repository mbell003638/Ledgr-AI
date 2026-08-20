import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_BATCH_SIZE = 100;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export type SyncOperation = {
  protocolVersion: number;
  payloadVersion: number;
  opId: string;
  bookId: string;
  bookEpoch: string;
  deviceId: string;
  deviceSequence: number;
  actorId: string;
  commandType: string;
  aggregateId: string;
  baseRevision?: number | null;
  dependencies?: string[];
  payload: unknown;
  payloadHash: string;
  clientCreatedAt: string;
  businessDate?: string;
};

export type CanonicalEvent = SyncOperation & {
  aggregateRevision: number;
  bookSequence: number;
  acceptedAt: string;
};

export type PushRequest = { bookId: string; operations: SyncOperation[] };
export type PushResult = { accepted: CanonicalEvent[]; cursor: number };
export type PullResult = { events: CanonicalEvent[]; cursor: number; hasMore: boolean; checkpointHash?: string };

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export class ProtocolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ProtocolError";
  }
}

function requireString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ProtocolError(`${field} must be a non-empty string (max ${max} characters)`);
  }
  return value;
}

export function validateOperation(value: unknown): SyncOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("operation must be an object");
  const op = value as Record<string, unknown>;
  if (op.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocolVersion; expected ${PROTOCOL_VERSION}`);
  const result: SyncOperation = {
    protocolVersion: PROTOCOL_VERSION,
    payloadVersion: op.payloadVersion as number,
    opId: requireString(op.opId, "opId", 120),
    bookId: requireString(op.bookId, "bookId", 120),
    bookEpoch: requireString(op.bookEpoch, "bookEpoch", 120),
    deviceId: requireString(op.deviceId, "deviceId", 120),
    deviceSequence: op.deviceSequence as number,
    actorId: requireString(op.actorId, "actorId", 120),
    commandType: requireString(op.commandType, "commandType", 120),
    aggregateId: requireString(op.aggregateId, "aggregateId", 120),
    payload: op.payload,
    payloadHash: requireString(op.payloadHash, "payloadHash", 128).toLowerCase(),
    clientCreatedAt: requireString(op.clientCreatedAt, "clientCreatedAt", 80),
  };
  if (!Number.isSafeInteger(op.payloadVersion) || (op.payloadVersion as number) < 1) throw new ProtocolError("payloadVersion must be a positive safe integer");
  if (op.payload === undefined) throw new ProtocolError("payload is required");
  if (!Number.isSafeInteger(op.deviceSequence) || (op.deviceSequence as number) < 0) throw new ProtocolError("deviceSequence must be a non-negative safe integer");
  if (op.baseRevision !== undefined && op.baseRevision !== null && (!Number.isSafeInteger(op.baseRevision) || (op.baseRevision as number) < 0)) throw new ProtocolError("baseRevision must be a non-negative safe integer");
  result.baseRevision = op.baseRevision as number | null | undefined;
  if (op.dependencies !== undefined) {
    if (!Array.isArray(op.dependencies) || op.dependencies.some((item) => typeof item !== "string")) throw new ProtocolError("dependencies must be an array of strings");
    result.dependencies = op.dependencies as string[];
  }
  if (op.businessDate !== undefined) result.businessDate = requireString(op.businessDate, "businessDate", 30);
  if (!/^[a-f0-9]{64}$/.test(result.payloadHash)) throw new ProtocolError("payloadHash must be a SHA-256 hex digest");
  if (hashPayload(result.payload) !== result.payloadHash) throw new ProtocolError("payloadHash does not match payload");
  if (Buffer.byteLength(stableJson(result.payload), "utf8") > MAX_PAYLOAD_BYTES) throw new ProtocolError("payload exceeds maximum size", 413);
  return result;
}

export function parsePushRequest(value: unknown): PushRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("push body must be an object");
  const body = value as Record<string, unknown>;
  const bookId = requireString(body.bookId, "bookId", 120);
  if (!Array.isArray(body.operations) || body.operations.length === 0 || body.operations.length > MAX_BATCH_SIZE) throw new ProtocolError(`operations must contain 1-${MAX_BATCH_SIZE} entries`);
  const operations = body.operations.map(validateOperation);
  if (operations.some((operation) => operation.bookId !== bookId)) throw new ProtocolError("all operations must belong to the requested bookId");
  return { bookId, operations };
}
