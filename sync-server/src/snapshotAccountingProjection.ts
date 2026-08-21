import { DomainArbitrationFailure } from "./domainArbitration.js";
import { hashPayload } from "./protocol.js";

export type SnapshotProjectionRow = {
  through_sequence: string | number;
  schema_version: string | number;
  payload: unknown;
  payload_hash: string;
  checkpoint_hash: string;
  projection_hash: string | null;
};

type Receipt = { sourceId: string; partyId?: string; date?: string; total: number; allocated: number; reversed?: boolean; allocationByInvoice: Map<string, number>; advanceAllocationByInvoice: Map<string, number> };
type NoteDescriptor = { kind: "credit_note" | "debit_note"; role: "customer" | "supplier"; method?: string; locationId?: string };
export type ProjectionHydrationTarget = {
  invoices: Map<string, { sourceId: string; partyId?: string; total: number; allocated: number; reversed?: boolean }>;
  receipts: Map<string, Receipt>;
  products: Map<string, { productId: string; active: boolean }>;
  locations: Map<string, { locationId: string; active: boolean }>;
  members: Map<string, { memberId: string; active: boolean; ownerActorIds: ReadonlySet<string> }>;
  employees: Map<string, { employeeId: string; active: boolean; payRate: number; taxWithholdPct: number; startDate?: string }>;
  accounts: Set<string>;
  parties: Set<string>;
  stock: Map<string, number>;
  cash: Map<string, number>;
  reversed: Set<string>;
  counts: Set<string>;
  countIds: Map<string, string>;
  stockEffects: Map<string, Map<string, number>>;
  cashEffects: Map<string, Map<string, number>>;
  knownSources: Set<string>;
  sourceDates: Map<string, string>;
  notes: Map<string, NoteDescriptor>;
  closed: string | null;
  opening: { aggregateId: string; revision: number; hasSubsequentPostings: boolean; reversed?: boolean } | null | undefined;
};

function emptyTarget(): ProjectionHydrationTarget {
  return {
    invoices: new Map(), receipts: new Map(), products: new Map(), locations: new Map(), members: new Map(), employees: new Map(),
    accounts: new Set(), parties: new Set(), stock: new Map(), cash: new Map(), reversed: new Set(), counts: new Set(), countIds: new Map(), stockEffects: new Map(),
    cashEffects: new Map(), knownSources: new Set(), sourceDates: new Map(), notes: new Map(), closed: null, opening: null,
  };
}

type Projection = { schemaVersion: number; bookId: string; tables: Record<string, Record<string, unknown>[]> };
const TABLES = ["v2_books", "v2_periods", "v2_personas", "v2_parties", "v2_accounts", "v2_locations", "v2_sources", "v2_journal_entries", "v2_journal_lines", "v2_invoice_allocations", "v2_inventory_counts", "v2_members", "v2_close_books", "v2_employees", "v2_pay_runs", "v2_payslips", "v2_products", "v2_stock_moves"] as const;
const INDIRECT = new Set(["v2_books", "v2_journal_lines", "v2_payslips"]);
const CASH_CODES: Readonly<Record<string, string>> = Object.freeze({ "1000": "cash", "1010": "bank", "1020": "card", "1030": "mobile" });
const CASH_METHODS = new Set(Object.values(CASH_CODES));
const EPSILON = .005;
const fail = (message: string, details?: Record<string, unknown>): never => { throw new DomainArbitrationFailure("STATE_NOT_AVAILABLE", message, details); };
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const stockKey = (productId: string, locationId?: string) => `${productId}\u0000${locationId || "global"}`;
const cashKey = (locationId?: string, method?: string) => `${locationId || "global"}\u0000${method || "cash"}`;
function required(value: unknown, field: string): string { const result = text(value); if (!result) fail(`snapshot ${field} is missing`); return result; }
function finite(value: unknown, field: string): number { const result = typeof value === "number" ? value : Number(value); if (!Number.isFinite(result)) fail(`snapshot ${field} must be finite`); return result; }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`snapshot ${label} is invalid`); return value as Record<string, unknown>; }
function flag(value: unknown, field: string): boolean { if (value === true || value === 1 || value === "1") return true; if (value === false || value === 0 || value === "0" || value === null || value === undefined) return false; return fail(`snapshot ${field} must be boolean`); }
function meta(value: unknown, sourceId: string): Record<string, unknown> {
  if (value === null || value === undefined || value === "") return {};
  try { return record(typeof value === "string" ? JSON.parse(value) : value, `metadata for source ${sourceId}`); }
  catch (error) { if (error instanceof DomainArbitrationFailure) throw error; return fail("snapshot contains malformed source metadata", { sourceId }); }
}
function indexed(rows: readonly Record<string, unknown>[], table: string): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) { const id = required(row.id, `${table}.id`); if (result.has(id)) fail(`snapshot ${table} contains duplicate id`, { id }); result.set(id, row); }
  return result;
}
function semantic(projection: Projection): Projection {
  const ignored = new Set(["created_at", "updated_at", "posted_at", "closed_at"]);
  return { ...projection, tables: Object.fromEntries(Object.entries(projection.tables).map(([table, rows]) => [table, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.has(key))))])) };
}
function projectionFrom(row: SnapshotProjectionRow, bookId: string): Projection {
  let payload = row.payload;
  try { if (typeof payload === "string") payload = JSON.parse(payload); } catch { fail("snapshot payload is malformed JSON"); }
  const root = record(payload, "payload");
  if (Number(row.schema_version) !== 1 || root.schemaVersion !== 1 || root.bookId !== bookId) fail("snapshot does not contain a compatible V2 BookProjection", { schemaVersion: row.schema_version });
  const tableObject = record(root.tables, "projection tables"), tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) { const values = tableObject[table]; if (!Array.isArray(values)) fail(`snapshot projection is missing table ${table}`); tables[table] = (values as unknown[]).map((value: unknown) => record(value, `row in ${table}`)); }
  const result: Projection = { schemaVersion: 1, bookId, tables };
  if (hashPayload(payload) !== row.payload_hash) fail("snapshot payload hash does not match the stored payload");
  if (row.projection_hash && hashPayload(semantic(result)) !== row.projection_hash) fail("snapshot semantic projection hash does not match the stored projection hash");
  if (tables.v2_books.length !== 1 || tables.v2_books[0]?.id !== bookId) fail("snapshot must contain exactly the enrolled Business Account");
  for (const table of TABLES) if (!INDIRECT.has(table)) for (const item of tables[table]) if (item.book_id !== bookId) fail(`snapshot table ${table} contains another Business Account`);
  return result;
}
function addEffect(target: Map<string, number>, registry: Map<string, Map<string, number>>, sourceId: string, key: string, delta: number): void {
  target.set(key, (target.get(key) ?? 0) + delta);
  if (!sourceId) return;
  const effect = registry.get(sourceId) ?? new Map<string, number>(); effect.set(key, (effect.get(key) ?? 0) + delta); registry.set(sourceId, effect);
}

/** Validates and hydrates an active-epoch V2 BookProjection. Malformed state fails closed. */
export function hydrateSnapshotProjection(state: ProjectionHydrationTarget, snapshot: SnapshotProjectionRow, bookId: string): void {
  const tables = projectionFrom(snapshot, bookId).tables;
  const periods = indexed(tables.v2_periods, "v2_periods"), locations = indexed(tables.v2_locations, "v2_locations"), products = indexed(tables.v2_products, "v2_products");
  const sources = indexed(tables.v2_sources, "v2_sources"), accounts = indexed(tables.v2_accounts, "v2_accounts"), journals = indexed(tables.v2_journal_entries, "v2_journal_entries");
  const parties = indexed(tables.v2_parties, "v2_parties"), employees = indexed(tables.v2_employees, "v2_employees"), payRuns = indexed(tables.v2_pay_runs, "v2_pay_runs");
  for (const id of accounts.keys()) state.accounts.add(id);
  for (const id of parties.keys()) state.parties.add(id);
  for (const [id, employee] of employees) state.employees.set(id, { employeeId: id, active: !flag(employee.archived, `v2_employees.${id}.archived`), payRate: finite(employee.pay_rate, `v2_employees.${id}.pay_rate`), taxWithholdPct: finite(employee.tax_withhold_pct, `v2_employees.${id}.tax_withhold_pct`), startDate: text(employee.start_date) || undefined });
  for (const [id, location] of locations) state.locations.set(id, { locationId: id, active: !flag(location.archived, `v2_locations.${id}.archived`) });
  for (const [id, product] of products) { finite(product.qty, `v2_products.${id}.qty`); state.products.set(id, { productId: id, active: !flag(product.archived, `v2_products.${id}.archived`) }); }
  for (const member of tables.v2_members) { const id = required(member.id, "v2_members.id"); if (state.members.has(id)) fail("snapshot contains a duplicate capital member", { memberId: id }); state.members.set(id, { memberId: id, active: true, ownerActorIds: new Set() }); }
  for (const [id, source] of sources) {
    const type = required(source.type, `v2_sources.${id}.type`), metadata = meta(source.metadata, id), locationId = text(source.location_id); state.knownSources.add(id); state.sourceDates.set(id, required(source.date, `v2_sources.${id}.date`));
    if (locationId && !locations.has(locationId)) fail("snapshot source references a missing location", { sourceId: id, locationId });
    const reversed = flag(metadata.reversed, `v2_sources.${id}.metadata.reversed`) || flag(metadata.deleted, `v2_sources.${id}.metadata.deleted`); if (reversed) state.reversed.add(id);
    const partyId = text(metadata.partyId); if (partyId && !parties.has(partyId)) fail("snapshot source references a missing party", { sourceId: id, partyId });
    if (type === "invoice") state.invoices.set(id, { sourceId: id, partyId: partyId || undefined, total: finite(metadata.total ?? metadata.amount, `invoice ${id} total`), allocated: 0, reversed });
    if (type === "receipt") state.receipts.set(id, { sourceId: id, partyId: partyId || undefined, date: required(source.date, `receipt ${id} date`), total: finite(metadata.total ?? metadata.amount, `receipt ${id} total`), allocated: 0, reversed, allocationByInvoice: new Map(), advanceAllocationByInvoice: new Map() });
    if (type === "credit_note" || type === "debit_note") state.notes.set(id, { kind: type, role: text(metadata.role) === "supplier" ? "supplier" : "customer", ...(text(metadata.method) ? { method: text(metadata.method) } : {}), ...(locationId ? { locationId } : {}) });
  }
  const allocationIds = new Set<string>();
  for (const allocation of tables.v2_invoice_allocations) {
    const id = required(allocation.id, "v2_invoice_allocations.id"); if (allocationIds.has(id)) fail("snapshot contains a duplicate allocation", { allocationId: id }); allocationIds.add(id);
    const invoiceId = required(allocation.invoice_source_id, `allocation ${id} invoice_source_id`), receiptId = required(allocation.receipt_source_id, `allocation ${id} receipt_source_id`), amount = finite(allocation.amount, `allocation ${id} amount`);
    const invoice = state.invoices.get(invoiceId), receipt = state.receipts.get(receiptId); if (!invoice || !receipt) fail("snapshot allocation has an invalid invoice or receipt reference", { allocationId: id }); if (amount <= 0) fail("snapshot allocation amount must be positive", { allocationId: id });
    const invoiceFact = invoice!, receiptFact = receipt!;
    if (invoiceFact.partyId && receiptFact.partyId && invoiceFact.partyId !== receiptFact.partyId) fail("snapshot allocation crosses customer lineage", { allocationId: id });
    invoiceFact.allocated += amount; receiptFact.allocated += amount; receiptFact.allocationByInvoice.set(invoiceId, (receiptFact.allocationByInvoice.get(invoiceId) ?? 0) + amount);
  }
  for (const invoice of state.invoices.values()) if (!invoice.reversed && invoice.allocated > invoice.total + EPSILON) fail("snapshot invoice allocations exceed the invoice total", { invoiceSourceId: invoice.sourceId });
  for (const receipt of state.receipts.values()) if (!receipt.reversed && receipt.allocated > receipt.total + EPSILON) fail("snapshot allocations exceed the receipt total", { receiptSourceId: receipt.sourceId });
  const movedByProduct = new Map<string, number>(), moveIds = new Set<string>();
  for (const move of tables.v2_stock_moves) {
    const id = required(move.id, "v2_stock_moves.id"); if (moveIds.has(id)) fail("snapshot contains a duplicate stock move", { stockMoveId: id }); moveIds.add(id);
    const productId = required(move.product_id, `stock move ${id} product_id`); if (!products.has(productId)) fail("snapshot stock move references a missing product", { stockMoveId: id, productId });
    const locationId = text(move.location_id); if (locationId && !locations.has(locationId)) fail("snapshot stock move references a missing location", { stockMoveId: id, locationId });
    const kind = required(move.kind, `stock move ${id} kind`), quantity = finite(move.qty, `stock move ${id} qty`), signed = kind === "sale" || kind === "transfer_out" ? -quantity : quantity, sourceId = text(move.source_id);
    if (sourceId && !sources.has(sourceId)) fail("snapshot stock move references a missing source", { stockMoveId: id, sourceId });
    addEffect(state.stock, state.stockEffects, sourceId, stockKey(productId, locationId), signed); movedByProduct.set(productId, (movedByProduct.get(productId) ?? 0) + signed);
  }
  for (const [productId, product] of products) { const remainder = finite(product.qty, `v2_products.${productId}.qty`) - (movedByProduct.get(productId) ?? 0); if (Math.abs(remainder) > .0005) state.stock.set(stockKey(productId), (state.stock.get(stockKey(productId)) ?? 0) + remainder); }
  const methods = new Map<string, string>();
  for (const [accountId, account] of accounts) { const method = text(account.payment_method) || CASH_CODES[text(account.code)]; if (CASH_METHODS.has(method)) methods.set(accountId, method); }
  const totals = new Map<string, { debit: number; credit: number; lines: number }>(), reversedJournals = new Set<string>();
  for (const [journalId, journal] of journals) {
    const periodId = required(journal.period_id, `v2_journal_entries.${journalId}.period_id`); if (!periods.has(periodId)) fail("snapshot journal references a missing period", { journalId, periodId });
    const sourceId = text(journal.source_id); if (sourceId && !sources.has(sourceId)) fail("snapshot journal references a missing source", { journalId, sourceId }); state.knownSources.add(journalId);
    const reversalOf = text(journal.reversal_of); if (reversalOf) {
      const originalJournal = journals.get(reversalOf); if (!originalJournal) fail("snapshot reversal references a missing journal", { journalId, reversalOf });
      const originalJournalFact = originalJournal!;
      if (reversedJournals.has(reversalOf)) fail("snapshot contains duplicate reversals", { reversalOf }); reversedJournals.add(reversalOf); state.reversed.add(reversalOf);
      const originalSourceId = text(originalJournalFact.source_id); if (originalSourceId) state.reversed.add(originalSourceId);
    }
    totals.set(journalId, { debit: 0, credit: 0, lines: 0 });
  }
  for (const line of tables.v2_journal_lines) {
    const journalId = required(line.journal_id, "v2_journal_lines.journal_id"), journal = journals.get(journalId); if (!journal) fail("snapshot contains an orphan journal line", { journalId });
    const journalFact = journal!;
    const accountId = required(line.account_id, `journal ${journalId} account_id`); if (!accounts.has(accountId)) fail("snapshot journal line references a missing account", { journalId, accountId });
    const partyId = text(line.party_id); if (partyId && !parties.has(partyId)) fail("snapshot journal line references a missing party", { journalId, partyId });
    const locationId = text(line.location_id); if (locationId && !locations.has(locationId)) fail("snapshot journal line references a missing location", { journalId, locationId });
    const debit = finite(line.debit, `journal ${journalId} debit`), credit = finite(line.credit, `journal ${journalId} credit`); if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) fail("snapshot journal line must contain exactly one positive debit or credit", { journalId });
    const total = totals.get(journalId)!; total.debit += debit; total.credit += credit; total.lines += 1; const method = methods.get(accountId); if (method) addEffect(state.cash, state.cashEffects, text(journalFact.source_id) || journalId, cashKey(locationId, method), debit - credit);
  }
  for (const [journalId, total] of totals) { if (total.lines < 2) fail("snapshot journal has fewer than two lines", { journalId }); if (Math.abs(total.debit - total.credit) > EPSILON) fail("snapshot journal is not balanced", { journalId, debit: total.debit, credit: total.credit }); }
  const accountCodes = new Map<string, Set<string>>();
  for (const line of tables.v2_journal_lines) {
    const journal = journals.get(required(line.journal_id, "v2_journal_lines.journal_id")); if (!journal) continue;
    const sourceId = text(journal.source_id), account = accounts.get(required(line.account_id, "v2_journal_lines.account_id")); if (!sourceId || !account) continue;
    const codes = accountCodes.get(sourceId) ?? new Set<string>(); codes.add(text(account.code)); accountCodes.set(sourceId, codes);
  }
  for (const allocation of tables.v2_invoice_allocations) {
    const receiptId = required(allocation.receipt_source_id, "v2_invoice_allocations.receipt_source_id"), invoiceId = required(allocation.invoice_source_id, "v2_invoice_allocations.invoice_source_id"), receipt = state.receipts.get(receiptId), codes = accountCodes.get(receiptId);
    if (receipt && codes?.has("2100") && !codes.has("1100")) receipt.advanceAllocationByInvoice.set(invoiceId, (receipt.advanceAllocationByInvoice.get(invoiceId) ?? 0) + finite(allocation.amount, "advance allocation amount"));
  }
  for (const closeBook of tables.v2_close_books) { const periodId = required(closeBook.period_id, "v2_close_books.period_id"); if (!periods.has(periodId)) fail("snapshot close record references a missing period", { periodId }); const journalId = text(closeBook.journal_id); if (journalId && !journals.has(journalId)) fail("snapshot close record references a missing journal", { journalId }); }
  for (const [payRunId, payRun] of payRuns) { const periodId = required(payRun.period_id, `v2_pay_runs.${payRunId}.period_id`); if (!periods.has(periodId)) fail("snapshot pay run references a missing period", { payRunId, periodId }); const sourceId = text(payRun.source_id); if (sourceId && !sources.has(sourceId)) fail("snapshot pay run references a missing source", { payRunId, sourceId }); }
  const payslipIds = new Set<string>(); for (const payslip of tables.v2_payslips) { const id = required(payslip.id, "v2_payslips.id"); if (payslipIds.has(id)) fail("snapshot contains a duplicate payslip", { payslipId: id }); payslipIds.add(id); const payRunId = required(payslip.pay_run_id, `payslip ${id} pay_run_id`), employeeId = required(payslip.employee_id, `payslip ${id} employee_id`); if (!payRuns.has(payRunId) || !employees.has(employeeId)) fail("snapshot payslip has an invalid pay-run or employee reference", { payslipId: id }); }
  for (const period of periods.values()) if (text(period.status) === "closed") { const end = required(period.end_date, "v2_periods.end_date"); if (!state.closed || end > state.closed) state.closed = end; }
  for (const count of tables.v2_inventory_counts) {
    const periodId = required(count.period_id, "v2_inventory_counts.period_id"); if (!periods.has(periodId)) fail("snapshot inventory count references a missing period");
    const locationId = text(count.location_id); if (locationId && !locations.has(locationId)) fail("snapshot inventory count references a missing location", { locationId });
    const key = `all\u0000${locationId || "global"}\u0000${required(count.date, "v2_inventory_counts.date")}`; state.counts.add(key); state.countIds.set(required(count.id, "v2_inventory_counts.id"), key);
  }
  const opening = [...sources.entries()].filter(([id, source]) => text(source.type) === "opening_balance" && !state.reversed.has(id)); if (opening.length > 1) fail("snapshot contains multiple active opening-balance sources");
  if (opening.length === 1) {
    const [openingId, source] = opening[0], entries = [...journals.values()].filter((journal) => journal.source_id === openingId); if (!entries.length) fail("snapshot opening balance is missing its journal", { openingSourceId: openingId });
    const posted = entries.map((journal) => text(journal.posted_at)).sort().at(-1) || "", date = required(source.date, `opening balance ${openingId} date`);
    const later = [...journals.values()].some((journal) => journal.source_id !== openingId && !journal.reversal_of && ((posted && text(journal.posted_at) > posted) || (!posted && text(journal.date) > date)));
    state.opening = { aggregateId: `opening:${bookId}`, revision: 0, hasSubsequentPostings: later };
  }
}

/** Validate an uploaded projection completely before it can become canonical. */
export function validateSnapshotProjection(snapshot: SnapshotProjectionRow, bookId: string): void {
  hydrateSnapshotProjection(emptyTarget(), snapshot, bookId);
}
