import type { SyncPrincipal } from "./auth.js";
import { accountingSnapshot, type AccountingDomainSnapshot, type AccountingDomainStateReader } from "./arbitration.js";
import { DomainArbitrationFailure } from "./domainArbitration.js";
import { hashPayload, type SyncOperation } from "./protocol.js";
import { hydrateSnapshotProjection, type SnapshotProjectionRow } from "./snapshotAccountingProjection.js";

export type PgAccountingQueryable = { query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }> };
type EventRow = { operation: SyncOperation | string; aggregate_revision: string | number };
type BookRow = { book_epoch: string; next_sequence: string | number; role: string | null };
type ConflictRow = { conflict_id: string | number };
type HistoryRow = { op_id: string; aggregate_id: string | null; book_sequence: string | number; aggregate_revision: string | number; operation: SyncOperation | string };
type Receipt = { sourceId: string; partyId?: string; date?: string; total: number; allocated: number; reversed?: boolean; allocationByInvoice: Map<string, number>; advanceAllocationByInvoice: Map<string, number> };
type NoteDescriptor = { kind: "credit_note" | "debit_note"; role: "customer" | "supplier"; method?: string; locationId?: string };
type State = ReturnType<typeof fresh>;
const rec = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const num = (v: unknown): number => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : 0; };
const sk = (product: string, location?: string) => `${product}\u0000${location || "global"}`;
const ck = (location?: string, method?: string) => `${location || "global"}\u0000${method || "cash"}`;
const original = (p: Record<string, any>) => str(p.sourceId ?? p.journalId ?? p.originalId ?? p.originalSourceId ?? p.originalJournalId);
const POSTING_COMMANDS = new Set(["transaction.create", "transaction.mutate", "transaction.reverse", "journal.create", "journal.post", "receipt.allocate", "cash.create", "cash.patch", "cash.delete", "capital.deposit", "capital.draw", "capital.patch", "capital.delete", "closing_balances.import", "scan.transaction.import", "manual.asset.create", "manual.liability.create", "manual.balance.update", "manual.balance.delete", "payroll.run", "stock.move", "product.adjust_qty", "location.transfer_cash", "location.transfer_stock", "accounting.correction.post", "accounting.correction.reverse"]);
function fresh() { return { invoices: new Map<string, { sourceId: string; partyId?: string; total: number; allocated: number; reversed?: boolean }>(), receipts: new Map<string, Receipt>(), products: new Map<string, { productId: string; active: boolean }>(), locations: new Map<string, { locationId: string; active: boolean }>(), members: new Map<string, { memberId: string; active: boolean; ownerActorIds: ReadonlySet<string> }>(), employees: new Map<string, { employeeId: string; active: boolean; payRate: number; taxWithholdPct: number; startDate?: string }>(), accounts: new Set<string>(), parties: new Set<string>(), stock: new Map<string, number>(), cash: new Map<string, number>(), reversed: new Set<string>(), counts: new Set<string>(), countIds: new Map<string, string>(), stockEffects: new Map<string, Map<string, number>>(), cashEffects: new Map<string, Map<string, number>>(), notes: new Map<string, NoteDescriptor>(), knownOps: new Set<string>(), knownSources: new Set<string>(), sourceDates: new Map<string, string>(), openConflicts: new Set<string>(), closed: null as string | null, negative: false, opening: null as AccountingDomainSnapshot["openingBalance"] }; }

/**
 * Reconstructs canonical domain facts from the latest validated active-epoch
 * V2 projection and events after its checkpoint. Construct this
 * with the transaction client already holding the per-book row or advisory lock; a
 * pool-backed instance is suitable only for diagnostics because it cannot make
 * validation and append atomic.
 */
export class PostgresAccountingDomainStateReader implements AccountingDomainStateReader {
  constructor(private readonly db: PgAccountingQueryable) {}
  async loadCanonicalSnapshot(bookId: string, principal: SyncPrincipal): Promise<AccountingDomainSnapshot | null> {
    const book = (await this.db.query<BookRow>(`SELECT b.book_epoch,b.next_sequence,m.role FROM sync_books b LEFT JOIN sync_memberships m ON m.book_id=b.book_id AND m.subject=$2 WHERE b.book_id=$1`, [bookId, principal.subject])).rows[0];
    if (!book) return null;
    const currentSequence = Number(book.next_sequence) - 1;
    const snapshot = (await this.db.query<SnapshotProjectionRow>(
      `SELECT through_sequence,schema_version,payload,payload_hash,checkpoint_hash,projection_hash
       FROM sync_snapshots WHERE book_id=$1 AND book_epoch=$2
       ORDER BY through_sequence DESC,created_at DESC LIMIT 1`,
      [bookId, book.book_epoch],
    )).rows[0];
    const throughSequence = snapshot ? Number(snapshot.through_sequence) : 0;
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || throughSequence > currentSequence) throw new DomainArbitrationFailure("STATE_NOT_AVAILABLE", "snapshot sequence is outside canonical active-epoch history", { throughSequence, currentSequence });
    const history = snapshot ? (await this.db.query<HistoryRow>(
      `SELECT op_id,operation->>'aggregateId' AS aggregate_id,book_sequence,aggregate_revision,operation
       FROM sync_events WHERE book_id=$1 AND book_epoch=$2 AND book_sequence<=$3 ORDER BY book_sequence`,
      [bookId, book.book_epoch, throughSequence],
    )).rows : [];
    if (snapshot) {
      const checkpointHash = hashPayload(history.map((row) => ({ opId: row.op_id, bookSequence: Number(row.book_sequence), aggregateRevision: Number(row.aggregate_revision) })));
      if (checkpointHash !== snapshot.checkpoint_hash) throw new DomainArbitrationFailure("STATE_NOT_AVAILABLE", "snapshot checkpoint no longer matches canonical active-epoch history", { throughSequence });
    }
    const rows = (await this.db.query<EventRow>(
      `SELECT operation,aggregate_revision FROM sync_events
       WHERE book_id=$1 AND book_epoch=$2 AND book_sequence>$3 ORDER BY book_sequence`,
      [bookId, book.book_epoch, throughSequence],
    )).rows;
    const conflicts = (await this.db.query<ConflictRow>(`SELECT conflict_id FROM sync_conflicts WHERE book_id=$1 AND book_epoch=$2 AND status='open'`, [bookId, book.book_epoch])).rows;
    const state = fresh();
    if (snapshot) hydrateSnapshotProjection(state, snapshot, bookId);
    for (const row of history) {
      state.knownOps.add(row.op_id); if (row.aggregate_id) state.knownSources.add(row.aggregate_id);
      const historical = typeof row.operation === "string" ? JSON.parse(row.operation) : row.operation;
      if (historical.commandType === "capital.member.assign_owner") apply(state, historical, Number(row.aggregate_revision));
    }
    if (state.opening) {
      const revision = history.filter((row) => row.aggregate_id === state.opening!.aggregateId).reduce((maximum, row) => Math.max(maximum, Number(row.aggregate_revision)), 0);
      state.opening.revision = revision;
    }
    for (const row of conflicts) state.openConflicts.add(String(row.conflict_id));
    for (const row of rows) apply(state, typeof row.operation === "string" ? JSON.parse(row.operation) : row.operation, Number(row.aggregate_revision));
    const owner = (book.role === "owner" || book.role === "admin") || principal.scopes.has("accounting:admin") || principal.scopes.has("sync:*");
    return accountingSnapshot({ bookSequence: currentSequence, closedThrough: state.closed, allowNegativeStock: state.negative, invoices: state.invoices, receipts: state.receipts, products: state.products, locations: state.locations, capitalMembers: state.members, employees: state.employees, accountIds: state.accounts, partyIds: state.parties, stockByProductLocation: state.stock, stockEffectsBySource: state.stockEffects, cashByLocationMethod: state.cash, reversedOriginalIds: state.reversed, knownOperationIds: state.knownOps, knownSourceIds: state.knownSources, sourceDates: state.sourceDates, openConflictIds: state.openConflicts, inventoryCountKeys: state.counts, openingBalance: state.opening, authority: { mayCorrect: owner || book.role === "editor", mayClosePeriod: owner, mayManageOpeningBalances: owner, mayPostAnyCapital: owner } });
  }
}

function deltas(target: Map<string, number>, effect: Map<string, number>, sign = 1): void { for (const [key, value] of effect) target.set(key, (target.get(key) ?? 0) + sign * value); }
function effect(target: Map<string, number>, registry: Map<string, Map<string, number>>, id: string, next: Map<string, number>): void { const old = registry.get(id); if (old) deltas(target, old, -1); deltas(target, next); registry.set(id, next); }
function reverse(state: State, id: string): void { if (!id || state.reversed.has(id)) return; state.reversed.add(id); const stocks = state.stockEffects.get(id); if (stocks) { deltas(state.stock, stocks, -1); state.stockEffects.delete(id); } const cash = state.cashEffects.get(id); if (cash) { deltas(state.cash, cash, -1); state.cashEffects.delete(id); } const invoice = state.invoices.get(id); if (invoice) { for (const receipt of state.receipts.values()) { const advance = receipt.advanceAllocationByInvoice.get(id) ?? 0; if (advance) { receipt.advanceAllocationByInvoice.delete(id); receipt.allocationByInvoice.set(id, Math.max(0, (receipt.allocationByInvoice.get(id) ?? 0) - advance)); receipt.allocated = Math.max(0, receipt.allocated - advance); invoice.allocated = Math.max(0, invoice.allocated - advance); } } invoice.reversed = true; } const receipt = state.receipts.get(id); if (receipt) { for (const [invoiceId, amount] of receipt.allocationByInvoice) { const inv = state.invoices.get(invoiceId); if (inv) inv.allocated = Math.max(0, inv.allocated - amount); } receipt.reversed = true; } }
function stockLines(input: Record<string, any>, sign: number): Map<string, number> { const result = new Map<string, number>(); for (const raw of Array.isArray(input.productLines) ? input.productLines : []) { const line = rec(raw), key = sk(str(line.productId), str(input.locationId)); result.set(key, (result.get(key) ?? 0) + sign * num(line.qty)); } return result; }
function allocate(state: State, invoiceId: string, receipt: Receipt, amount: number, advance = false): void { let invoice = state.invoices.get(invoiceId); if (!invoice) { invoice = { sourceId: invoiceId, total: amount, allocated: 0 }; state.invoices.set(invoiceId, invoice); } invoice.allocated += amount; receipt.allocated += amount; receipt.allocationByInvoice.set(invoiceId, (receipt.allocationByInvoice.get(invoiceId) ?? 0) + amount); if (advance) receipt.advanceAllocationByInvoice.set(invoiceId, (receipt.advanceAllocationByInvoice.get(invoiceId) ?? 0) + amount); }
function receipt(state: State, id: string, input: Record<string, any>): void { const item: Receipt = { sourceId: id, partyId: str(input.partyId ?? input.debtorId) || undefined, date: str(input.date) || undefined, total: num(input.amount ?? input.total), allocated: 0, allocationByInvoice: new Map(), advanceAllocationByInvoice: new Map() }; state.receipts.set(id, item); for (const raw of Array.isArray(input.allocations) ? input.allocations : []) { const a = rec(raw); allocate(state, str(a.invoiceSourceId ?? a.invoiceId), item, num(a.amount ?? a.amountApplied)); } }
function resultObjects(payload: Record<string, any>): Record<string, any>[] {
  const root = rec(payload._result), result = rec(root.result);
  return [root, rec(root.replacement), result, rec(result.replacement), rec(root.reversal), rec(result.reversal)].filter((item) => Object.keys(item).length > 0);
}
function resultSources(payload: Record<string, any>): string[] {
  const values = resultObjects(payload).flatMap((item) => [str(rec(item.source).id), str(item.sourceId)]);
  return [...new Set(values.filter(Boolean))];
}
function primaryResult(payload: Record<string, any>): Record<string, any> {
  const root = rec(payload._result), result = rec(root.result);
  return rec(root.replacement).source || rec(root.replacement).sourceId ? rec(root.replacement)
    : rec(result.replacement).source || rec(result.replacement).sourceId ? rec(result.replacement)
      : result.source || result.sourceId ? result : root;
}
function resultSource(payload: Record<string, any>, fallback: string): string { const result = primaryResult(payload); return str(rec(result.source).id) || str(result.sourceId) || fallback; }
function paymentMethod(value: unknown): string { const method = str(value); return method === "upi" ? "mobile" : ["cash", "bank", "card", "mobile"].includes(method) ? method : "cash"; }
function applyTrustedCash(state: State, payload: Record<string, any>, fallbackId: string, next?: Map<string, number>): void { if (next) effect(state.cash, state.cashEffects, resultSource(payload, fallbackId), next); }
function payrollNet(state: State, input: Record<string, any>): number {
  const ids = new Set((Array.isArray(input.employeeIds) ? input.employeeIds : []).map(str).filter(Boolean)), date = str(input.date);
  return Math.round([...state.employees.values()].filter((employee) => employee.active && (!employee.startDate || employee.startDate <= date) && (!ids.size || ids.has(employee.employeeId))).reduce((sum, employee) => { const gross = Math.round(employee.payRate * 100) / 100, tax = Math.round(gross * employee.taxWithholdPct) / 100; return sum + Math.round((gross - tax) * 100) / 100; }, 0) * 100) / 100;
}

function transactionCreate(state: State, op: SyncOperation, payload: Record<string, any>): void {
  const name = str(payload.name), input = rec(payload.input), id = resultSource(payload, op.aggregateId);
  if (name === "createInvoice") {
    state.invoices.set(id, { sourceId: id, partyId: str(input.partyId ?? input.debtorId) || undefined, total: num(input.total ?? input.amount), allocated: 0 });
    for (const raw of Array.isArray(primaryResult(payload).allocations) ? primaryResult(payload).allocations : []) { const allocation = rec(raw), advance = state.receipts.get(str(allocation.receiptSourceId)); if (advance) allocate(state, id, advance, num(allocation.amount), true); }
  }
  if (name === "createReceipt") receipt(state, id, input);
  if (name === "createSale" || name === "createInvoice") effect(state.stock, state.stockEffects, id, stockLines(input, -1));
  if (name === "createBill" && input.isExpense !== true && input.billType !== "expense") effect(state.stock, state.stockEffects, id, stockLines(input, 1));
  const amount = num(input.total ?? input.amount), location = str(input.locationId), method = str(input.method) || "cash";
  const role = str(input.role) === "supplier" ? "supplier" : "customer";
  const noteSign = name === "createCreditNote" ? (role === "supplier" ? 1 : -1) : name === "createDebitNote" ? (role === "supplier" ? -1 : 1) : 0;
  const fallback = ["createSale", "createReceipt"].includes(name) ? new Map([[ck(location, method), amount]])
    : ["createPayment", "createExpense"].includes(name) || (name === "createBill" && input.paymentType === "cash") ? new Map([[ck(location, paymentMethod(method)), -amount]])
      : noteSign && input.method ? new Map([[ck(location, paymentMethod(method)), noteSign * amount]]) : undefined;
  applyTrustedCash(state, payload, id, fallback);
  if (name === "createCreditNote" || name === "createDebitNote") state.notes.set(id, { kind: name === "createCreditNote" ? "credit_note" : "debit_note", role, ...(input.method ? { method: paymentMethod(input.method) } : {}), ...(location ? { locationId: location } : {}) });
  state.knownSources.add(id); if (str(input.date)) state.sourceDates.set(id, str(input.date));
}
function transactionMutate(state: State, op: SyncOperation, payload: Record<string, any>): void {
  const name = str(payload.name), args = Array.isArray(payload.args) ? payload.args : [], id = str(args[0]), input = rec(args[1]);
  if (name === "markInvoicePaid") {
    const invoice = state.invoices.get(id); if (!invoice || invoice.reversed) return;
    const remaining = Math.max(0, invoice.total - invoice.allocated), sourceId = op.opId;
    const created: Receipt = { sourceId, partyId: invoice.partyId, date: str(input.date) || undefined, total: remaining, allocated: 0, allocationByInvoice: new Map(), advanceAllocationByInvoice: new Map() };
    state.receipts.set(sourceId, created); allocate(state, id, created, remaining);
    effect(state.cash, state.cashEffects, sourceId, new Map([[ck(str(input.locationId), paymentMethod(input.method)), remaining]]));
    state.knownSources.add(sourceId); if (str(input.date)) state.sourceDates.set(sourceId, str(input.date)); return;
  }
  if (name.startsWith("delete")) { reverse(state, id); return; }
  const replacementId = resultSource(payload, op.opId), priorNote = state.notes.get(id);
  if (name.startsWith("update")) reverse(state, id);
  if (name === "updateInvoice") { const prior = state.invoices.get(id); state.invoices.set(replacementId, { sourceId: replacementId, partyId: str(input.partyId ?? input.debtorId) || prior?.partyId, total: num(input.total ?? input.amount) || prior?.total || 0, allocated: prior?.allocated || 0 }); for (const item of state.receipts.values()) { const allocated = item.allocationByInvoice.get(id); if (allocated !== undefined) { item.allocationByInvoice.delete(id); item.allocationByInvoice.set(replacementId, (item.allocationByInvoice.get(replacementId) ?? 0) + allocated); } const advance = item.advanceAllocationByInvoice.get(id); if (advance !== undefined) { item.advanceAllocationByInvoice.delete(id); item.advanceAllocationByInvoice.set(replacementId, (item.advanceAllocationByInvoice.get(replacementId) ?? 0) + advance); } } for (const raw of Array.isArray(primaryResult(payload).allocations) ? primaryResult(payload).allocations : []) { const allocation = rec(raw), advance = state.receipts.get(str(allocation.receiptSourceId)); if (advance) allocate(state, replacementId, advance, num(allocation.amount), true); } }
  if (name === "updateReceipt") receipt(state, replacementId, input);
  if (["updateInvoice", "updateSale"].includes(name)) effect(state.stock, state.stockEffects, replacementId, stockLines(input, -1));
  if (name === "updateBill" && input.isExpense !== true && input.billType !== "expense") effect(state.stock, state.stockEffects, replacementId, stockLines(input, 1));
  const amount = num(input.total ?? input.amount), method = str(input.method) || "cash";
  const noteSign = priorNote?.kind === "credit_note" ? (priorNote.role === "supplier" ? 1 : -1) : priorNote?.kind === "debit_note" ? (priorNote.role === "supplier" ? -1 : 1) : 0;
  const nextNoteMethod = name === "updateNote" && input.method ? paymentMethod(input.method) : undefined;
  const nextNoteLocation = name === "updateNote" ? str(input.locationId) : "";
  const fallback = ["updateReceipt", "updateSale"].includes(name) ? new Map([[ck(str(input.locationId), method), amount]]) : ["updateExpense", "updatePayment"].includes(name) || (name === "updateBill" && input.paymentType === "cash") ? new Map([[ck(str(input.locationId), paymentMethod(method)), -amount]]) : name === "updateNote" && nextNoteMethod ? new Map([[ck(nextNoteLocation, nextNoteMethod), noteSign * amount]]) : undefined;
  if (name === "updateNote" && priorNote) state.notes.set(replacementId, { ...priorNote, ...(nextNoteMethod ? { method: nextNoteMethod } : { method: undefined }), ...(nextNoteLocation ? { locationId: nextNoteLocation } : { locationId: undefined }) });
  if (name.startsWith("update")) { applyTrustedCash(state, payload, replacementId, fallback); state.knownSources.add(replacementId); if (str(input.date)) state.sourceDates.set(replacementId, str(input.date)); }
  void op;
}

function correctionCash(state: State, op: SyncOperation, payload: Record<string, any>): void {
  const posting = rec(payload.posting ?? payload.journal), deltas = new Map<string, number>();
  const methods: Record<string, string> = { "1000": "cash", "1010": "bank", "1020": "card", "1030": "mobile" };
  for (const raw of Array.isArray(posting.lines) ? posting.lines : []) {
    const line = rec(raw), accountId = str(line.accountId), code = accountId.split(":").pop() || "", method = methods[code];
    if (!method) continue;
    const key = ck(str(line.locationId ?? posting.locationId), method);
    deltas.set(key, (deltas.get(key) ?? 0) + num(line.debit) - num(line.credit));
  }
  effect(state.cash, state.cashEffects, op.opId, deltas);
  state.knownSources.add(op.opId);
}

function apply(state: State, op: SyncOperation, aggregateRevision: number): void {
  const p = rec(op.payload), id = op.aggregateId; state.knownOps.add(op.opId); state.knownSources.add(id); state.knownSources.add(op.opId); for (const sourceId of resultSources(p)) state.knownSources.add(sourceId);
  switch (op.commandType) {
    case "transaction.create": transactionCreate(state, op, p); break;
    case "transaction.mutate": transactionMutate(state, op, p); break;
    case "party.create": { const partyId = str(p.id) || resultSource(p, id); state.parties.add(partyId); break; }
    case "party.patch": state.parties.add(str(p.id) || id); break;
    case "party.archive": state.parties.delete(str(p.id) || id); break;
    case "receipt.allocate": { let r = state.receipts.get(str(p.receiptSourceId)); if (!r) { r = { sourceId: str(p.receiptSourceId), date: str(p.date) || undefined, total: num(p.amount), allocated: 0, allocationByInvoice: new Map(), advanceAllocationByInvoice: new Map() }; state.receipts.set(r.sourceId, r); } allocate(state, str(p.invoiceSourceId), r, num(p.amount)); break; }
    case "product.upsert": { const product = str(p.id ?? p.productId) || id; state.products.set(product, { productId: product, active: p.archived !== true }); const openingQty = p.openingQty ?? p.qty; if (openingQty !== undefined) state.stock.set(sk(product, str(p.locationId)), num(openingQty)); break; }
    case "product.archive": { const product = str(p.id) || id; state.products.set(product, { productId: product, active: false }); break; }
    case "product.adjust_qty": effect(state.stock, state.stockEffects, resultSource(p, op.opId), new Map([[sk(str(p.productId ?? p.id), str(p.locationId)), num(p.qtyDelta)]])); break;
    case "stock.move": effect(state.stock, state.stockEffects, resultSource(p, op.opId), new Map([[sk(str(p.productId), str(p.locationId)), num(p.qty)]])); break;
    case "location.create": { const location = str(p.id) || id; state.locations.set(location, { locationId: location, active: true }); break; }
    case "location.archive": { const location = str(p.id) || id; state.locations.set(location, { locationId: location, active: false }); break; }
    case "location.transfer_stock": effect(state.stock, state.stockEffects, resultSource(p, op.opId), new Map([[sk(str(p.productId), str(p.fromLocationId)), -num(p.qty)], [sk(str(p.productId), str(p.toLocationId)), num(p.qty)]])); break;
    case "location.transfer_cash": effect(state.cash, state.cashEffects, resultSource(p, op.opId), new Map([[ck(str(p.fromLocationId), paymentMethod(p.method)), -num(p.amount)], [ck(str(p.toLocationId), paymentMethod(p.method)), num(p.amount)]])); break;
    case "capital.member.assign_owner": { const memberId = str(p.memberId), current = state.members.get(memberId), owners = new Set(current?.ownerActorIds ?? []); owners.add(str(p.ownerActorId)); state.members.set(memberId, { memberId, active: true, ownerActorIds: owners }); break; }
    case "capital.deposit": case "capital.draw": { const memberId = str(p.memberId), input = rec(p.input); if (!state.members.has(memberId)) state.members.set(memberId, { memberId, active: true, ownerActorIds: new Set() }); applyTrustedCash(state, p, op.opId, new Map([[ck(str(input.locationId), paymentMethod(input.method)), (op.commandType === "capital.draw" ? -1 : 1) * num(input.amount ?? p.amount)]])); break; }
    case "capital.patch": { const source = str(p.sourceId), input = rec(p.input); reverse(state, source); applyTrustedCash(state, p, op.opId, new Map([[ck(str(input.locationId), paymentMethod(input.method)), num(input.amount ?? p.amount)]])); break; }
    case "capital.delete": case "transaction.reverse": case "accounting.correction.reverse": reverse(state, original(p)); break;
    case "accounting.correction.post": correctionCash(state, op, p); break;
    case "cash.create": applyTrustedCash(state, p, op.opId, new Map([[ck(str(p.locationId), "cash"), (p.direction === "out" ? -1 : 1) * num(p.amount)]])); break;
    case "cash.patch": { reverse(state, str(p.id)); const input = rec(p.input); applyTrustedCash(state, p, op.opId, new Map([[ck(str(input.locationId), "cash"), (input.direction === "out" ? -1 : 1) * num(input.amount)]])); break; }
    case "cash.delete": reverse(state, str(p.id)); break;
    case "payroll.run": applyTrustedCash(state, p, op.opId, new Map([[ck(str(p.locationId), paymentMethod(p.method)), -payrollNet(state, p)]])); break;
    case "scan.transaction.import": { const sign = ["payment_out", "expense", "purchase_bill"].includes(str(p.entryType)) ? -1 : p.method === "credit" ? 0 : 1; applyTrustedCash(state, p, op.opId, sign ? new Map([[ck(str(p.locationId), paymentMethod(p.method)), sign * num(p.amount)]]) : undefined); break; }
    case "manual.asset.create": { const sign = ["cash", "bank"].includes(str(p.funding)) ? -1 : 0; applyTrustedCash(state, p, op.opId, sign ? new Map([[ck("", paymentMethod(p.funding)), sign * num(p.amount)]]) : undefined); break; }
    case "manual.liability.create": { const sign = ["cash", "bank"].includes(str(p.recognition)) ? 1 : 0; applyTrustedCash(state, p, op.opId, sign ? new Map([[ck("", paymentMethod(p.recognition)), sign * num(p.amount)]]) : undefined); break; }
    case "manual.balance.update": { reverse(state, str(p.sourceId)); const input = rec(p.input), method = str(input.funding ?? input.recognition), sign = input.funding ? -1 : input.recognition ? 1 : 0; applyTrustedCash(state, p, op.opId, sign && ["cash", "bank"].includes(method) ? new Map([[ck("", paymentMethod(method)), sign * num(input.amount)]]) : undefined); break; }
    case "manual.balance.delete": reverse(state, str(p.sourceId)); break;
    case "employee.upsert": { const employeeId = str(p.id) || id; state.employees.set(employeeId, { employeeId, active: true, payRate: num(p.payRate), taxWithholdPct: num(p.taxWithholdPct), startDate: str(p.startDate) || undefined }); break; }
    case "employee.archive": { const employeeId = str(p.id) || id, current = state.employees.get(employeeId); if (current) state.employees.set(employeeId, { ...current, active: false }); break; }
    case "inventory.count.record": { const key = `${str(p.productId) || "all"}\u0000${str(p.locationId) || "global"}\u0000${str(p.date)}`, resultId = str(rec(p._result).id); state.counts.add(key); if (resultId) state.countIds.set(resultId, key); break; }
    case "inventory.count.delete": { const countId = str(p.id), key = state.countIds.get(countId); if (key) state.counts.delete(key); state.countIds.delete(countId); break; }
    case "opening_balances.post": case "opening_balances.update": { state.opening = { aggregateId: id, revision: aggregateRevision, hasSubsequentPostings: false }; state.cash.set(ck("", "cash"), num(p.cash)); state.stock.set(sk("opening-inventory"), num(p.inventory)); break; }
    case "closing_balances.import": { state.cash.set(ck("", "cash"), num(p.cash)); state.stock.set(sk("opening-inventory"), num(p.inventory)); break; }
    case "period.close": { const date = str(p.date ?? op.businessDate); if (!state.closed || date > state.closed) state.closed = date; break; }
    case "book.config.patch": { const patch = rec(p.patch ?? p); if (typeof patch.allowNegativeStock === "boolean") state.negative = patch.allowNegativeStock; break; }
  }
  const sourceDate = str(op.businessDate ?? p.date ?? p.input?.date);
  if (sourceDate) { state.sourceDates.set(op.opId, sourceDate); for (const sourceId of resultSources(p)) state.sourceDates.set(sourceId, sourceDate); }
  if (state.opening && POSTING_COMMANDS.has(op.commandType)) state.opening.hasSubsequentPostings = true;
}
