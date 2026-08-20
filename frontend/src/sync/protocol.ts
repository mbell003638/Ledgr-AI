export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_PAYLOAD_VERSION = 1;

export type SyncOperationStatus = 'pending' | 'retryable' | 'accepted' | 'conflict' | 'rejected';

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
  baseRevision: number | null;
  dependencies: string[];
  payload: unknown;
  payloadHash: string;
  clientCreatedAt: string;
  businessDate?: string;
};

export type SyncOutboxRow = SyncOperation & {
  status: SyncOperationStatus;
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
  acceptedBookSequence?: number;
  createdAt: string;
  updatedAt: string;
};

export type SyncBookState = {
  bookId: string;
  bookEpoch: string;
  serverCursor: number;
  snapshotHash?: string;
  updatedAt: string;
};

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

export function assertSyncOperation(operation: SyncOperation): void {
  if (operation.protocolVersion !== SYNC_PROTOCOL_VERSION) throw new Error('Unsupported sync protocol version');
  if (operation.payloadVersion !== SYNC_PAYLOAD_VERSION) throw new Error('Unsupported sync payload version');
  if (!operation.opId || !operation.bookId || !operation.bookEpoch || !operation.deviceId || !operation.actorId) throw new Error('Sync operation identity is incomplete');
  if (!Number.isSafeInteger(operation.deviceSequence) || operation.deviceSequence < 1) throw new Error('Sync device sequence must be positive');
  if (!Number.isSafeInteger(operation.baseRevision) && operation.baseRevision !== null) throw new Error('Sync base revision is invalid');
  if (!Array.isArray(operation.dependencies)) throw new Error('Sync dependencies must be an array');
  if (typeof operation.payloadHash !== 'string' || !/^[a-f0-9]{64}$/i.test(operation.payloadHash)) throw new Error('Sync payload hash must be a SHA-256 hex digest');
}
