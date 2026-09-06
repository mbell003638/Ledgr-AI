import { SyncPrincipal } from "./auth.js";
import { SyncOperation } from "./protocol.js";
import {
  AccountingDomainSnapshot,
  AccountingDomainStateReader,
  DomainArbitrationFailure,
  DomainConflictCode,
  validateCanonicalAccountingBatch,
} from "./domainArbitration.js";
export type { AccountingAuthority, AccountingDomainSnapshot, AccountingDomainStateReader, CapitalMemberAccountingFact, InvoiceAccountingFact, LocationAccountingFact, OpeningBalanceAccountingFact, ProductAccountingFact, ReceiptAccountingFact } from "./domainArbitration.js";
export { accountingSnapshot, EMPTY_ACCOUNTING_AUTHORITY, StaticAccountingDomainStateReader } from "./domainArbitration.js";

export class ArbitrationError extends Error {
  readonly status = 409;
  constructor(message: string, readonly code: DomainConflictCode | "ACTOR_MISMATCH" | "CORRECTION_REQUIRES_AUDIT_LINK" | "INVALID_ACCOUNTING_COMMAND" = "INVALID_ACCOUNTING_COMMAND", readonly details?: Readonly<Record<string, unknown>>, readonly operation?: SyncOperation) {
    super(message);
    this.name = "ArbitrationError";
  }
}

export type ArbitrationContext = { bookId: string; operations: SyncOperation[]; principal: SyncPrincipal; accountingStateReader?: AccountingDomainStateReader };

export interface AccountingArbitrator {
  validate(context: ArbitrationContext): Promise<void>;
}

const REVISION_SENSITIVE_COMMANDS = new Set([
  "transaction.mutate",
  "transaction.reverse",
  "accounting.correction.post",
  "accounting.correction.reverse",
  "capital.member.assign_owner",
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
  "capital.delete",
  "cash.patch",
  "cash.delete",
  "employee.upsert",
  "employee.archive",
  "manual.balance.update",
  "manual.balance.delete",
  "inventory.count.delete",
  "opening_balances.update",
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ArbitrationError(`${field} is required`);
  return value.trim();
}

function isoDate(value: unknown, field: string): string {
  const date = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) throw new ArbitrationError(`${field} must be an ISO calendar date`);
  return date;
}

function originalReference(payload: Record<string, any>): string {
  return requiredString(payload.sourceId ?? payload.journalId ?? payload.originalId ?? payload.originalSourceId ?? payload.originalJournalId, "reversal original reference");
}

/**
 * Deterministic safety checks shared by memory and PostgreSQL stores. These
 * checks are intentionally payload-based and never rely on client clocks.
 * Aggregate revision comparison is enforced by the event stores themselves.
 */
export class DefaultAccountingArbitrator implements AccountingArbitrator {
  constructor(private readonly stateReader?: AccountingDomainStateReader, private readonly options: { requireState?: boolean } = {}) {}

  async validate(context: ArbitrationContext): Promise<void> {
    const { bookId, operations, principal } = context;
    for (const operation of operations) {
      if (operation.bookId !== bookId) throw new ArbitrationError("operation book does not match request");
      if (operation.actorId !== principal.subject && !principal.scopes.has("sync:act-as")) {
        throw new ArbitrationError("operation actor does not match authenticated principal", "ACTOR_MISMATCH", { opId: operation.opId, aggregateId: operation.aggregateId }, operation);
      }
      // `null` is an accepted wire value for baseRevision, and both stores skip the
      // revision comparison when it is null, so accepting null here would let a
      // client opt out of optimistic concurrency entirely. validatePeriodClose
      // already tests both; this is the shape every revision-sensitive command needs.
      if (REVISION_SENSITIVE_COMMANDS.has(operation.commandType) && (operation.baseRevision === undefined || operation.baseRevision === null)) {
        throw new ArbitrationError(`${operation.commandType} requires a baseRevision`);
      }
      if (operation.commandType === "journal.post" || operation.commandType === "journal.create") this.validateJournal(operation);
      if (operation.commandType === "period.close") this.validatePeriodClose(operation);
      if (operation.commandType === "receipt.allocate") this.validateAllocation(operation);
      if (operation.commandType === "inventory.count.record") this.validateInventoryCount(operation);
      if (operation.commandType === "stock.move") this.validateStockMove(operation);
      if (operation.commandType === "product.adjust_qty") this.validateQuantityAdjustment(operation);
      if (operation.commandType === "location.transfer_cash" || operation.commandType === "location.transfer_stock") this.validateLocationTransfer(operation);
      if (["capital.deposit", "capital.draw", "capital.patch", "capital.delete"].includes(operation.commandType)) this.validateCapitalEntry(operation);
      if (operation.commandType === "transaction.reverse") this.validateReversal(operation);
      if (operation.commandType === "opening_balances.post" || operation.commandType === "opening_balances.update") this.validateOpeningBalances(operation);
      if (operation.commandType === "accounting.correction.post" || operation.commandType === "accounting.correction.reverse") this.validateCorrection(operation);
      if (operation.commandType.startsWith("accounting.correction.") && operation.commandType !== "accounting.correction.post" && operation.commandType !== "accounting.correction.reverse") throw new ArbitrationError("unsupported correction action; corrections may only post or reverse");
    }
    const reader = context.accountingStateReader ?? this.stateReader;
    let snapshot: AccountingDomainSnapshot | null;
    try { snapshot = reader ? await reader.loadCanonicalSnapshot(bookId, principal) : null; }
    catch (error) {
      if (error instanceof DomainArbitrationFailure) throw new ArbitrationError(error.message, error.code, error.details, operations[0]);
      throw error;
    }
    if (this.options.requireState && !snapshot) throw new ArbitrationError("canonical accounting state is unavailable", "STATE_NOT_AVAILABLE");
    if (snapshot) this.validateAgainstSnapshot(context, snapshot);
  }

  /** Event stores may call this under their per-book append lock to avoid check/insert races. */
  validateAgainstSnapshot({ operations, principal }: ArbitrationContext, snapshot: AccountingDomainSnapshot): void {
    try { validateCanonicalAccountingBatch(principal, operations, snapshot); }
    catch (error) {
      if (error instanceof DomainArbitrationFailure) {
        const failed = operations.find((operation) => operation.opId === error.details?.opId) ?? operations[0];
        throw new ArbitrationError(error.message, error.code, error.details, failed);
      }
      throw error;
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
    isoDate(payload.date ?? operation.businessDate, "period.close date");
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
    const qty = Number(payload.qty);
    if (!Number.isFinite(qty) || qty === 0) throw new ArbitrationError("stock move quantity must be non-zero");
  }

  private validateQuantityAdjustment(operation: SyncOperation): void {
    const payload = record(operation.payload);
    requiredString(payload.productId ?? payload.id, "quantity adjustment productId");
    const qty = Number(payload.qtyDelta);
    if (!Number.isFinite(qty) || qty === 0) throw new ArbitrationError("quantity adjustment qtyDelta must be non-zero");
  }

  private validateLocationTransfer(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (!payload.fromLocationId || !payload.toLocationId || payload.fromLocationId === payload.toLocationId) throw new ArbitrationError("location transfer requires distinct source and destination locations");
    positiveNumber(operation.commandType === "location.transfer_cash" ? payload.amount : payload.qty, "location transfer quantity");
    if (operation.commandType === "location.transfer_stock") requiredString(payload.productId, "stock transfer productId");
  }

  private validateCapitalEntry(operation: SyncOperation): void {
    const payload = record(operation.payload);
    requiredString(payload.memberId, "capital memberId");
    if (operation.commandType !== "capital.delete") positiveNumber(payload.input?.amount ?? payload.amount, "capital entry amount");
    if (operation.commandType === "capital.patch" || operation.commandType === "capital.delete") requiredString(payload.sourceId, "capital sourceId");
  }

  private validateReversal(operation: SyncOperation): void {
    const payload = record(operation.payload);
    originalReference(payload);
  }

  private validateOpeningBalances(operation: SyncOperation): void {
    const payload = record(operation.payload);
    if (payload.date !== undefined) isoDate(payload.date, "opening balance date");
    const fields = ["cash", "inventory", "otherAssets", "accountsPayable", "otherLiabilities"];
    const values = fields.map((field) => payload[field] === undefined && field !== "cash" && field !== "inventory" ? 0 : Number(payload[field]));
    if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new ArbitrationError("opening balance components must be finite non-negative numbers");
    if (payload.ownerCapital !== undefined) {
      const equity = Number(payload.ownerCapital) + Number(payload.retainedEarnings ?? 0);
      if (!Number.isFinite(equity) || Math.abs(values[0] + values[1] + values[2] - values[3] - values[4] - equity) > .005) throw new ArbitrationError("opening balances must satisfy assets = liabilities + equity");
    }
  }

  private validateCorrection(operation: SyncOperation): void {
    const payload = record(operation.payload);
    const reason = requiredString(payload.reason, "correction reason");
    if (reason.length < 3) throw new ArbitrationError("correction reason must contain at least three characters");
    if (!payload.conflictId && !payload.correctsOperationId && !payload.correctsSourceId) throw new ArbitrationError("correction requires a conflict or original-operation audit link", "CORRECTION_REQUIRES_AUDIT_LINK");
    if (payload.overwrite === true || payload.replaceHistorical === true || payload.historicalPatch !== undefined) throw new ArbitrationError("historical accounting records cannot be overwritten; post or reverse instead");
    if (operation.commandType === "accounting.correction.post") {
      const posting = record(payload.posting ?? payload.journal);
      isoDate(posting.date ?? operation.businessDate, "correction posting date");
      this.validateJournal({ ...operation, payload: posting });
    } else {
      originalReference(payload);
      isoDate(payload.date ?? operation.businessDate, "correction reversal date");
    }
  }
}

export class NoopAccountingArbitrator implements AccountingArbitrator {
  async validate(_context: ArbitrationContext): Promise<void> { /* intentionally permissive for migrations/tests */ }
}
