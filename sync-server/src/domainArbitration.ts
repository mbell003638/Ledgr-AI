import type { SyncPrincipal } from "./auth.js";
import type { SyncOperation } from "./protocol.js";

export type DomainConflictCode =
  | "ALLOCATION_EXCEEDS_INVOICE" | "ALLOCATION_EXCEEDS_RECEIPT" | "ALLOCATION_LINEAGE_MISMATCH"
  | "CAPITAL_OWNERSHIP_REQUIRED" | "CORRECTION_AUTHORITY_REQUIRED" | "DUPLICATE_INVENTORY_COUNT"
  | "DUPLICATE_REVERSAL" | "INSUFFICIENT_LOCATION_BALANCE" | "INSUFFICIENT_STOCK"
  | "OPENING_BALANCE_CONFLICT" | "PERIOD_ALREADY_CLOSED" | "PERIOD_AUTHORITY_REQUIRED"
  | "PERIOD_BARRIER_STALE" | "PERIOD_CLOSED" | "STATE_NOT_AVAILABLE" | "STATE_REFERENCE_MISSING";

export class DomainArbitrationFailure extends Error {
  constructor(readonly code: DomainConflictCode, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message); this.name = "DomainArbitrationFailure";
  }
}

export type InvoiceAccountingFact = { sourceId: string; partyId?: string; total: number; allocated: number; reversed?: boolean };
export type ReceiptAccountingFact = { sourceId: string; partyId?: string; date?: string; total: number; allocated: number; reversed?: boolean; allocationByInvoice?: ReadonlyMap<string, number>; advanceAllocationByInvoice?: ReadonlyMap<string, number> };
export type ProductAccountingFact = { productId: string; active: boolean };
export type LocationAccountingFact = { locationId: string; active: boolean };
export type CapitalMemberAccountingFact = { memberId: string; active: boolean; ownerActorIds: ReadonlySet<string> };
export type EmployeeAccountingFact = { employeeId: string; active: boolean; payRate: number; taxWithholdPct: number; startDate?: string };
export type OpeningBalanceAccountingFact = { aggregateId: string; revision: number; hasSubsequentPostings: boolean; reversed?: boolean };
export type AccountingAuthority = { mayCorrect: boolean; mayClosePeriod: boolean; mayManageOpeningBalances: boolean; mayPostAnyCapital: boolean };

/** Canonical facts at exactly `bookSequence`, loaded inside the append transaction. */
export type AccountingDomainSnapshot = {
  bookSequence: number;
  closedThrough?: string | null;
  allowNegativeStock: boolean;
  invoices: ReadonlyMap<string, InvoiceAccountingFact>;
  receipts: ReadonlyMap<string, ReceiptAccountingFact>;
  products: ReadonlyMap<string, ProductAccountingFact>;
  locations: ReadonlyMap<string, LocationAccountingFact>;
  capitalMembers: ReadonlyMap<string, CapitalMemberAccountingFact>;
  employees: ReadonlyMap<string, EmployeeAccountingFact>;
  accountIds: ReadonlySet<string>;
  partyIds: ReadonlySet<string>;
  /** `${productId}\u0000${locationId || "global"}` -> quantity. */
  stockByProductLocation: ReadonlyMap<string, number>;
  stockEffectsBySource: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** `${locationId}\u0000${method || "cash"}` -> available amount. */
  cashByLocationMethod: ReadonlyMap<string, number>;
  reversedOriginalIds: ReadonlySet<string>;
  knownOperationIds: ReadonlySet<string>;
  knownSourceIds: ReadonlySet<string>;
  sourceDates: ReadonlyMap<string, string>;
  openConflictIds: ReadonlySet<string>;
  /** `${productId || "all"}\u0000${locationId || "global"}\u0000${date}`. */
  inventoryCountKeys: ReadonlySet<string>;
  openingBalance?: OpeningBalanceAccountingFact | null;
  authority: AccountingAuthority;
};

export interface AccountingDomainStateReader {
  loadCanonicalSnapshot(bookId: string, principal: SyncPrincipal): Promise<AccountingDomainSnapshot | null>;
}

export const EMPTY_ACCOUNTING_AUTHORITY: AccountingAuthority = Object.freeze({ mayCorrect: false, mayClosePeriod: false, mayManageOpeningBalances: false, mayPostAnyCapital: false });

export function accountingSnapshot(input: Partial<AccountingDomainSnapshot> & Pick<AccountingDomainSnapshot, "bookSequence">): AccountingDomainSnapshot {
  return {
    bookSequence: input.bookSequence, closedThrough: input.closedThrough ?? null,
    allowNegativeStock: input.allowNegativeStock ?? false, invoices: input.invoices ?? new Map(), receipts: input.receipts ?? new Map(),
    products: input.products ?? new Map(), locations: input.locations ?? new Map(), capitalMembers: input.capitalMembers ?? new Map(), employees: input.employees ?? new Map(), accountIds: input.accountIds ?? new Set(), partyIds: input.partyIds ?? new Set(),
    stockByProductLocation: input.stockByProductLocation ?? new Map(), stockEffectsBySource: input.stockEffectsBySource ?? new Map(), cashByLocationMethod: input.cashByLocationMethod ?? new Map(),
    reversedOriginalIds: input.reversedOriginalIds ?? new Set(), knownOperationIds: input.knownOperationIds ?? new Set(), knownSourceIds: input.knownSourceIds ?? input.reversedOriginalIds ?? new Set(), sourceDates: input.sourceDates ?? new Map(), openConflictIds: input.openConflictIds ?? new Set(), inventoryCountKeys: input.inventoryCountKeys ?? new Set(),
    openingBalance: input.openingBalance ?? null, authority: input.authority ?? EMPTY_ACCOUNTING_AUTHORITY,
  };
}

export class StaticAccountingDomainStateReader implements AccountingDomainStateReader {
  constructor(private readonly snapshot: AccountingDomainSnapshot | null) {}
  async loadCanonicalSnapshot(): Promise<AccountingDomainSnapshot | null> { return this.snapshot; }
}

const MONEY_EPSILON = .005; const QTY_EPSILON = .0005;
const POSTING_COMMANDS = new Set(["transaction.create", "transaction.mutate", "transaction.reverse", "journal.create", "journal.post", "receipt.allocate", "cash.create", "cash.patch", "cash.delete", "capital.deposit", "capital.draw", "capital.patch", "capital.delete", "closing_balances.import", "scan.transaction.import", "manual.asset.create", "manual.liability.create", "manual.balance.update", "manual.balance.delete", "payroll.run", "stock.move", "product.adjust_qty", "location.transfer_cash", "location.transfer_stock", "accounting.correction.post", "accounting.correction.reverse"]);
const rec = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const num = (value: unknown): number => typeof value === "number" ? value : Number(value);
const scoped = (principal: SyncPrincipal, ...values: string[]) => principal.scopes.has("sync:*") || values.some((value) => principal.scopes.has(value));
const stockKey = (product: string, location?: string) => `${product}\u0000${location || "global"}`;
const cashKey = (location: string, method?: string) => `${location}\u0000${method || "cash"}`;
const countKey = (product: string, location: string, date: string) => `${product || "all"}\u0000${location || "global"}\u0000${date}`;
const originalId = (payload: Record<string, any>) => text(payload.sourceId ?? payload.journalId ?? payload.originalId ?? payload.originalSourceId ?? payload.originalJournalId);
const fail = (code: DomainConflictCode, message: string, details?: Record<string, unknown>): never => { throw new DomainArbitrationFailure(code, message, details); };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PAYMENT_METHODS = new Set(["cash", "bank", "card", "mobile", "upi"]);

function deterministicId(value: string, operationId: string): boolean {
  const seed = operationId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80);
  return value === seed || value === `replacement_${seed}` || new RegExp(`^[A-Za-z0-9_-]+_${seed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}_[0-9a-z]+$`, "u").test(value);
}
function deterministicReplacementId(operationId: string): string {
  return `replacement_${operationId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 80)}`;
}
function validateCapturedResultIdentities(operation: SyncOperation, payload: Record<string, any>): void {
  const root = rec(payload._result), result = rec(root.result);
  const values = [root, rec(root.replacement), rec(root.reversal), result, rec(result.replacement), rec(result.reversal)]
    .flatMap((item) => [text(rec(item.source).id), text(item.sourceId)]).filter(Boolean);
  for (const id of values) if (!deterministicId(id, operation.opId)) fail("STATE_NOT_AVAILABLE", "captured accounting result contains a non-deterministic source id", { sourceId: id });
  if (operation.commandType === "transaction.create") {
    const createdSourceId = text(rec(root.source).id) || text(rec(result.source).id);
    if (!createdSourceId || createdSourceId !== operation.opId) fail("STATE_NOT_AVAILABLE", "created accounting source must use the exact operation id", { sourceId: createdSourceId, expectedSourceId: operation.opId });
  }
  if (operation.commandType === "transaction.mutate" && text(payload.name).startsWith("update")) {
    const replacement = rec(root.replacement).source || rec(root.replacement).sourceId ? rec(root.replacement)
      : rec(result.replacement).source || rec(result.replacement).sourceId ? rec(result.replacement) : Object.keys(result).length ? result : root;
    const replacementSourceId = text(rec(replacement.source).id) || text(replacement.sourceId), expected = deterministicReplacementId(operation.opId);
    if (!replacementSourceId || replacementSourceId !== expected) fail("STATE_NOT_AVAILABLE", "replacement accounting source must use the exact operation-derived id", { sourceId: replacementSourceId, expectedSourceId: expected });
  }
}
function positive(value: unknown, field: string): number {
  const result = num(value); if (!Number.isFinite(result) || result <= 0) fail("STATE_NOT_AVAILABLE", `${field} must be a positive finite amount`); return result;
}
function validDate(value: unknown, field: string): string {
  const result = text(value); if (!ISO_DATE.test(result)) fail("STATE_NOT_AVAILABLE", `${field} must be an ISO accounting date`); return result;
}
function validMethod(value: unknown, field: string): string {
  const result = text(value) || "cash"; if (!PAYMENT_METHODS.has(result)) fail("STATE_NOT_AVAILABLE", `${field} is not a supported payment method`); return result;
}
function transactionAmount(input: Record<string, any>): number {
  const explicit = input.total ?? input.amount;
  if (explicit !== undefined) return positive(explicit, "transaction amount");
  const total = (Array.isArray(input.productLines) ? input.productLines : []).reduce((sum, raw) => { const line = rec(raw); return sum + num(line.qty) * num(line.unitPrice ?? line.price); }, 0);
  return positive(total, "transaction amount");
}
function payrollNet(payload: Record<string, any>, state: AccountingDomainSnapshot): number {
  const date = validDate(payload.date, "payroll date"), requested = new Set((Array.isArray(payload.employeeIds) ? payload.employeeIds : []).map(text).filter(Boolean));
  const eligible = [...state.employees.values()].filter((employee) => employee.active && (!employee.startDate || employee.startDate <= date) && (!requested.size || requested.has(employee.employeeId)));
  if (requested.size && eligible.length !== requested.size) fail("STATE_REFERENCE_MISSING", "payroll references an employee who is missing, archived, or not started");
  const net = eligible.reduce((sum, employee) => { const gross = Math.round(employee.payRate * 100) / 100, tax = Math.round(gross * employee.taxWithholdPct) / 100; return sum + Math.round((gross - tax) * 100) / 100; }, 0);
  return positive(Math.round(net * 100) / 100, "payroll net total");
}
function validateMonetaryInput(operation: SyncOperation, payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  const input = rec(payload.input), name = text(payload.name), args = Array.isArray(payload.args) ? payload.args : [], mutationInput = rec(args[1]);
  if (operation.commandType === "transaction.create" && ["createSale", "createInvoice", "createReceipt", "createPayment", "createExpense", "createBill", "createCreditNote", "createDebitNote"].includes(name)) { transactionAmount(input); validDate(input.date, "transaction date"); if (["createSale", "createReceipt", "createPayment", "createExpense"].includes(name)) validMethod(input.method, "transaction method"); }
  if (operation.commandType === "transaction.mutate" && ["updateSale", "updateInvoice", "updateReceipt", "updatePayment", "updateExpense", "updateBill", "updateNote"].includes(name)) { transactionAmount(mutationInput); validDate(mutationInput.date, "transaction date"); if (["updateSale", "updateReceipt", "updatePayment", "updateExpense"].includes(name) || (name === "updateNote" && mutationInput.method !== undefined)) validMethod(mutationInput.method, "transaction method"); }
  if (operation.commandType === "transaction.mutate" && name === "markInvoicePaid") { validDate(mutationInput.date, "mark-paid date"); validMethod(mutationInput.method, "mark-paid method"); }
  if (operation.commandType === "cash.create") { positive(payload.amount, "cash amount"); validDate(payload.date, "cash date"); if (!["in", "out"].includes(text(payload.direction))) fail("STATE_NOT_AVAILABLE", "cash direction must be in or out"); }
  if (operation.commandType === "cash.patch") { positive(input.amount, "cash amount"); validDate(input.date, "cash date"); if (!["in", "out"].includes(text(input.direction))) fail("STATE_NOT_AVAILABLE", "cash direction must be in or out"); }
  if (["capital.deposit", "capital.draw", "capital.patch"].includes(operation.commandType)) { positive(input.amount, "capital amount"); validDate(input.date, "capital date"); validMethod(input.method, "capital method"); }
  if (["manual.asset.create", "manual.liability.create", "scan.transaction.import"].includes(operation.commandType)) { positive(payload.amount, "manual amount"); validDate(payload.date, "manual date"); }
  if (operation.commandType === "manual.balance.update") { positive(input.amount, "manual amount"); validDate(input.date, "manual date"); }
  if (operation.commandType === "payroll.run") { validMethod(payload.method, "payroll method"); payrollNet(payload, state); }
  if (["location.transfer_cash"].includes(operation.commandType)) { positive(payload.amount, "transfer amount"); validMethod(payload.method, "transfer method"); }
  if (["location.transfer_stock"].includes(operation.commandType)) positive(payload.qty, "transfer quantity");
  if (["product.adjust_qty", "stock.move"].includes(operation.commandType)) { const value = num(payload.qtyDelta ?? payload.qty); if (!Number.isFinite(value) || Math.abs(value) <= QTY_EPSILON) fail("STATE_NOT_AVAILABLE", "stock quantity change must be non-zero and finite"); }
}

type Batch = { invoice: Map<string, number>; receipt: Map<string, number>; stock: Map<string, number>; cash: Map<string, number>; reversals: Set<string>; counts: Set<string>; openingTouched: boolean };

/** Stateful validation is sequential within the batch. Caller keeps the per-book lock until append. */
export function validateCanonicalAccountingBatch(principal: SyncPrincipal, operations: readonly SyncOperation[], state: AccountingDomainSnapshot): void {
  const batch: Batch = { invoice: new Map(), receipt: new Map(), stock: new Map(), cash: new Map(), reversals: new Set(), counts: new Set(), openingTouched: false };
  for (const operation of operations) {
    try {
      const payload = rec(operation.payload); validateCapturedResultIdentities(operation, payload); validateMonetaryInput(operation, payload, state); validateClosedPeriod(operation, payload, state);
      switch (operation.commandType) {
        case "transaction.create": transactionCreate(operation, payload, state, batch); break;
        case "transaction.mutate": transactionMutate(operation, payload, state, batch); break;
        case "receipt.allocate": allocation(payload, state, batch); break;
        case "stock.move": stockChange(payload, num(payload.qty), state, batch); break;
        case "product.adjust_qty": stockChange(payload, num(payload.qtyDelta), state, batch); break;
        case "location.transfer_stock": stockTransfer(payload, state, batch); break;
        case "location.transfer_cash": cashTransfer(payload, state, batch); break;
        case "location.archive": locationArchive(payload, state, batch); break;
        case "capital.member.assign_owner": capitalOwnerAssignment(principal, payload, state); break;
        case "capital.deposit": case "capital.draw": capital(principal, payload, state); break;
        case "capital.patch": case "capital.delete": capital(principal, payload, state); reversal({ sourceId: payload.sourceId }, state, batch); break;
        case "cash.patch": case "cash.delete": reversal({ sourceId: payload.id }, state, batch); break;
        case "manual.balance.update": case "manual.balance.delete": reversal({ sourceId: payload.sourceId }, state, batch); break;
        case "transaction.reverse": reversal(payload, state, batch); break;
        case "inventory.count.record": inventoryCount(payload, state, batch); break;
        case "opening_balances.post": case "opening_balances.update": opening(principal, operation, state, batch); break;
        case "period.close": closePeriod(principal, payload, state); break;
        case "accounting.correction.post": correctionAuthority(principal, state); correctionReference(payload, state); correctionPostingReferences(payload, state); break;
        case "accounting.correction.reverse": correctionAuthority(principal, state); correctionReference(payload, state); reversal(payload, state, batch); break;
      }
    } catch (error) {
      if (error instanceof DomainArbitrationFailure) throw new DomainArbitrationFailure(error.code, error.message, { ...error.details, opId: operation.opId, aggregateId: operation.aggregateId, commandType: operation.commandType });
      throw error;
    }
  }
}

function validateClosedPeriod(operation: SyncOperation, payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  if (!POSTING_COMMANDS.has(operation.commandType) || !state.closedThrough) return;
  const date = text(operation.businessDate ?? payload.date ?? payload.input?.date ?? payload.posting?.date ?? payload.journal?.date);
  if (date && date <= state.closedThrough) fail("PERIOD_CLOSED", "posting date is within a canonically closed period; create a current-period correction", { businessDate: date, closedThrough: state.closedThrough });
  const args = Array.isArray(payload.args) ? payload.args : [];
  const original = operation.commandType === "transaction.mutate" && /^(update|delete)/u.test(text(payload.name)) ? text(args[0])
    : operation.commandType === "cash.patch" || operation.commandType === "cash.delete" ? text(payload.id)
      : operation.commandType === "manual.balance.update" || operation.commandType === "manual.balance.delete" || operation.commandType === "capital.patch" || operation.commandType === "capital.delete" ? text(payload.sourceId)
        : operation.commandType === "transaction.reverse" || operation.commandType === "accounting.correction.reverse" ? originalId(payload) : "";
  const originalDate = original ? state.sourceDates.get(original) : undefined;
  if (originalDate && originalDate <= state.closedThrough) fail("PERIOD_CLOSED", "the original posting is within a canonically closed period; create a current-period correction", { originalId: original, businessDate: originalDate, closedThrough: state.closedThrough });
}

function allocation(payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const invoiceId = text(payload.invoiceSourceId), receiptId = text(payload.receiptSourceId), amount = num(payload.amount);
  const invoice = state.invoices.get(invoiceId), receipt = state.receipts.get(receiptId);
  if (!Number.isFinite(amount) || amount <= 0) fail("ALLOCATION_EXCEEDS_RECEIPT", "allocation amount must be positive", { amount });
  if (!invoice || invoice.reversed) fail("STATE_REFERENCE_MISSING", "allocation invoice does not exist or is reversed", { invoiceSourceId: invoiceId });
  if (!receipt || receipt.reversed) fail("STATE_REFERENCE_MISSING", "allocation receipt does not exist or is reversed", { receiptSourceId: receiptId });
  const invoiceFact = invoice!, receiptFact = receipt!;
  if (invoiceFact.partyId && receiptFact.partyId && invoiceFact.partyId !== receiptFact.partyId) fail("ALLOCATION_LINEAGE_MISMATCH", "receipt and invoice belong to different parties");
  const invoiceDelta = batch.invoice.get(invoiceId) ?? 0, receiptDelta = batch.receipt.get(receiptId) ?? 0;
  if (invoiceFact.allocated + invoiceDelta + amount > invoiceFact.total + MONEY_EPSILON) fail("ALLOCATION_EXCEEDS_INVOICE", "allocation exceeds canonical invoice remaining balance", { invoiceSourceId: invoiceId });
  if (receiptFact.allocated + receiptDelta + amount > receiptFact.total + MONEY_EPSILON) fail("ALLOCATION_EXCEEDS_RECEIPT", "allocation exceeds canonical unallocated receipt amount", { receiptSourceId: receiptId });
  batch.invoice.set(invoiceId, invoiceDelta + amount); batch.receipt.set(receiptId, receiptDelta + amount);
}

function transactionCreate(operation: SyncOperation, payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const name = text(payload.name), input = rec(payload.input);
  if (name === "createReceipt") validateReceiptInput(operation.aggregateId, input, state, batch);
  if (name === "createSale" || name === "createInvoice") validateProductLines(input, state, batch);
  if (name === "createBill" && input.isExpense !== true && input.billType !== "expense") validatePurchaseProductLines(input, state, batch);
  if (name === "createInvoice") validateCapturedAdvanceAllocations(operation, payload, input, state, batch);
}

function transactionMutate(operation: SyncOperation, payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const name = text(payload.name), args = Array.isArray(payload.args) ? payload.args : [], sourceId = text(args[0]), input = rec(args[1]);
  if (name === "markInvoicePaid") {
    const invoice = state.invoices.get(sourceId);
    if (!invoice || invoice.reversed) fail("STATE_REFERENCE_MISSING", "invoice does not exist or is reversed", { invoiceSourceId: sourceId });
    const invoiceFact = invoice!;
    const prior = batch.invoice.get(sourceId) ?? 0, remaining = invoiceFact.total - invoiceFact.allocated - prior;
    if (remaining <= MONEY_EPSILON) fail("ALLOCATION_EXCEEDS_INVOICE", "invoice is already settled", { invoiceSourceId: sourceId });
    const result = rec(payload._result), source = rec(result.source), metadata = rec(source.metadata), receiptId = text(source.id);
    const resultAmount = num(metadata.total ?? result.allocated);
    if (receiptId !== operation.opId || !Number.isFinite(resultAmount) || Math.abs(resultAmount - remaining) > MONEY_EPSILON) fail("STATE_NOT_AVAILABLE", "mark-paid result does not contain the deterministic canonical receipt", { invoiceSourceId: sourceId, receiptId, expectedReceiptId: operation.opId, remaining, resultAmount });
    if (text(metadata.partyId) && invoiceFact.partyId && text(metadata.partyId) !== invoiceFact.partyId) fail("ALLOCATION_LINEAGE_MISMATCH", "mark-paid receipt belongs to another customer", { invoiceSourceId: sourceId });
    batch.invoice.set(sourceId, prior + remaining);
    return;
  }
  if (name === "deleteInvoice") {
    const invoice = state.invoices.get(sourceId);
    if (!invoice || invoice.reversed) fail("STATE_REFERENCE_MISSING", "invoice does not exist or is reversed", { invoiceSourceId: sourceId });
    if (invoice!.allocated > MONEY_EPSILON) fail("ALLOCATION_LINEAGE_MISMATCH", "invoice with active allocations cannot be reversed", { invoiceSourceId: sourceId });
    reversal({ sourceId }, state, batch); return;
  }
  if (name.startsWith("delete")) { reversal({ sourceId }, state, batch); return; }
  if (name === "updateInvoice") {
    const invoice = state.invoices.get(sourceId);
    if (!invoice || invoice.reversed) fail("STATE_REFERENCE_MISSING", "invoice does not exist or is reversed", { invoiceSourceId: sourceId });
    const invoiceFact = invoice!;
    let releasedAdvance = 0;
    for (const receipt of state.receipts.values()) {
      const amount = receipt.advanceAllocationByInvoice?.get(sourceId) ?? 0;
      if (amount > MONEY_EPSILON) { batch.receipt.set(receipt.sourceId, (batch.receipt.get(receipt.sourceId) ?? 0) - amount); releasedAdvance += amount; }
    }
    const requestedTotal = input.total ?? input.amount;
    if (requestedTotal !== undefined) { const total = num(requestedTotal), retainedAllocation = Math.max(0, invoiceFact.allocated - releasedAdvance); if (!Number.isFinite(total) || total + MONEY_EPSILON < retainedAllocation) fail("ALLOCATION_EXCEEDS_INVOICE", "invoice total cannot be reduced below canonical direct allocations", { invoiceSourceId: sourceId, allocated: retainedAllocation, requestedTotal: total }); }
    const party = text(input.partyId ?? input.customerId ?? input.debtorId);
    if (party && invoiceFact.partyId && party !== invoiceFact.partyId && invoiceFact.allocated > MONEY_EPSILON) fail("ALLOCATION_LINEAGE_MISMATCH", "allocated invoice cannot be moved to another customer", { invoiceSourceId: sourceId });
    releaseStockEffect(sourceId, state, batch); validateProductLines(input, state, batch); validateCapturedAdvanceAllocations(operation, payload, input, state, batch); return;
  }
  if (name === "updateSale") { releaseStockEffect(sourceId, state, batch); validateProductLines(input, state, batch); return; }
  if (name === "updateBill") { releaseStockEffect(sourceId, state, batch); if (input.isExpense !== true && input.billType !== "expense") validatePurchaseProductLines(input, state, batch); return; }
  if (name === "updateReceipt") {
    const receipt = state.receipts.get(sourceId);
    if (!receipt || receipt.reversed) fail("STATE_REFERENCE_MISSING", "receipt does not exist or is reversed", { receiptSourceId: sourceId });
    const receiptFact = receipt!;
    if (receiptFact.allocated > MONEY_EPSILON && !receiptFact.allocationByInvoice) fail("STATE_NOT_AVAILABLE", "receipt allocation lineage is required to arbitrate an allocated receipt update", { receiptSourceId: sourceId });
    for (const [invoiceId, amount] of receiptFact.allocationByInvoice ?? []) batch.invoice.set(invoiceId, (batch.invoice.get(invoiceId) ?? 0) - amount);
    validateReceiptInput(sourceId, input, state, batch);
  }
}

function capturedAllocations(payload: Record<string, any>): Record<string, any>[] {
  const primary = primaryCapturedResult(payload);
  return (Array.isArray(primary.allocations) ? primary.allocations : []).map(rec);
}
function primaryCapturedResult(payload: Record<string, any>): Record<string, any> {
  const root = rec(payload._result), result = rec(root.result);
  return Object.keys(rec(root.replacement)).length ? rec(root.replacement) : Object.keys(rec(result.replacement)).length ? rec(result.replacement) : Object.keys(result).length ? result : root;
}
function validateCapturedAdvanceAllocations(operation: SyncOperation, payload: Record<string, any>, input: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const result = primaryCapturedResult(payload), invoiceId = text(rec(result.source).id) || operation.opId;
  const partyId = text(input.partyId ?? input.debtorId), invoiceTotal = transactionAmount(input);
  const expected: { receiptSourceId: string; amount: number }[] = [];
  let remaining = invoiceTotal;
  const receipts = [...state.receipts.values()]
    .filter((receipt) => !receipt.reversed && (!partyId || !receipt.partyId || receipt.partyId === partyId))
    .sort((left, right) => text(left.date).localeCompare(text(right.date)) || left.sourceId.localeCompare(right.sourceId));
  for (const receipt of receipts) {
    if (remaining <= MONEY_EPSILON) break;
    const delta = batch.receipt.get(receipt.sourceId) ?? 0, available = Math.max(0, receipt.total - receipt.allocated - delta);
    if (available <= MONEY_EPSILON) continue;
    const amount = Math.round(Math.min(available, remaining) * 100) / 100;
    if (amount > MONEY_EPSILON) { expected.push({ receiptSourceId: receipt.sourceId, amount }); remaining = Math.round((remaining - amount) * 100) / 100; }
  }
  const captured = capturedAllocations(payload);
  if (captured.length !== expected.length) fail("ALLOCATION_LINEAGE_MISMATCH", "captured advances do not match canonical oldest-first availability", { invoiceSourceId: invoiceId, expectedCount: expected.length, capturedCount: captured.length });
  for (let index = 0; index < expected.length; index += 1) {
    const allocation = captured[index], canonical = expected[index], receiptId = text(allocation.receiptSourceId), capturedInvoiceId = text(allocation.invoiceSourceId), amount = positive(allocation.amount, "advance allocation amount");
    if (capturedInvoiceId !== invoiceId || receiptId !== canonical.receiptSourceId || Math.abs(amount - canonical.amount) > MONEY_EPSILON) fail("ALLOCATION_LINEAGE_MISMATCH", "captured advances do not match canonical oldest-first allocation", { invoiceSourceId: invoiceId, receiptSourceId: receiptId, expectedReceiptSourceId: canonical.receiptSourceId, expectedAmount: canonical.amount, capturedAmount: amount });
    batch.receipt.set(receiptId, (batch.receipt.get(receiptId) ?? 0) + amount);
  }
}

function validateReceiptInput(receiptId: string, input: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const total = num(input.amount ?? input.total), partyId = text(input.partyId ?? input.debtorId); let used = 0;
  if (!Number.isFinite(total) || total <= 0) fail("ALLOCATION_EXCEEDS_RECEIPT", "receipt total must be positive", { receiptSourceId: receiptId });
  for (const raw of Array.isArray(input.allocations) ? input.allocations : []) {
    const item = rec(raw), invoiceId = text(item.invoiceSourceId ?? item.invoiceId), amount = num(item.amount ?? item.amountApplied), invoice = state.invoices.get(invoiceId);
    if (!invoice || invoice.reversed) fail("STATE_REFERENCE_MISSING", "allocation invoice does not exist or is reversed", { invoiceSourceId: invoiceId });
    const invoiceFact = invoice!;
    if (partyId && invoiceFact.partyId && partyId !== invoiceFact.partyId) fail("ALLOCATION_LINEAGE_MISMATCH", "receipt and invoice belong to different parties");
    const delta = batch.invoice.get(invoiceId) ?? 0;
    if (!Number.isFinite(amount) || amount <= 0 || invoiceFact.allocated + delta + amount > invoiceFact.total + MONEY_EPSILON) fail("ALLOCATION_EXCEEDS_INVOICE", "allocation exceeds canonical invoice remaining balance", { invoiceSourceId: invoiceId });
    batch.invoice.set(invoiceId, delta + amount); used += amount;
  }
  if (used > total + MONEY_EPSILON) fail("ALLOCATION_EXCEEDS_RECEIPT", "allocations exceed receipt total", { receiptSourceId: receiptId });
}

function releaseStockEffect(sourceId: string, state: AccountingDomainSnapshot, batch: Batch): void {
  for (const [key, delta] of state.stockEffectsBySource.get(sourceId) ?? []) batch.stock.set(key, (batch.stock.get(key) ?? 0) - delta);
}
function validateProductLines(input: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  for (const raw of Array.isArray(input.productLines) ? input.productLines : []) { const line = rec(raw), qty = num(line.qty); if (!Number.isFinite(qty) || qty <= 0) fail("INSUFFICIENT_STOCK", "sale product quantity must be positive"); stockChange({ productId: line.productId, locationId: input.locationId }, -qty, state, batch); }
}
function validatePurchaseProductLines(input: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  for (const raw of Array.isArray(input.productLines) ? input.productLines : []) {
    const line = rec(raw), qty = num(line.qty);
    if (!Number.isFinite(qty) || qty <= 0) fail("STATE_NOT_AVAILABLE", "purchase product quantity must be positive");
    stockChange({ productId: line.productId, locationId: input.locationId }, qty, state, batch);
  }
}
function stockChange(payload: Record<string, any>, delta: number, state: AccountingDomainSnapshot, batch: Batch): void {
  const productId = text(payload.productId ?? payload.id), locationId = text(payload.locationId);
  if (!state.products.get(productId)?.active) fail("STATE_REFERENCE_MISSING", "stock product does not exist or is archived", { productId });
  if (locationId && !state.locations.get(locationId)?.active) fail("STATE_REFERENCE_MISSING", "stock location does not exist or is archived", { locationId });
  const key = stockKey(productId, locationId), prior = batch.stock.get(key) ?? 0, available = (state.stockByProductLocation.get(key) ?? 0) + prior;
  if (!state.allowNegativeStock && available + delta < -QTY_EPSILON) fail("INSUFFICIENT_STOCK", "stock operation exceeds canonical availability", { productId, locationId: locationId || null, available, requestedDelta: delta });
  batch.stock.set(key, prior + delta);
}

function stockTransfer(payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const productId = text(payload.productId), from = text(payload.fromLocationId), to = text(payload.toLocationId), qty = num(payload.qty);
  if (!state.locations.get(from)?.active || !state.locations.get(to)?.active) fail("STATE_REFERENCE_MISSING", "stock transfer location does not exist or is archived");
  stockChange({ productId, locationId: from }, -qty, state, batch); stockChange({ productId, locationId: to }, qty, state, batch);
}

function cashTransfer(payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const from = text(payload.fromLocationId), to = text(payload.toLocationId), method = text(payload.method) || "cash", amount = num(payload.amount);
  if (!state.locations.get(from)?.active || !state.locations.get(to)?.active) fail("STATE_REFERENCE_MISSING", "cash transfer location does not exist or is archived");
  const fromKey = cashKey(from, method), toKey = cashKey(to, method), prior = batch.cash.get(fromKey) ?? 0, available = (state.cashByLocationMethod.get(fromKey) ?? 0) + prior;
  if (amount > available + MONEY_EPSILON) fail("INSUFFICIENT_LOCATION_BALANCE", "cash transfer exceeds canonical sending-location balance", { locationId: from, method, available, amount });
  batch.cash.set(fromKey, prior - amount); batch.cash.set(toKey, (batch.cash.get(toKey) ?? 0) + amount);
}

function locationArchive(payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const id = text(payload.id ?? payload.locationId);
  if (!state.locations.get(id)?.active) fail("STATE_REFERENCE_MISSING", "location does not exist or is already archived", { locationId: id });
  for (const [key, value] of state.cashByLocationMethod) if (key.startsWith(`${id}\u0000`) && Math.abs(value + (batch.cash.get(key) ?? 0)) > MONEY_EPSILON) fail("INSUFFICIENT_LOCATION_BALANCE", "location with cash cannot be archived", { locationId: id });
  for (const [key, value] of state.stockByProductLocation) if (key.endsWith(`\u0000${id}`) && Math.abs(value + (batch.stock.get(key) ?? 0)) > QTY_EPSILON) fail("INSUFFICIENT_STOCK", "location with stock cannot be archived", { locationId: id });
}

function capitalOwnerAssignment(principal: SyncPrincipal, payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  if (!text(payload.memberId) || !text(payload.ownerActorId)) fail("STATE_REFERENCE_MISSING", "capital ownership assignment requires memberId and ownerActorId");
  if (!state.authority.mayPostAnyCapital && !scoped(principal, "accounting:capital:any", "accounting:admin")) fail("CAPITAL_OWNERSHIP_REQUIRED", "only a book owner may assign capital ownership");
}
function capital(principal: SyncPrincipal, payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  const memberId = text(payload.memberId), member = state.capitalMembers.get(memberId);
  if (!member?.active) fail("STATE_REFERENCE_MISSING", "capital account does not exist or is inactive", { memberId });
  if (!member!.ownerActorIds.has(principal.subject) && !state.authority.mayPostAnyCapital && !scoped(principal, "accounting:capital:any", "accounting:admin")) fail("CAPITAL_OWNERSHIP_REQUIRED", "actor is not authorized for this capital account", { memberId });
}

function reversal(payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const original = originalId(payload);
  if (!original) fail("STATE_REFERENCE_MISSING", "reversal original reference is missing");
  if (!state.knownSourceIds.has(original)) fail("STATE_REFERENCE_MISSING", "reversal original does not exist in canonical history", { originalId: original });
  if (state.reversedOriginalIds.has(original) || batch.reversals.has(original)) fail("DUPLICATE_REVERSAL", "original accounting entry already has a reversal", { originalId: original });
  batch.reversals.add(original);
}

function inventoryCount(payload: Record<string, any>, state: AccountingDomainSnapshot, batch: Batch): void {
  const key = countKey(text(payload.productId), text(payload.locationId), text(payload.date));
  if (state.inventoryCountKeys.has(key) || batch.counts.has(key)) fail("DUPLICATE_INVENTORY_COUNT", "inventory count already exists for this product/location/date", { key });
  batch.counts.add(key);
}

function opening(principal: SyncPrincipal, operation: SyncOperation, state: AccountingDomainSnapshot, batch: Batch): void {
  if (!state.authority.mayManageOpeningBalances && !scoped(principal, "accounting:opening-balances", "accounting:admin")) fail("OPENING_BALANCE_CONFLICT", "actor is not authorized to manage opening balances");
  if (batch.openingTouched) fail("OPENING_BALANCE_CONFLICT", "multiple opening-balance changes in one batch conflict");
  if (operation.commandType === "opening_balances.post" && state.openingBalance && !state.openingBalance.reversed) fail("OPENING_BALANCE_CONFLICT", "opening balances already exist");
  if (operation.commandType === "opening_balances.update") {
    if (!state.openingBalance || state.openingBalance.reversed) fail("OPENING_BALANCE_CONFLICT", "opening balances do not exist");
    const openingBalance = state.openingBalance!;
    if (openingBalance.hasSubsequentPostings) fail("OPENING_BALANCE_CONFLICT", "opening balances cannot be overwritten after later postings; use an audited correction");
    if (operation.baseRevision !== openingBalance.revision) fail("OPENING_BALANCE_CONFLICT", "opening-balance revision is stale", { canonicalRevision: openingBalance.revision });
  }
  batch.openingTouched = true;
}

function closePeriod(principal: SyncPrincipal, payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  const date = text(payload.date);
  if (state.closedThrough && date <= state.closedThrough) fail("PERIOD_ALREADY_CLOSED", "period is already closed", { closedThrough: state.closedThrough });
  if (!state.authority.mayClosePeriod && !scoped(principal, "accounting:period-close", "accounting:admin")) fail("PERIOD_AUTHORITY_REQUIRED", "actor is not authorized to close this period");
  if (!Number.isSafeInteger(payload.expectedBookSequence) || payload.expectedBookSequence !== state.bookSequence) fail("PERIOD_BARRIER_STALE", "period close is based on a stale canonical sequence; sync and retry", { expectedBookSequence: payload.expectedBookSequence, canonicalBookSequence: state.bookSequence });
}

function correctionAuthority(principal: SyncPrincipal, state: AccountingDomainSnapshot): void {
  if (!state.authority.mayCorrect && !scoped(principal, "accounting:correct", "accounting:admin")) fail("CORRECTION_AUTHORITY_REQUIRED", "actor is not authorized to apply audited corrections");
}

function correctionReference(payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  const conflictId = text(payload.conflictId), operationId = text(payload.correctsOperationId), sourceId = text(payload.correctsSourceId);
  if (conflictId && !state.openConflictIds.has(conflictId)) fail("STATE_REFERENCE_MISSING", "correction conflict is not open or does not exist", { conflictId });
  if (operationId && !state.knownOperationIds.has(operationId)) fail("STATE_REFERENCE_MISSING", "corrected operation does not exist in canonical history", { correctsOperationId: operationId });
  if (sourceId && !state.knownSourceIds.has(sourceId)) fail("STATE_REFERENCE_MISSING", "corrected source does not exist in canonical history", { correctsSourceId: sourceId });
}

function correctionPostingReferences(payload: Record<string, any>, state: AccountingDomainSnapshot): void {
  const posting = rec(payload.posting ?? payload.journal), postingLocation = text(posting.locationId);
  if (postingLocation && !state.locations.get(postingLocation)?.active) fail("STATE_REFERENCE_MISSING", "correction posting location does not exist or is archived", { locationId: postingLocation });
  for (const raw of Array.isArray(posting.lines) ? posting.lines : []) {
    const line = rec(raw), accountId = text(line.accountId), partyId = text(line.partyId), locationId = text(line.locationId) || postingLocation;
    if (!accountId || !state.accountIds.has(accountId)) fail("STATE_REFERENCE_MISSING", "correction account does not belong to the canonical book", { accountId });
    if (partyId && !state.partyIds.has(partyId)) fail("STATE_REFERENCE_MISSING", "correction party does not belong to the canonical book", { partyId });
    if (locationId && !state.locations.get(locationId)?.active) fail("STATE_REFERENCE_MISSING", "correction line location does not exist or is archived", { locationId });
  }
}
