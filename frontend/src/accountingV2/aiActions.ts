import type { V2PartyRole, V2PaymentMethod } from './types';

export type V2ActionSource = 'ai' | 'voice';
export type V2Report = 'profit_and_loss' | 'balance_sheet' | 'cash_flow' | 'trial_balance';

type ReadBase = { source: V2ActionSource; access: 'read' };
export type V2ReportQueryAction = ReadBase & { intent: 'report_query'; report: V2Report; from: string; to: string };
export type V2PartyLookupAction = ReadBase & { intent: 'party_lookup'; query: string; role?: V2PartyRole };
export type V2InventoryProfitAction = ReadBase & { intent: 'inventory_profit'; from: string; to: string };

export type V2InvoiceLine = { description: string; quantity: number; unitPrice: number };
export type V2Confirmation = { required: true; preview: string };
type WriteBase = { source: V2ActionSource; access: 'write'; confirmation: V2Confirmation };
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function nonNegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
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
      if (!date(value.date)) errors.push('date must be a valid YYYY-MM-DD date');
      if (!positive(value.amount)) errors.push('amount must be positive');
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
      if (!date(value.date)) return failure('date must be a valid YYYY-MM-DD date');
      return { ok: true, action: {
        source, intent: 'close_books', access: 'write', periodId: value.periodId.trim(), date: value.date,
        confirmation: { required: true, preview: `Close books for period ${value.periodId.trim()} on ${value.date}` },
      } };
    }
    default: return failure('intent is unsupported');
  }
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
