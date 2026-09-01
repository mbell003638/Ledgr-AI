/**
 * Validated hand-off contract for Android Assistant/App Actions.
 *
 * Assistant requests are deliberately converted into a reviewable draft. This
 * module never writes to the ledger and does not accept credentials or book
 * data from an external intent.
 */

export type AssistantAction =
  | 'record_payment'
  | 'record_expense'
  | 'record_receipt'
  | 'add_capital'
  | 'open_ask_ai'
  | 'open_voice'
  | 'open_scanner';

export type AssistantDraft = {
  action: Extract<AssistantAction, 'record_payment' | 'record_expense' | 'record_receipt' | 'add_capital'>;
  amount?: number;
  currency?: string;
  date?: string;
  counterparty?: string;
  paymentMethod?: string;
  note?: string;
  source: 'android-assistant';
  requiresConfirmation: true;
};

export type AssistantIntentResult =
  | { kind: 'draft'; draft: AssistantDraft }
  | { kind: 'navigation'; target: 'ask-ai' | 'voice' | 'scanner' }
  | { kind: 'rejected'; reason: string };

const MAX_TEXT = 240;
const ACTIONS = new Set<AssistantAction>([
  'record_payment', 'record_expense', 'record_receipt', 'add_capital',
  'open_ask_ai', 'open_voice', 'open_scanner',
]);

function text(value: unknown, field: string): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT) {
    throw new Error(`${field} is invalid`);
  }
  return value.trim() || undefined;
}

function date(value: unknown): string | undefined {
  const result = text(value, 'date');
  if (!result) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error('date is invalid');
  }
  return result;
}

function amount(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > 1_000_000_000) {
    throw new Error('amount is invalid');
  }
  return Math.round(result * 100) / 100;
}

/** Parse a ledgr://assistant?… URL or a plain Android intent payload. */
export function parseAssistantIntent(input: unknown): AssistantIntentResult {
  try {
    const params: Record<string, unknown> = input instanceof URL
      ? Object.fromEntries(input.searchParams.entries())
      : typeof input === 'string'
        ? Object.fromEntries(new URL(input).searchParams.entries())
        : (input && typeof input === 'object' ? input as Record<string, unknown> : {});
    const rawAction = params.action;
    if (typeof rawAction !== 'string' || !ACTIONS.has(rawAction as AssistantAction)) {
      return { kind: 'rejected', reason: 'Unsupported Assistant action' };
    }
    const action = rawAction as AssistantAction;
    if (action === 'open_ask_ai') return { kind: 'navigation', target: 'ask-ai' };
    if (action === 'open_voice') return { kind: 'navigation', target: 'voice' };
    if (action === 'open_scanner') return { kind: 'navigation', target: 'scanner' };

    const draft: AssistantDraft = {
      action,
      amount: amount(params.amount),
      currency: text(params.currency, 'currency')?.toUpperCase(),
      date: date(params.date),
      counterparty: text(params.counterparty ?? params.party, 'counterparty'),
      paymentMethod: text(params.paymentMethod, 'paymentMethod'),
      note: text(params.note, 'note'),
      source: 'android-assistant',
      requiresConfirmation: true,
    };
    if (!draft.amount && action !== 'record_receipt') {
      return { kind: 'rejected', reason: 'Amount is required for this action' };
    }
    return { kind: 'draft', draft };
  } catch (error) {
    return { kind: 'rejected', reason: error instanceof Error ? error.message : 'Invalid Assistant request' };
  }
}
