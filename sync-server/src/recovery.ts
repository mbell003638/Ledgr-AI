import { CanonicalEvent, SyncOperation } from "./protocol.js";

export type ConflictStatus = "open" | "resolved" | "superseded";
export type ConflictEvidence = { bookId: string; bookEpoch: string; opId: string; aggregateId?: string; reason: string; localOperation?: SyncOperation; canonicalEvent?: CanonicalEvent; baseRevision?: number | null; canonicalRevision?: number | null; details?: Record<string, unknown> };
export type StoredConflict = ConflictEvidence & { conflictId: string; canonicalOpId?: string; status: ConflictStatus; resolutionType?: string; resolutionOpId?: string; resolvedBy?: string; createdAt: string; resolvedAt?: string };
export type PullPage = { events: CanonicalEvent[]; cursor: number; hasMore: boolean; checkpointHash?: string; bookEpoch?: string; epochStartSequence?: number };
export type BookEpochState = { bookId: string; bookEpoch: string; epochNumber: number; epochStartSequence: number; currentSequence: number; startedAt: string; previousEpoch?: string; reason?: string; advancedBy?: string };
export type EpochAdvanceInput = { expectedEpoch: string; expectedSequence?: number; newEpoch?: string; reason: string; advancedBy: string };
export type AggregateRevisionMap = Record<string, number>;
export type SnapshotInput = { bookEpoch: string; throughSequence: number; schemaVersion: number; payload: unknown; payloadHash?: string; checkpointHash: string; projectionHash?: string; createdBy?: string };
export type SnapshotRecord = SnapshotInput & { snapshotId: string; bookId: string; payloadHash: string; aggregateRevisions: AggregateRevisionMap; createdAt: string };
export type CheckpointVerificationInput = { bookEpoch: string; throughSequence: number; eventHash?: string; projectionHash?: string; sourceId?: string };
export type CheckpointVerification = { bookId: string; bookEpoch: string; throughSequence: number; serverEventHash: string; suppliedEventHash?: string; eventHashMatches: boolean; projectionHashMatches?: boolean; verifiedAt: string };
export type ProjectionHashRecord = { bookId: string; bookEpoch: string; throughSequence: number; sourceId: string; projectionHash: string; recordedAt: string };

export interface RecoveryStore {
  createBook(bookId: string, requestedEpoch?: string): Promise<BookEpochState>;
  getBookEpoch(bookId: string): Promise<BookEpochState | null>;
  advanceEpoch(bookId: string, input: EpochAdvanceInput): Promise<BookEpochState>;
  saveSnapshot(bookId: string, input: SnapshotInput): Promise<SnapshotRecord>;
  latestSnapshot(bookId: string, bookEpoch?: string): Promise<SnapshotRecord | null>;
  verifyCheckpoint(bookId: string, input: CheckpointVerificationInput): Promise<CheckpointVerification>;
  recordProjectionHash(bookId: string, input: Omit<ProjectionHashRecord, "bookId" | "recordedAt">): Promise<ProjectionHashRecord>;
  listProjectionHashes(bookId: string, bookEpoch: string, throughSequence: number): Promise<ProjectionHashRecord[]>;
  recordConflict(input: ConflictEvidence): Promise<StoredConflict>;
  listConflicts(bookId: string, status?: ConflictStatus): Promise<StoredConflict[]>;
  resolveConflict(bookId: string, conflictId: string, resolution: { resolutionType: string; resolutionOpId?: string; resolvedBy: string }): Promise<StoredConflict>;
}
