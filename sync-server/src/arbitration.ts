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

const REVISION_SENSITIVE_COMMANDS = new Set([
  "transaction.mutate",
  "transaction.reverse",
  "receipt.allocate",
  "party.patch",
  "party.archive",
  "product.patch",
  "product.upsert",
  "product.archive",
  "inventory.count.record",
  "location.patch",
  "location.archive",
  "book.config.patch",
  "period.close",
  "capital.patch",
  "manual.balance.update",
]);

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArbitrationError("operation payload must be an object");
  return value as Record<string, any>;
}

function positiveNumber(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new ArbitrationError(`${field} must be positive`);
  return number;
}

/**
 * Deterministic safety checks shared by memory and PostgreSQL stores. These
 * checks are intentionally payload-based and never rely on client clocks.
 * Aggregate revision comparison is enforced by the event stores themselves.
 */
export class DefaultAccountingArbitrator implements AccountingArbitrator {
  async validate({ bookId, operations, principal }: ArbitrationContext): Promise<void> {
    for (const operation of operations) {
      if (operation.bookId !== bookId) throw new ArbitrationError("operation book does not match request");
      if (operation.actorId !== principal.subject && !principal.scopes.has("sync:act-as")) {
        throw new ArbitrationError("operation actor does not match authenticated principal");
      }
      if (REVISION_SENSITIVE_COMMANDS.has(operation.commandType) && operation.baseRevision === undefined) {
        throw new ArbitrationError(`${operation.commandType} requires a baseRevision`);
      }
      if (operation.commandType === "journal.post" || operation.commandType === "journal.create") this.validateJournal(operation);
      if (operation.commandType === "period.close") this.validatePeriodClose(operation);
      if (operation.commandType === "receipt.allocate") this.validateAllocation(operation);
      if (operation.commandType === "inventory.count.record") this.validateInventoryCount(operation);
      if (operation.commandType === "stock.move") this.validateStockMove(operation);
      if (operation.commandType === "location.transfer_cash" || operation.commandType === "location.transfer_stock") this.validateLocationTransfer(operation);
      if (operation.commandType === "capital.deposit" || operation.commandType === "capital.draw") this.validateCapitalEntry(operation);
      if (operation.commandType === "transaction.reverse") this.validateReversal(operation);
    }
  }

  private validateJournal(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!Array.isArray(payload.lines)) throw new ArbitrationError("journal operation requires a lines array");
    const lines = payload.lines as unknown[];
    if (lines.length < 2) throw new ArbitrationError("journal operation requires at least two lines");
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      const item = record(line);
      const d = typeof item.debit === "number" && Number.isFinite(item.debit) ? item.debit : 0;
      const c = typeof item.credit === "number" && Number.isFinite(item.credit) ? item.credit : 0;
      if (d < 0 || c < 0 || (d > 0 && c > 0) || (d === 0 && c === 0)) throw new ArbitrationError("journal line must contain either debit or credit");
      debit += d;
      credit += c;
    }
    if (Math.abs(debit - credit) > 0.000001) throw new ArbitrationError("journal debits and credits must balance");
  }

  private validatePeriodClose(operation: SyncOperation): void {
    if (operation.baseRevision === undefined || operation.baseRevision === null) throw new ArbitrationError("period.close requires a baseRevision for server arbitration");
    const payload = record(operation.payload);
    if (payload.date !== undefined && typeof payload.date !== "string") throw new ArbitrationError("period.close date must be a string");
  }

  private validateAllocation(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!payload.invoiceSourceId || !payload.receiptSourceId) throw new ArbitrationError("receipt allocation requires invoiceSourceId and receiptSourceId");
    positiveNumber(payload.amount, "receipt allocation amount");
  }

  private validateInventoryCount(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (typeof payload.date !== "string" || !payload.date) throw new ArbitrationError("inventory count requires a date");
    const value = typeof payload.value === "number" ? payload.value : Number(payload.value);
    if (!Number.isFinite(value) || value < 0) throw new ArbitrationError("inventory count value must be non-negative");
  }

  private validateStockMove(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!payload.productId) throw new ArbitrationError("stock move requires productId");
    positiveNumber(Math.abs(Number(payload.qty)), "stock move quantity");
  }

  private validateLocationTransfer(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!payload.fromLocationId || !payload.toLocationId || payload.fromLocationId === payload.toLocationId) throw new ArbitrationError("location transfer requires distinct source and destination locations");
    positiveNumber(payload.amount ?? payload.qty, "location transfer quantity");
  }

  private validateCapitalEntry(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!payload.memberId) throw new ArbitrationError("capital entry requires memberId");
    positiveNumber(payload.input?.amount ?? payload.amount, "capital entry amount");
  }

  private validateReversal(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!payload.sourceId && !payload.journalId && !payload.originalId) throw new ArbitrationError("reversal requires an original source or journal reference");
  }
}

export class NoopAccountingArbitrator implements AccountingArbitrator {
  async validate(_context: ArbitrationContext): Promise<void> { /* intentionally permissive for migrations/tests */ }
}
