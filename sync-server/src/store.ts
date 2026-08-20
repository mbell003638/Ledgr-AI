import { CanonicalEvent, SyncOperation } from "./protocol.js";

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export interface EventStore {
  append(bookId: string, operations: SyncOperation[]): Promise<CanonicalEvent[]>;
  pull(bookId: string, after: number, limit: number): Promise<{ events: CanonicalEvent[]; cursor: number; hasMore: boolean }>;
}

type BookState = { nextSequence: number; epoch: string | null; events: CanonicalEvent[]; byOpId: Map<string, CanonicalEvent>; byDeviceSequence: Map<string, CanonicalEvent> };

/** In-memory reference store. Replace this boundary with PostgreSQL before production use. */
export class MemoryEventStore implements EventStore {
  private readonly books = new Map<string, BookState>();

  private book(bookId: string): BookState {
    let state = this.books.get(bookId);
    if (!state) {
      state = { nextSequence: 1, epoch: null, events: [], byOpId: new Map(), byDeviceSequence: new Map() };
      this.books.set(bookId, state);
    }
    return state;
  }

  async append(bookId: string, operations: SyncOperation[]): Promise<CanonicalEvent[]> {
    const state = this.book(bookId);
    const batchIds = new Set<string>();
    const pendingSequenceKeys = new Set<string>();
    const toAppend: SyncOperation[] = [];
    const accepted: CanonicalEvent[] = [];
    const batchEpoch = operations[0]?.bookEpoch;
    for (const operation of operations) {
      if (operation.bookId !== bookId) throw new StoreConflictError("operation bookId does not match batch bookId");
      if ((state.epoch ?? batchEpoch) !== operation.bookEpoch) throw new StoreConflictError(`book epoch mismatch for ${bookId}`);
      if (batchIds.has(operation.opId)) throw new StoreConflictError(`duplicate opId in batch: ${operation.opId}`);
      batchIds.add(operation.opId);
      const existing = state.byOpId.get(operation.opId);
      if (existing) {
        if (existing.payloadHash !== operation.payloadHash) throw new StoreConflictError(`opId already exists with a different payload: ${operation.opId}`);
        accepted.push(existing);
        continue;
      }
      const sequenceKey = `${operation.deviceId}:${operation.deviceSequence}`;
      const sequenceExisting = state.byDeviceSequence.get(sequenceKey);
      if (sequenceExisting) {
        throw new StoreConflictError(`device sequence already belongs to another operation: ${sequenceKey}`);
      }
      if (pendingSequenceKeys.has(sequenceKey)) {
        throw new StoreConflictError(`device sequence is duplicated in batch: ${sequenceKey}`);
      }
      pendingSequenceKeys.add(sequenceKey);
      toAppend.push(operation);
    }
    if (state.epoch === null && toAppend.length > 0) state.epoch = batchEpoch!;
    for (const operation of toAppend) {
      const event: CanonicalEvent = { ...operation, bookSequence: state.nextSequence++, acceptedAt: new Date().toISOString() };
      state.events.push(event);
      state.byOpId.set(event.opId, event);
      state.byDeviceSequence.set(`${operation.deviceId}:${operation.deviceSequence}`, event);
      accepted.push(event);
    }
    return accepted;
  }

  async pull(bookId: string, after: number, limit: number) {
    const state = this.book(bookId);
    const events = state.events.filter((event) => event.bookSequence > after).slice(0, limit);
    const cursor = events.length > 0 ? events[events.length - 1].bookSequence : after;
    return { events, cursor, hasMore: state.events.some((event) => event.bookSequence > cursor) };
  }
}
