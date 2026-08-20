import { SyncPrincipal } from "./auth.js";
import { SyncOperation } from "./protocol.js";

export class ArbitrationError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ArbitrationError";
  }
}

export type ArbitrationContext = { bookId: string; operations: SyncOperation[]; principal: SyncPrincipal };

export interface AccountingArbitrator {
  validate(context: ArbitrationContext): Promise<void>;
}

/** Deterministic safety checks shared by memory and PostgreSQL stores.
 * Domain-specific posting rules should be added behind this interface before rollout. */
export class DefaultAccountingArbitrator implements AccountingArbitrator {
  async validate({ bookId, operations }: ArbitrationContext): Promise<void> {
    for (const operation of operations) {
      if (operation.bookId !== bookId) throw new ArbitrationError("operation book does not match request");
      if (operation.commandType === "journal.post" || operation.commandType === "journal.create") {
        this.validateJournal(operation);
      }
      if (operation.commandType === "period.close" && operation.baseRevision === undefined) {
        throw new ArbitrationError("period.close requires a baseRevision for server arbitration");
      }
    }
  }

  private validateJournal(operation: SyncOperation): void {
    const payload = operation.payload;
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { lines?: unknown }).lines)) {
      throw new ArbitrationError("journal operation requires a lines array");
    }
    const lines = (payload as { lines: unknown[] }).lines;
    if (lines.length < 2) throw new ArbitrationError("journal operation requires at least two lines");
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      if (!line || typeof line !== "object") throw new ArbitrationError("journal lines must be objects");
      const item = line as { debit?: unknown; credit?: unknown };
      const d = typeof item.debit === "number" && Number.isFinite(item.debit) ? item.debit : 0;
      const c = typeof item.credit === "number" && Number.isFinite(item.credit) ? item.credit : 0;
      if (d < 0 || c < 0 || (d > 0 && c > 0) || (d === 0 && c === 0)) throw new ArbitrationError("journal line must contain either debit or credit");
      debit += d;
      credit += c;
    }
    if (Math.abs(debit - credit) > 0.000001) throw new ArbitrationError("journal debits and credits must balance");
  }
}

export class NoopAccountingArbitrator implements AccountingArbitrator {
  async validate(_context: ArbitrationContext): Promise<void> { /* intentionally permissive for migrations/tests */ }
}
