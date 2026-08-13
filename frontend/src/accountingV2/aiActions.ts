import type { V2PartyRole, V2PaymentMethod } from './types';
import { localTodayIso } from '../utils/dateValidation';

export type V2ActionSource = 'ai' | 'voice';
export type V2Report = 'profit_and_loss' | 'balance_sheet' | 'cash_flow' | 'trial_balance';

type ReadBase = { source: V2ActionSource; access: 'read' };
export type V2ReportQueryAction = ReadBase & { intent: 'report_query'; report: V2Report; from: string; to: string };
export type V2PartyLookupAction = ReadBase & { intent: 'party_lookup'; query: string; role?: V2PartyRole };
export type V2InventoryProfitAction = ReadBase & { intent: 'inventory_profit'; from: string; to: string };

export type V2InvoiceLine = { description: string; quantity: number; unitPrice: number };
export type V2Confirmation = { required: true; preview: string };
// isDestructive flags actions that permanently mutate/close data and therefore
// need a hardened (red) confirmation with an explicit destructive-action label.
type WriteBase = { source: V2ActionSource; access: 'write'; confirmation: V2Confirmation; isDestructive?: boolean };
export type V2CreateInvoiceAction = WriteBase & {
  intent: 'create_invoice'; partyId: string; date: string; lines: V2InvoiceLine[];
};
export type V2CreatePaymentAction = WriteBase & {
  intent: 'create_payment'; partyId: string; date: string; amount: number; method: V2PaymentMethod;
  direction: 'received' | 'paid'; invoiceId?: string;
};
export type V2CloseBooksAction = WriteBase & { intent: 'close_books'; periodId: string; date: string };

export type V2ReadAction = V2ReportQueryAction | V2PartyLookupAction | V2InventoryProfitAction;
export type V2WriteAction = V2CreateInvoiceAction | V2CreatePaymentAction | V2CloseBooksAction;
export type V2AiAction = V2ReadAction | V2WriteAction;
export type V2AiValidationResult = { ok: true; action: V2AiAction } | { ok: false; errors: string[] };
export type V2WriteExecutor<T> = (action: V2WriteAction) => Promise<T> | T;

const SOURCES: V2ActionSource[] = ['ai', 'voice'];
const REPORTS: V2Report[] = ['profit_and_loss', 'balance_sheet', 'cash_flow', 'trial_balance'];
const ROLES: V2PartyRole[] = ['customer', 'supplier'];
const METHODS: V2PaymentMethod[] = ['cash', 'bank', 'card', 'mobile', 'other'];

// Upper bound for any AI-proposed monetary amount. AI/OCR can hallucinate absurd
// figures (or an injected document can suggest one); anything at/above 1e9 is
// rejected so a bad extraction can never post a wildly wrong ledger entry.
export const MAX_AI_AMOUNT = 1_000_000_000;
// Calendar-year bounds for any AI-proposed date. Guards against OCR/parse noise
// producing dates like 0001 or 9999 that would corrupt period-based reports.
export const MIN_AI_YEAR = 2000;
export const MAX_AI_YEAR = 2099;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
// Positive and finite AND within MAX_AI_AMOUNT (rejects NaN/Infinity/absurd values).
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_AI_AMOUNT; }
// Non-negative and finite AND within MAX_AI_AMOUNT.
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AI_AMOUNT; }
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const year = Number(value.slice(0, 4));
  return year >= MIN_AI_YEAR && year <= MAX_AI_YEAR;
}
function failure(...errors: string[]): V2AiValidationResult { return { ok: false, errors }; }

export function validateV2AiAction(input: unknown): V2AiValidationResult {
  const value = record(input);
  if (!value) return failure('action must be an object');
  if (!SOURCES.includes(value.source as V2ActionSource)) return failure('source must be ai or voice');
  const source = value.source as V2ActionSource;

  switch (value.intent) {
    case 'report_query': {
      const errors: string[] = [];
      if (!REPORTS.includes(value.report as V2Report)) errors.push('report is invalid');
      if (!date(value.from)) errors.push('from must be a valid YYYY-MM-DD date');
      if (!date(value.to)) errors.push('to must be a valid YYYY-MM-DD date');
      if (errors.length) return failure(...errors);
      if ((value.from as string) > (value.to as string)) return failure('from must not be after to');
      return { ok: true, action: { source, intent: 'report_query', access: 'read', report: value.report as V2Report, from: value.from as string, to: value.to as string } };
    }
    case 'party_lookup': {
      if (!text(value.query)) return failure('query is required');
      if (value.role !== undefined && !ROLES.includes(value.role as V2PartyRole)) return failure('role is invalid');
      const action: V2PartyLookupAction = { source, intent: 'party_lookup', access: 'read', query: value.query.trim() };
      if (value.role !== undefined) action.role = value.role as V2PartyRole;
      return { ok: true, action };
    }
    case 'inventory_profit': {
      if (!date(value.from)) return failure('from must be a valid YYYY-MM-DD date');
      if (!date(value.to)) return failure('to must be a valid YYYY-MM-DD date');
      if ((value.from as string) > (value.to as string)) return failure('from must not be after to');
      return { ok: true, action: { source, intent: 'inventory_profit', access: 'read', from: value.from as string, to: value.to as string } };
    }
    case 'create_invoice': {
      const errors: string[] = [];
      if (!text(value.partyId)) errors.push('partyId is required');
      if (!date(value.date)) errors.push('date must be a valid YYYY-MM-DD date');
      if (!Array.isArray(value.lines) || value.lines.length === 0) errors.push('lines must contain at least one line');
      const lines: V2InvoiceLine[] = [];
      if (Array.isArray(value.lines)) value.lines.forEach((raw, index) => {
        const line = record(raw);
        if (!line || !text(line.description) || !positive(line.quantity) || !nonNegative(line.unitPrice)) {
          errors.push(`lines[${index}] must have description, positive quantity, and non-negative unitPrice`);
        } else lines.push({ description: line.description.trim(), quantity: line.quantity, unitPrice: line.unitPrice });
      });
      if (errors.length) return failure(...errors);
      const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
      const count = lines.length;
      return { ok: true, action: {
        source, intent: 'create_invoice', access: 'write', partyId: (value.partyId as string).trim(), date: value.date as string, lines,
        confirmation: { required: true, preview: `Create invoice for ${(value.partyId as string).trim()} on ${value.date}: ${count} ${count === 1 ? 'line' : 'lines'}, total ${total.toFixed(2)}` },
      } };
    }
    case 'create_payment': {
      const errors: string[] = [];
      if (!text(value.partyId)) errors.push('partyId is required');
      if (!date(value.date)) errors.push(`date must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`);
      if (!positive(value.amount)) errors.push(`amount must be a positive number no greater than ${MAX_AI_AMOUNT.toLocaleString()}`);
      if (!METHODS.includes(value.method as V2PaymentMethod)) errors.push('method is invalid');
      if (value.direction !== 'received' && value.direction !== 'paid') errors.push('direction must be received or paid');
      if (value.invoiceId !== undefined && !text(value.invoiceId)) errors.push('invoiceId must be non-empty');
      if (errors.length) return failure(...errors);
      const action: V2CreatePaymentAction = {
        source, intent: 'create_payment', access: 'write', partyId: (value.partyId as string).trim(), date: value.date as string,
        amount: value.amount as number, method: value.method as V2PaymentMethod, direction: value.direction as 'received' | 'paid',
        confirmation: { required: true, preview: `Record ${value.method} payment ${value.direction} of ${(value.amount as number).toFixed(2)} for ${(value.partyId as string).trim()} on ${value.date}` },
      };
      if (value.invoiceId !== undefined) action.invoiceId = (value.invoiceId as string).trim();
      return { ok: true, action };
    }
    case 'close_books': {
      if (!text(value.periodId)) return failure('periodId is required');
      if (!date(value.date)) return failure(`date must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`);
      return { ok: true, action: {
        source, intent: 'close_books', access: 'write', periodId: value.periodId.trim(), date: value.date,
        isDestructive: true,
        confirmation: { required: true, preview: `Close books for period ${value.periodId.trim()} on ${value.date}` },
      } };
    }
    default: return failure('intent is unsupported');
  }
}

export type AssistantEntryEntity = 'expense' | 'sale' | 'bill' | 'supplier_payment' | 'receipt' | 'invoice' | 'quote' | 'customer' | 'supplier' | 'delivery_note' | 'note' | 'inventory_count' | 'capital' | 'drawing' | 'cash_entry';
export type AssistantProposalType = 'add_expense' | 'add_sale' | 'add_bill' | 'add_debtor' | 'add_supplier' | 'add_debtor_payment' | 'create_invoice' | 'create_receipt' | 'create_quote' | 'create_supplier_payment' | 'create_drawing' | 'add_capital' | 'record_inventory' | 'update_entry' | 'delete_entry' | 'log_personal_expense';
// isDestructive mirrors the V2 write flag so confirm UIs can react uniformly.
// All current assistant proposals are additive, so this stays false/undefined;
// it exists so a destructive proposal (if ever added) is rendered with a
// hardened confirmation rather than the default one.
export type AssistantProposal = { source: V2ActionSource; type: AssistantProposalType; params: Record<string, unknown>; confirmation: V2Confirmation; isDestructive?: boolean };
export type AssistantProposalValidationResult = { ok: true; action: AssistantProposal } | { ok: false; errors: string[] };

const ASSISTANT_PROPOSAL_TYPES: AssistantProposalType[] = ['add_expense', 'add_sale', 'add_bill', 'add_debtor', 'add_supplier', 'add_debtor_payment', 'create_invoice', 'create_receipt', 'create_quote', 'create_supplier_payment', 'create_drawing', 'add_capital', 'record_inventory', 'update_entry', 'delete_entry', 'log_personal_expense'];
const ASSISTANT_ENTRY_ENTITIES: AssistantEntryEntity[] = ['expense', 'sale', 'bill', 'supplier_payment', 'receipt', 'invoice', 'quote', 'customer', 'supplier', 'delivery_note', 'note', 'inventory_count', 'capital', 'drawing', 'cash_entry'];
const ASSISTANT_UPDATE_FIELDS: Record<AssistantEntryEntity, readonly string[]> = {
  expense: ['amount', 'date', 'category', 'method', 'notes'],
  sale: ['amount', 'date', 'paymentType', 'method', 'notes'],
  bill: ['amount', 'date', 'paymentType', 'method', 'notes', 'invoiceNo'],
  supplier_payment: ['amount', 'date', 'method', 'notes'],
  receipt: ['amount', 'date', 'method', 'notes'],
  invoice: ['amount', 'date', 'dueDate', 'notes', 'clientName', 'clientPhone', 'lines', 'taxRate', 'taxLabel'],
  quote: ['amount', 'date', 'validUntil', 'notes', 'clientName', 'clientPhone', 'lines', 'taxRate', 'taxLabel', 'status'],
  customer: ['name', 'phone', 'email', 'address', 'notes'],
  supplier: ['name', 'phone', 'email', 'address', 'notes'],
  delivery_note: ['date', 'clientName', 'clientPhone', 'invoiceId', 'items', 'vehicleNo', 'status', 'notes'],
  note: ['amount', 'date', 'reference', 'reason', 'notes'],
  inventory_count: [],
  capital: ['amount', 'date', 'notes'],
  drawing: ['amount', 'date', 'notes'],
  cash_entry: ['amount', 'date', 'type', 'category', 'notes'],
};
const assistantAmount = (value: unknown) => {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[^0-9.-]/g, '')) : NaN;
  return Number.isFinite(amount) ? amount : NaN;
};

/** Validates the exact AI-proposed app action before the confirmation dialog is shown. */
export function validateAssistantProposal(input: unknown, source: V2ActionSource): AssistantProposalValidationResult {
  const value = record(input);
  if (!value || !ASSISTANT_PROPOSAL_TYPES.includes(value.type as AssistantProposalType)) return { ok: false, errors: ['unsupported AI action'] };
  const params = record(value.params) || {};
  if (JSON.stringify(params).length > 20_000) return { ok: false, errors: ['AI action is too large'] };
  const type = value.type as AssistantProposalType;
  if (type === 'update_entry' || type === 'delete_entry') {
    const entity = String(params.entity || '') as AssistantEntryEntity;
    const id = String(params.id || '').trim();
    if (!ASSISTANT_ENTRY_ENTITIES.includes(entity)) return { ok: false, errors: ['entry entity is unsupported'] };
    if (!id) return { ok: false, errors: ['entry id is required'] };
    if (type === 'delete_entry' && (entity === 'customer' || entity === 'supplier')) return { ok: false, errors: ['Customer and Supplier deletion must be done from the dedicated screen'] };
    if (entity === 'capital' && !text(params.memberId)) return { ok: false, errors: ['memberId is required for a capital entry'] };
    if (type === 'update_entry' && entity === 'inventory_count') return { ok: false, errors: ['inventory counts must be reversed and re-recorded'] };
    if (type === 'delete_entry') {
      return { ok: true, action: { source, type, params: { entity, id, memberId: params.memberId }, isDestructive: true, confirmation: { required: true, preview: `Reverse / delete ${entity.replace(/_/g, ' ')} ${id}` } } };
    }
    const changes = record(params.changes);
    if (!changes || Object.keys(changes).length === 0) return { ok: false, errors: ['entry changes are required'] };
    const unsupportedFields = Object.keys(changes).filter((field) => !ASSISTANT_UPDATE_FIELDS[entity].includes(field));
    if (unsupportedFields.length) return { ok: false, errors: [`unsupported ${entity} fields: ${unsupportedFields.join(', ')}`] };
    for (const field of ['date', 'dueDate', 'validUntil'] as const) {
      if (changes[field] !== undefined && changes[field] !== '' && !date(changes[field])) return { ok: false, errors: [`${field} must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`] };
    }
    if (changes.method !== undefined && !METHODS.includes(changes.method as V2PaymentMethod)) return { ok: false, errors: ['payment method is invalid'] };
    if (changes.paymentType !== undefined && !['cash', 'credit'].includes(String(changes.paymentType))) return { ok: false, errors: ['paymentType is invalid'] };
    if (changes.taxRate !== undefined && (!Number.isFinite(Number(changes.taxRate)) || Number(changes.taxRate) < 0 || Number(changes.taxRate) > 100)) return { ok: false, errors: ['taxRate must be between 0 and 100'] };
    if (entity === 'quote' && changes.status !== undefined && !['draft', 'sent', 'accepted', 'expired'].includes(String(changes.status))) return { ok: false, errors: ['quote status is invalid'] };
    if (entity === 'delivery_note' && changes.status !== undefined && !['pending', 'delivered'].includes(String(changes.status))) return { ok: false, errors: ['delivery note status is invalid'] };
    if (entity === 'cash_entry' && changes.type !== undefined && !['income', 'expense'].includes(String(changes.type))) return { ok: false, errors: ['cash entry type is invalid'] };
    if (Array.isArray(changes.lines) && changes.lines.some((line) => !record(line) || !text(record(line)?.description) || !positive(record(line)?.qty ?? record(line)?.quantity) || !positive(record(line)?.rate ?? record(line)?.unitPrice))) return { ok: false, errors: ['invoice or quote lines are invalid'] };
    if (Array.isArray(changes.items) && changes.items.some((item) => !record(item) || !text(record(item)?.description) || !positive(record(item)?.qty ?? record(item)?.quantity))) return { ok: false, errors: ['delivery note items are invalid'] };
    if (JSON.stringify(changes).length > 12_000) return { ok: false, errors: ['entry changes are too large'] };
    if (Array.isArray(changes.lines) && changes.lines.length > 50) return { ok: false, errors: ['invoice or quote lines cannot exceed 50'] };
    if (Array.isArray(changes.items) && changes.items.length > 50) return { ok: false, errors: ['delivery note items cannot exceed 50'] };
    const normalizedChanges = { ...changes };
    if (changes.amount !== undefined) {
      const amount = assistantAmount(changes.amount);
      if (!positive(amount)) return { ok: false, errors: [`amount must be a positive number no greater than ${MAX_AI_AMOUNT.toLocaleString()}`] };
      normalizedChanges.amount = amount;
    }
    if (changes.date !== undefined && !date(changes.date)) return { ok: false, errors: [`date must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`] };
    return { ok: true, action: { source, type, params: { entity, id, changes: normalizedChanges, memberId: params.memberId }, confirmation: { required: true, preview: `Update ${entity.replace(/_/g, ' ')} ${id}: ${JSON.stringify(normalizedChanges)}` } } };
  }
  const dateValue = params.date === undefined ? localTodayIso() : params.date;
  if (!date(dateValue)) return { ok: false, errors: [`date must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`] };
  const amount = assistantAmount(params.amount);
  const needAmount = !['add_debtor', 'add_supplier'].includes(type);
  // Reject NaN/Infinity, non-positive (or negative for inventory), AND anything above MAX_AI_AMOUNT.
  const amountBad = !Number.isFinite(amount) || amount > MAX_AI_AMOUNT || (type === 'record_inventory' ? amount < 0 : amount <= 0);
  if (needAmount && amountBad) return { ok: false, errors: [`amount must be a positive number no greater than ${MAX_AI_AMOUNT.toLocaleString()}`] };
  const requiredName = ['add_bill', 'create_supplier_payment'].includes(type) ? 'supplierName'
    : ['add_debtor', 'add_supplier', 'add_debtor_payment'].includes(type) ? 'name'
    : ['create_invoice', 'create_quote'].includes(type) ? 'clientName'
    : ['create_drawing', 'add_capital'].includes(type) ? 'partnerName' : null;
  if (requiredName && !text(params[requiredName])) return { ok: false, errors: [`${requiredName} is required`] };
  const mode = params.mode;
  if (type === 'create_receipt' && mode !== undefined && !['cash_sale', 'against_invoice', 'advance'].includes(String(mode))) return { ok: false, errors: ['receipt mode is invalid'] };
  if (type === 'create_receipt' && mode === 'against_invoice' && !text(params.customerName)) return { ok: false, errors: ['customerName is required for an invoice receipt'] };
  if (type === 'create_receipt' && mode === 'against_invoice' && !text(params.invoiceId)) return { ok: false, errors: ['invoiceId is required for an invoice receipt'] };
  const paymentType = params.paymentType;
  if (paymentType !== undefined && !['cash', 'credit'].includes(String(paymentType))) return { ok: false, errors: ['paymentType is invalid'] };
  const method = params.method;
  if (method !== undefined && !METHODS.includes(method as V2PaymentMethod)) return { ok: false, errors: ['payment method is invalid'] };
  const normalized = { ...params, date: dateValue, ...(needAmount ? { amount } : {}) };
  const name = String(params[requiredName || 'customerName'] || '').trim();
  const summary = type.replace(/_/g, ' ') + (needAmount ? ` of ${amount.toFixed(2)}` : '') + (name ? ` for ${name}` : '');
  return { ok: true, action: { source, type, params: normalized, confirmation: { required: true, preview: `Confirm ${summary} on ${dateValue}` } } };
}

/**
 * Bounds validation for a single AI-extracted supplier/customer statement line
 * (reconcile). Applies the SAME amount + date bounds as the proposal validators
 * so an invalid/hallucinated row can be flagged (and blocked from import) before
 * it is ever offered as addable. Returns null when the row is safe to import.
 */
export function validateReconcileEntry(entry: { amount?: unknown; date?: unknown }): string | null {
  if (!positive(entry?.amount)) {
    return `Amount must be a positive number no greater than ${MAX_AI_AMOUNT.toLocaleString()}`;
  }
  if (!date(entry?.date)) {
    return `Date must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`;
  }
  return null;
}

export async function executeAssistantProposal<T>(validation: AssistantProposalValidationResult, confirmation: { confirmed: boolean }, executor: () => Promise<T> | T): Promise<T> {
  if (!validation.ok) throw new Error(`Invalid AI action: ${validation.errors.join('; ')}`);
  if (confirmation.confirmed !== true) throw new Error('AI action requires explicit confirmation');
  return executor();
}
export async function executeV2AiAction<T>(
  validation: V2AiValidationResult,
  confirmation: { confirmed: boolean },
  executor: V2WriteExecutor<T>,
): Promise<T> {
  if (!validation.ok) throw new Error(`Invalid action: ${validation.errors.join('; ')}`);
  if (validation.action.access !== 'write') throw new Error('Expected a write action');
  if (confirmation.confirmed !== true) throw new Error('Write action requires explicit confirmation');
  return executor(validation.action);
}
