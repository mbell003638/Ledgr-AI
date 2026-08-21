import { randomUUID } from "node:crypto";
import { CanonicalEvent, hashPayload, SyncOperation } from "./protocol.js";
import type { AccountingDomainStateReader } from "./arbitration.js";
import { AggregateRevisionMap, BookEpochState, CheckpointVerification, CheckpointVerificationInput, ConflictEvidence, ConflictStatus, EpochAdvanceInput, ProjectionHashRecord, PullPage, RecoveryStore, SnapshotInput, SnapshotRecord, StoredConflict } from "./recovery.js";

export class StoreConflictError extends Error {
  constructor(message: string, readonly evidence?: ConflictEvidence) { super(message); this.name = "StoreConflictError"; }
}

export type AppendValidationContext = { operations: SyncOperation[]; accountingStateReader?: AccountingDomainStateReader };
export type AppendValidator = (context: AppendValidationContext) => Promise<void>;
export interface EventStore {
  append(bookId: string, operations: SyncOperation[], validate?: AppendValidator): Promise<CanonicalEvent[]>;
  pull(bookId: string, after: number, limit: number): Promise<PullPage>;
}

export function assertConflictResolutionEvent(conflict: StoredConflict, resolutionType: string, resolutionEvent: CanonicalEvent): void {
  const operation = resolutionEvent as SyncOperation;
  if (operation.bookEpoch !== conflict.bookEpoch || (conflict.aggregateId && operation.aggregateId !== conflict.aggregateId)) throw new StoreConflictError("conflict resolution operation does not match the conflicted aggregate and epoch");
  if (conflict.canonicalOpId && !(operation.dependencies || []).includes(conflict.canonicalOpId)) throw new StoreConflictError("conflict resolution operation must depend on the canonical operation");
  const payload = operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload) ? operation.payload as Record<string, unknown> : {};
  if (resolutionType === "correction") {
    if (!operation.commandType.startsWith("accounting.correction.")) throw new StoreConflictError("correction resolution requires an audited correction operation");
    if (payload.conflictId !== conflict.conflictId && payload.correctsOperationId !== conflict.opId) throw new StoreConflictError("correction operation is not audit-linked to this conflict");
  } else if (resolutionType === "merge") {
    const mergeable = new Set(["party.patch", "product.patch", "location.patch", "book.config.patch"]);
    if (!conflict.localOperation || !conflict.canonicalEvent || !mergeable.has(operation.commandType) || operation.commandType !== conflict.localOperation.commandType || operation.commandType !== conflict.canonicalEvent.commandType) throw new StoreConflictError("merge resolution is limited to matching nonfinancial patch commands");
    const patch = (value: unknown): Record<string, unknown> | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const candidate = (value as Record<string, unknown>).patch;
      return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : null;
    };
    const local = patch(conflict.localOperation.payload), canonical = patch(conflict.canonicalEvent.payload), merged = patch(operation.payload);
    if (!local || !canonical || !merged || Object.keys(local).some((key) => Object.prototype.hasOwnProperty.call(canonical, key))) throw new StoreConflictError("merge resolution requires disjoint local and canonical patch fields");
    for (const [key, value] of [...Object.entries(canonical), ...Object.entries(local)]) if (!Object.prototype.hasOwnProperty.call(merged, key) || hashPayload(merged[key]) !== hashPayload(value)) throw new StoreConflictError("merge resolution payload does not preserve both disjoint patches");
  }
}

type BookState = {
  nextSequence: number; epoch: string | null; epochNumber: number; epochStartSequence: number; epochStartedAt: string | null;
  usedEpochs: Set<string>; events: CanonicalEvent[]; byOpId: Map<string, CanonicalEvent>;
  byDeviceSequence: Map<string, CanonicalEvent>; revisions: Map<string, number>; snapshots: SnapshotRecord[];
  projectionHashes: ProjectionHashRecord[]; conflicts: StoredConflict[];
};
const opKey = (epoch: string, opId: string) => `${epoch}:${opId}`;
const deviceKey = (epoch: string, deviceId: string, sequence: number) => `${epoch}:${deviceId}:${sequence}`;

/** In-memory reference store used only by development and protocol tests. */
export class MemoryEventStore implements EventStore, RecoveryStore {
  private readonly books = new Map<string, BookState>();
  private readonly appendQueues = new Map<string, Promise<void>>();

  private book(bookId: string): BookState {
    let state = this.books.get(bookId);
    if (!state) {
      state = { nextSequence: 1, epoch: null, epochNumber: 0, epochStartSequence: 1, epochStartedAt: null, usedEpochs: new Set(), events: [], byOpId: new Map(), byDeviceSequence: new Map(), revisions: new Map(), snapshots: [], projectionHashes: [], conflicts: [] };
      this.books.set(bookId, state);
    }
    return state;
  }

  private stateResult(bookId: string, state: BookState): BookEpochState {
    if (!state.epoch || !state.epochStartedAt) throw new Error(`book ${bookId} has not been initialized`);
    return { bookId, bookEpoch: state.epoch, epochNumber: state.epochNumber, epochStartSequence: state.epochStartSequence, currentSequence: state.nextSequence - 1, startedAt: state.epochStartedAt };
  }

  async createBook(bookId: string, requestedEpoch?: string): Promise<BookEpochState> {
    const state = this.book(bookId);
    if (state.epoch) {
      if (requestedEpoch && requestedEpoch !== state.epoch) throw new StoreConflictError(`book ${bookId} already has a different epoch`);
      return this.stateResult(bookId, state);
    }
    state.epoch = requestedEpoch || randomUUID();
    state.epochNumber = 1;
    state.epochStartSequence = state.nextSequence;
    state.epochStartedAt = new Date().toISOString();
    state.usedEpochs.add(state.epoch);
    return this.stateResult(bookId, state);
  }

  async getBookEpoch(bookId: string): Promise<BookEpochState | null> {
    const state = this.books.get(bookId);
    return state?.epoch ? this.stateResult(bookId, state) : null;
  }

  async append(bookId: string, operations: SyncOperation[], validate?: AppendValidator): Promise<CanonicalEvent[]> {
    const previous = this.appendQueues.get(bookId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.appendQueues.set(bookId, queued);
    await previous;
    try { return await this.appendLocked(bookId, operations, validate); }
    finally { release(); if (this.appendQueues.get(bookId) === queued) this.appendQueues.delete(bookId); }
  }

  private async appendLocked(bookId: string, operations: SyncOperation[], validate?: AppendValidator): Promise<CanonicalEvent[]> {
    const state = this.book(bookId);
    const batchEpoch = operations[0]?.bookEpoch;
    if (!batchEpoch) throw new StoreConflictError("book epoch is required");
    if (!state.epoch) await this.createBook(bookId, batchEpoch);
    try {
      if (validate) await validate({ operations });
      const batchIds = new Set<string>();
      const pendingSequenceKeys = new Set<string>();
      const toAppend: SyncOperation[] = [];
      const accepted: CanonicalEvent[] = [];
      const pendingRevisions = new Map(state.revisions);
      for (const operation of operations) {
        const base: Omit<ConflictEvidence, "reason"> = { bookId, bookEpoch: operation.bookEpoch, opId: operation.opId, aggregateId: operation.aggregateId, localOperation: operation, baseRevision: operation.baseRevision };
        if (operation.bookId !== bookId) throw new StoreConflictError("operation bookId does not match batch bookId", { ...base, reason: "book_mismatch" });
        if (state.epoch !== operation.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`, { ...base, reason: "epoch_mismatch", details: { currentEpoch: state.epoch } });
        if (batchIds.has(operation.opId)) throw new StoreConflictError(`duplicate opId in batch: ${operation.opId}`, { ...base, reason: "duplicate_batch_op_id" });
        batchIds.add(operation.opId);
        const existing = state.byOpId.get(opKey(operation.bookEpoch, operation.opId));
        if (existing) {
          if (existing.payloadHash !== operation.payloadHash) throw new StoreConflictError(`opId already exists with a different payload: ${operation.opId}`, { ...base, reason: "op_id_payload_mismatch", canonicalEvent: existing, canonicalRevision: existing.aggregateRevision });
          accepted.push(existing);
          continue;
        }
        const missingDependencies = (operation.dependencies || []).filter((dependency) => !state.byOpId.has(opKey(operation.bookEpoch, dependency)) && !toAppend.some((pending) => pending.opId === dependency));
        if (missingDependencies.length) throw new StoreConflictError(`operation dependencies are not available: ${missingDependencies.join(",")}`, { ...base, reason: "dependency_missing", details: { missingDependencies } });
        const sequenceKey = deviceKey(operation.bookEpoch, operation.deviceId, operation.deviceSequence);
        const sequenceExisting = state.byDeviceSequence.get(sequenceKey);
        if (sequenceExisting) throw new StoreConflictError(`device sequence already belongs to another operation: ${operation.deviceId}:${operation.deviceSequence}`, { ...base, reason: "device_sequence_reused", canonicalEvent: sequenceExisting, canonicalRevision: sequenceExisting.aggregateRevision });
        if (pendingSequenceKeys.has(sequenceKey)) throw new StoreConflictError(`device sequence is duplicated in batch: ${operation.deviceId}:${operation.deviceSequence}`, { ...base, reason: "duplicate_batch_device_sequence" });
        pendingSequenceKeys.add(sequenceKey);
        const currentRevision = pendingRevisions.get(operation.aggregateId) ?? 0;
        if (operation.baseRevision !== undefined && operation.baseRevision !== null && operation.baseRevision !== currentRevision) {
          const canonical = [...state.events].reverse().find((item) => item.bookEpoch === state.epoch && item.aggregateId === operation.aggregateId);
          throw new StoreConflictError(`aggregate revision conflict for ${operation.aggregateId}: expected ${currentRevision}, received ${operation.baseRevision}`, { ...base, reason: "aggregate_revision_conflict", canonicalEvent: canonical, canonicalRevision: currentRevision });
        }
        pendingRevisions.set(operation.aggregateId, currentRevision + 1);
        toAppend.push(operation);
      }
      for (const operation of toAppend) {
        const aggregateRevision = (state.revisions.get(operation.aggregateId) ?? 0) + 1;
        state.revisions.set(operation.aggregateId, aggregateRevision);
        const item: CanonicalEvent = { ...operation, aggregateRevision, bookSequence: state.nextSequence++, acceptedAt: new Date().toISOString() };
        state.events.push(item);
        state.byOpId.set(opKey(operation.bookEpoch, operation.opId), item);
        state.byDeviceSequence.set(deviceKey(operation.bookEpoch, operation.deviceId, operation.deviceSequence), item);
        accepted.push(item);
      }
      return accepted;
    } catch (error) {
      if (error instanceof StoreConflictError && error.evidence) await this.recordConflict(error.evidence);
      throw error;
    }
  }

  async pull(bookId: string, after: number, limit: number): Promise<PullPage> {
    const state = this.book(bookId);
    const active = state.epoch ? state.events.filter((item) => item.bookEpoch === state.epoch) : [];
    if (after > state.nextSequence - 1) throw new StoreConflictError("pull cursor is ahead of canonical history");
    const normalizedAfter = Math.max(after, state.epochStartSequence - 1);
    const events = active.filter((item) => item.bookSequence > normalizedAfter).slice(0, limit);
    const cursor = events.length ? events[events.length - 1].bookSequence : normalizedAfter;
    const refs = active.filter((item) => item.bookSequence <= cursor).map(({ opId, bookSequence, aggregateRevision }) => ({ opId, bookSequence, aggregateRevision }));
    return { events, cursor, hasMore: active.some((item) => item.bookSequence > cursor), checkpointHash: hashPayload(refs), ...(state.epoch ? { bookEpoch: state.epoch, epochStartSequence: state.epochStartSequence } : {}) };
  }

  async advanceEpoch(bookId: string, input: EpochAdvanceInput): Promise<BookEpochState> {
    const state = this.books.get(bookId);
    if (!state?.epoch) throw new StoreConflictError(`book ${bookId} does not exist`);
    if (state.epoch !== input.expectedEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
    if (input.expectedSequence !== undefined && input.expectedSequence !== state.nextSequence - 1) throw new StoreConflictError(`book sequence changed for ${bookId}`);
    const previousEpoch = state.epoch;
    const nextEpoch = input.newEpoch || randomUUID();
    if (state.usedEpochs.has(nextEpoch)) throw new StoreConflictError(`book epoch has already been used for ${bookId}`);
    state.epoch = nextEpoch;
    state.usedEpochs.add(nextEpoch);
    state.epochNumber += 1;
    state.epochStartSequence = state.nextSequence;
    state.epochStartedAt = new Date().toISOString();
    state.revisions = new Map();
    return { ...this.stateResult(bookId, state), previousEpoch, reason: input.reason, advancedBy: input.advancedBy };
  }

  async saveSnapshot(bookId: string, input: SnapshotInput): Promise<SnapshotRecord> {
    const state = this.books.get(bookId);
    if (!state?.epoch || state.epoch !== input.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
    if (input.throughSequence < state.epochStartSequence - 1 || input.throughSequence > state.nextSequence - 1) throw new StoreConflictError("snapshot sequence is outside the current epoch");
    const checked = await this.verifyCheckpoint(bookId, { bookEpoch: input.bookEpoch, throughSequence: input.throughSequence, eventHash: input.checkpointHash });
    if (!checked.eventHashMatches) throw new StoreConflictError("snapshot checkpoint does not match canonical history");
    const payloadHash = hashPayload(input.payload);
    if (input.payloadHash && input.payloadHash !== payloadHash) throw new StoreConflictError("snapshot payload hash does not match payload");
    const aggregateRevisions = Object.create(null) as AggregateRevisionMap;
    for (const event of state.events) {
      if (event.bookEpoch !== input.bookEpoch || event.bookSequence > input.throughSequence) continue;
      aggregateRevisions[event.aggregateId] = Math.max(aggregateRevisions[event.aggregateId] || 0, event.aggregateRevision);
    }
    const snapshot: SnapshotRecord = { ...input, bookId, snapshotId: randomUUID(), payloadHash, aggregateRevisions, createdAt: new Date().toISOString() };
    state.snapshots.push(snapshot);
    return snapshot;
  }

  async latestSnapshot(bookId: string, bookEpoch?: string): Promise<SnapshotRecord | null> {
    const state = this.books.get(bookId);
    const epoch = bookEpoch || state?.epoch;
    if (!state || !epoch) return null;
    return [...state.snapshots].filter((item) => item.bookEpoch === epoch).sort((a, b) => b.throughSequence - a.throughSequence || b.createdAt.localeCompare(a.createdAt))[0] || null;
  }

  async verifyCheckpoint(bookId: string, input: CheckpointVerificationInput): Promise<CheckpointVerification> {
    const state = this.books.get(bookId);
    if (!state?.epoch || state.epoch !== input.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
    if (input.throughSequence < state.epochStartSequence - 1 || input.throughSequence > state.nextSequence - 1) throw new StoreConflictError("checkpoint sequence is outside the current epoch");
    const refs = state.events.filter((item) => item.bookEpoch === input.bookEpoch && item.bookSequence <= input.throughSequence).map(({ opId, bookSequence, aggregateRevision }) => ({ opId, bookSequence, aggregateRevision }));
    const serverEventHash = hashPayload(refs);
    let projectionHashMatches: boolean | undefined;
    if (input.projectionHash) {
      projectionHashMatches = !state.projectionHashes.some((item) => item.bookEpoch === input.bookEpoch && item.throughSequence === input.throughSequence && item.projectionHash !== input.projectionHash);
      await this.recordProjectionHash(bookId, { bookEpoch: input.bookEpoch, throughSequence: input.throughSequence, sourceId: input.sourceId || "unknown", projectionHash: input.projectionHash });
    }
    return { bookId, bookEpoch: input.bookEpoch, throughSequence: input.throughSequence, serverEventHash, ...(input.eventHash ? { suppliedEventHash: input.eventHash } : {}), eventHashMatches: input.eventHash ? input.eventHash === serverEventHash : true, ...(projectionHashMatches === undefined ? {} : { projectionHashMatches }), verifiedAt: new Date().toISOString() };
  }

  async recordProjectionHash(bookId: string, input: Omit<ProjectionHashRecord, "bookId" | "recordedAt">): Promise<ProjectionHashRecord> {
    const state = this.books.get(bookId);
    if (!state?.epoch || state.epoch !== input.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
    if (input.throughSequence < state.epochStartSequence - 1 || input.throughSequence > state.nextSequence - 1) throw new StoreConflictError("projection sequence is outside the current epoch");
    const record = { ...input, bookId, recordedAt: new Date().toISOString() };
    const index = state.projectionHashes.findIndex((item) => item.bookEpoch === input.bookEpoch && item.throughSequence === input.throughSequence && item.sourceId === input.sourceId);
    if (index >= 0) state.projectionHashes[index] = record;
    else state.projectionHashes.push(record);
    return record;
  }

  async listProjectionHashes(bookId: string, bookEpoch: string, throughSequence: number): Promise<ProjectionHashRecord[]> {
    return (this.books.get(bookId)?.projectionHashes || []).filter((item) => item.bookEpoch === bookEpoch && item.throughSequence === throughSequence);
  }

  async recordConflict(input: ConflictEvidence): Promise<StoredConflict> {
    const state = this.book(input.bookId);
    const duplicate = state.conflicts.find((item) => item.status === "open" && item.bookEpoch === input.bookEpoch && item.opId === input.opId && item.reason === input.reason);
    if (duplicate) return duplicate;
    const result: StoredConflict = { ...input, conflictId: randomUUID(), canonicalOpId: input.canonicalEvent?.opId, status: "open", createdAt: new Date().toISOString() };
    state.conflicts.push(result);
    return result;
  }

  async listConflicts(bookId: string, status?: ConflictStatus): Promise<StoredConflict[]> {
    return (this.books.get(bookId)?.conflicts || []).filter((item) => !status || item.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async resolveConflict(bookId: string, conflictId: string, resolution: { resolutionType: string; resolutionOpId?: string; resolvedBy: string }): Promise<StoredConflict> {
    const state = this.books.get(bookId);
    const item = state?.conflicts.find((conflict) => conflict.conflictId === conflictId);
    if (!item) throw new StoreConflictError(`conflict ${conflictId} does not exist`);
    if (resolution.resolutionOpId) {
      const resolutionEvent = state?.events.find((event) => event.bookEpoch === state.epoch && event.opId === resolution.resolutionOpId);
      if (!resolutionEvent) throw new StoreConflictError("conflict resolution operation does not belong to the active book epoch");
      assertConflictResolutionEvent(item, resolution.resolutionType, resolutionEvent);
    }
    if (item.status === "open") {
      item.status = "resolved";
      item.resolutionType = resolution.resolutionType;
      item.resolutionOpId = resolution.resolutionOpId;
      item.resolvedBy = resolution.resolvedBy;
      item.resolvedAt = new Date().toISOString();
    }
    return item;
  }
}
