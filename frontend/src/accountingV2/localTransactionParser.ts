import { isValidDateString, localTodayIso, normalizeDateInput } from '../utils/dateValidation';
import {
  commandWithCreatedParty,
  parseVoicePartyCreateRole,
  sanitizeSpokenPartyName,
  suggestedVoicePartyCreateRole,
  voiceCommandPartyName,
  type VoiceCommand,
} from './voicePartyResolution';

export type LocalParseConfidence = 'high' | 'medium' | 'low';
export type LocalClarificationField = 'intent' | 'amount' | 'party' | 'method' | 'date' | 'paymentType';

export type LocalTransactionParseResult =
  | { kind: 'confident'; confidence: 'high' | 'medium'; command: VoiceCommand; transcript: string }
  | { kind: 'clarification'; confidence: 'medium' | 'low'; command: VoiceCommand; field: LocalClarificationField; question: string; transcript: string }
  | { kind: 'unsupported'; confidence: 'low'; reason: string; transcript: string };

export type LocalTransactionParserOptions = {
  now?: Date;
  defaultCurrency?: string;
  /** When true, money movements without an explicit payment method ask one question. */
  requirePaymentMethod?: boolean;
};

const MONEY = /(?:[$€£₹]\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:[$€£₹]|\b(?:USD|CAD|EUR|GBP|INR)\b)?/i;
const METHODS = /\b(cash|bank(?:\s+transfer)?|card|credit\s+card|debit\s+card|mobile(?:\s+money)?|upi|cheque|check)\b/i;
const DATE_WORDS = /\b(today|yesterday|tomorrow)\b/i;
const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const cleanText = (value: string) => value.replace(/\s+/g, ' ').trim();
const cleanName = (value: string) => cleanText(value)
  .replace(/^(?:the\s+)?(?:supplier|vendor|customer|client|capital\s+account|partner|owner)\s+/i, '')
  .replace(/\s+(?:today|yesterday|tomorrow)$/i, '')
  .replace(/\s+(?:by|via|using|from)\s+(?:cash|bank(?:\s+transfer)?|card|mobile(?:\s+money)?|upi|cheque|check)$/i, '')
  .replace(/\s+(?:as|for)\s+(?:a\s+)?(?:supplier\s+payment|capital\s+(?:contribution|withdrawal)|drawing)$/i, '')
  .replace(/[.,!?;:]+$/g, '')
  .trim();

function isoWithOffset(now: Date, days: number): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return localTodayIso(next);
}

function parseDate(text: string, now: Date): { date?: string; invalid?: boolean } {
  const relative = text.match(DATE_WORDS)?.[1]?.toLowerCase();
  if (relative === 'today') return { date: isoWithOffset(now, 0) };
  if (relative === 'yesterday') return { date: isoWithOffset(now, -1) };
  if (relative === 'tomorrow') return { date: isoWithOffset(now, 1) };

  const numeric = text.match(/\b(\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\b/);
  if (numeric) {
    const value = normalizeDateInput(numeric[1]);
    return isValidDateString(value) ? { date: value } : { invalid: true };
  }

  const monthName = text.match(/\b(?:on\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (monthName) {
    const month = MONTHS[monthName[1].toLowerCase()];
    const year = Number(monthName[3] || now.getFullYear());
    const value = `${year}-${String(month).padStart(2, '0')}-${String(Number(monthName[2])).padStart(2, '0')}`;
    return isValidDateString(value) ? { date: value } : { invalid: true };
  }
  return { date: isoWithOffset(now, 0) };
}

function parseAmount(text: string): number | undefined {
  // A spoken date is not an amount (for example "on 2026-08-31 paid 100").
  const withoutDates = text
    .replace(/\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/g, ' ');
  const match = withoutDates.match(MONEY);
  if (!match) return undefined;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

function parseCurrency(text: string, fallback: string): string {
  if (/₹|\bINR\b/i.test(text)) return 'INR';
  if (/€|\bEUR\b/i.test(text)) return 'EUR';
  if (/£|\bGBP\b/i.test(text)) return 'GBP';
  if (/\bCAD\b/i.test(text)) return 'CAD';
  if (/\$|\bUSD\b/i.test(text)) return fallback.toUpperCase() === 'CAD' ? 'CAD' : 'USD';
  return fallback.toUpperCase();
}

function parseMethod(text: string): string | undefined {
  const raw = text.match(METHODS)?.[1]?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'upi' || raw.startsWith('mobile')) return 'mobile';
  if (raw === 'check') return 'cheque';
  if (raw.includes('card')) return 'card';
  if (raw.startsWith('bank')) return 'bank';
  return raw;
}

function partyAfter(text: string, marker: 'to' | 'from'): string | undefined {
  const match = text.match(new RegExp(`\\b${marker}\\b\\s+([\\s\\S]+)$`, 'i'));
  if (!match) return undefined;
  const party = cleanName(match[1]
    .replace(/\bfor\s+(?:[$€£₹]\s*)?\d[\d,]*(?:\.\d{1,2})?\s*(?:[$€£₹]|USD|CAD|EUR|GBP|INR)?\b[\s\S]*$/i, '')
    .replace(/\bon\s+credit\b[\s\S]*$/i, '')
    .replace(MONEY, '')
    .replace(DATE_WORDS, '')
    .replace(METHODS, '')
    .replace(/^(?:supplier|vendor|customer|client|capital\s+account|partner|owner)\s+/i, '')
    .replace(/\b(?:on|by|via|using)\s*$/i, ''));
  return sanitizeSpokenPartyName(party) || undefined;
}

function categoryFrom(text: string): string | undefined {
  const match = text.match(/\b(?:spent|spend|expense|paid)\b[\s\S]*?\b(?:for|on)\b\s+([\s\S]+)$/i);
  if (!match) return undefined;
  const category = cleanName(match[1].replace(DATE_WORDS, '').replace(METHODS, '').replace(/\b(?:by|via|using)\b/g, ''));
  return category || undefined;
}

function withCommon(command: VoiceCommand, text: string, options: LocalTransactionParserOptions): VoiceCommand {
  const date = parseDate(text, options.now || new Date()).date;
  const method = parseMethod(text);
  return {
    ...command,
    ...(date ? { date } : {}),
    ...(method ? { method } : {}),
    currency: parseCurrency(text, options.defaultCurrency || 'USD'),
    notes: cleanText(text),
  };
}

function clarify(command: VoiceCommand, transcript: string, field: LocalClarificationField, question: string): LocalTransactionParseResult {
  return { kind: 'clarification', confidence: command.intent ? 'medium' : 'low', command, field, question, transcript };
}

/**
 * Deterministically interprets common, single-entry accounting speech without
 * calling an AI provider. It only returns a confident result when an intent and
 * positive amount are known; party roles are resolved separately against the
 * current book before a review-only draft is shown.
 */
export function parseLocalTransaction(
  rawTranscript: string,
  options: LocalTransactionParserOptions = {},
): LocalTransactionParseResult {
  const transcript = cleanText(rawTranscript);
  if (!transcript) return { kind: 'unsupported', confidence: 'low', reason: 'No transaction was provided.', transcript };

  const amount = parseAmount(transcript);
  const parsedDate = parseDate(transcript, options.now || new Date());
  if (parsedDate.invalid) return clarify({}, transcript, 'date', 'What date should I use? Say today or a date such as 2026-08-31.');

  let command: VoiceCommand | null = null;
  const outgoingParty = partyAfter(transcript, 'to');
  const incomingParty = partyAfter(transcript, 'from');
  const explicitCapitalIn = /\b(?:invested|invest|contributed|contribute)\b|\b(?:added|add|deposit(?:ed)?)\b[\s\S]*\bcapital\b|\bcapital\s+(?:contribution|deposit|injection)\b/i.test(transcript);
  const explicitDrawing = /\b(?:withdrew|withdraw|drawing|drew)\b[\s\S]*\b(?:capital|owner|partner)?\b|\bcapital\s+withdrawal\b/i.test(transcript);
  const supplierNamed = transcript.match(/\b(?:pay|paid|paying|settled?)\s+(?:the\s+)?(?:supplier|vendor)\s+([A-Za-z][A-Za-z0-9 .'-]{0,159}?)(?=\s+(?:[$€£₹]?\s*\d|by\b|via\b|using\b|today\b|yesterday\b|on\b)|$)/i)?.[1];
  const supplierPayment = /\b(?:pay|paid|paying|settled?|send|sent|transferred?|gave)\b/i.test(transcript) && Boolean(outgoingParty || supplierNamed);
  const receipt = /\b(?:received?|collected?|customer\s+payment)\b/i.test(transcript);
  const bill = /\b(?:bill|invoice|bought|purchased?)\b/i.test(transcript) && /\b(?:credit|supplier|vendor|bill|invoice)\b/i.test(transcript);
  const sale = /\b(?:cash\s+sale|sale|sold)\b/i.test(transcript);
  const expense = /\b(?:spent|expense|fuel|rent|utilities?|salary|wages|office\s+supplies|transport|meal)\b/i.test(transcript)
    || (/\bpaid\b/i.test(transcript) && /\b(?:for|on)\b/i.test(transcript) && !outgoingParty);

  if (explicitCapitalIn) {
    const leadingInvestor = transcript.match(/^([A-Za-z][A-Za-z0-9 .'-]{0,159}?)\s+(?:invested|invests|contributed|contributes)\b/i)?.[1];
    const partnerName = partyAfter(transcript, 'from') || partyAfter(transcript, 'to') || (leadingInvestor ? cleanName(leadingInvestor) : undefined);
    command = { intent: 'capital', amount, partnerName: partnerName || undefined, summary: `Add ${amount || '?'} capital${partnerName ? ` for ${partnerName}` : ''}` };
  } else if (explicitDrawing) {
    const leadingOwner = transcript.match(/^([A-Za-z][A-Za-z0-9 .'-]{0,159}?)\s+(?:withdrew|withdraws|drew)\b/i)?.[1];
    const partnerName = partyAfter(transcript, 'from') || outgoingParty || (leadingOwner ? cleanName(leadingOwner) : undefined);
    command = { intent: 'drawing', amount, partnerName, summary: `Withdraw ${amount || '?'}${partnerName ? ` from ${partnerName} Capital Account` : ' from a Capital Account'}` };
  } else if (bill) {
    const supplierName = incomingParty || outgoingParty || transcript.match(/\b(?:supplier|vendor)\s+([A-Za-z][\w .'-]{0,159})/i)?.[1];
    command = { intent: 'bill', amount, supplierName: supplierName ? cleanName(supplierName) : undefined, paymentType: /\bcredit\b/i.test(transcript) ? 'credit' : 'cash', summary: `Record ${amount || '?'} supplier bill${supplierName ? ` from ${cleanName(supplierName)}` : ''}` };
  } else if (receipt) {
    const customerName = incomingParty || transcript.match(/\b(?:customer|client)\s+([A-Za-z][\w .'-]{0,159})/i)?.[1];
    command = { intent: 'receipt', amount, customerName: customerName ? cleanName(customerName) : undefined, receiptMode: customerName ? 'against_invoice' : 'cash_sale', summary: `Receive ${amount || '?'}${customerName ? ` from ${cleanName(customerName)}` : ''}` };
  } else if (sale) {
    command = { intent: 'sale', amount, paymentType: /\bcredit\b/i.test(transcript) ? 'credit' : 'cash', summary: `Record ${amount || '?'} sale` };
  } else if (expense) {
    const category = categoryFrom(transcript) || transcript.match(/\b(fuel|rent|utilities?|salary|wages|transport|meals?|office\s+supplies)\b/i)?.[1];
    command = { intent: 'expense', amount, category: category ? cleanName(category) : 'General', summary: `Record ${amount || '?'} expense${category ? ` for ${cleanName(category)}` : ''}` };
  } else if (supplierPayment) {
    const supplierName = outgoingParty || (supplierNamed ? cleanName(supplierNamed) : undefined);
    command = { intent: 'supplier_payment', amount, supplierName, summary: `Pay ${amount || '?'}${supplierName ? ` to ${supplierName}` : ''}` };
  }

  if (!command) {
    if (amount) return clarify({ amount }, transcript, 'intent', 'Is this an expense, sale, bill, receipt, supplier payment, capital contribution, or drawing?');
    return { kind: 'unsupported', confidence: 'low', reason: 'Include one supported transaction and its amount.', transcript };
  }

  command = withCommon(command, transcript, options);
  if (!amount) return clarify(command, transcript, 'amount', 'What is the transaction amount?');
  if (['bill', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent))
      && !String(command.supplierName || command.partnerName || '').trim()) {
    return clarify(command, transcript, 'party', command.intent === 'bill' || command.intent === 'supplier_payment'
      ? 'Which Supplier is this for?'
      : 'Which Capital Account is this for?');
  }
  if (command.intent === 'receipt' && command.receiptMode !== 'cash_sale' && !String(command.customerName || '').trim()) {
    return clarify(command, transcript, 'party', 'Which Customer is this receipt from?');
  }
  if (options.requirePaymentMethod && ['expense', 'receipt', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent)) && !command.method) {
    return clarify(command, transcript, 'method', 'Was this Cash, Bank, Card, Mobile / UPI, or Cheque?');
  }
  return { kind: 'confident', confidence: command.method || ['sale', 'bill'].includes(String(command.intent)) ? 'high' : 'medium', command, transcript };
}

/** Applies one focused answer without dropping the original transaction. */
export function continueLocalTransaction(
  pending: Extract<LocalTransactionParseResult, { kind: 'clarification' }>,
  answer: string,
  options: LocalTransactionParserOptions = {},
): LocalTransactionParseResult {
  const value = cleanText(answer);
  if (!value) return pending;
  const command = { ...pending.command };

  if (pending.field === 'amount') command.amount = parseAmount(value);
  else if (pending.field === 'method') command.method = parseMethod(value);
  else if (pending.field === 'date') {
    const parsed = parseDate(value, options.now || new Date());
    if (!parsed.date || parsed.invalid) return clarify(command, pending.transcript, 'date', 'What date should I use? Say today or a date such as 2026-08-31.');
    command.date = parsed.date;
  } else if (pending.field === 'paymentType') {
    if (/\bcredit\b/i.test(value)) command.paymentType = 'credit';
    else if (/\b(?:cash|paid)\b/i.test(value)) command.paymentType = 'cash';
  } else if (pending.field === 'party') {
    const role = parseVoicePartyCreateRole(value, suggestedVoicePartyCreateRole(String(command.intent)));
    if (role === 'capital') {
      return clarify(command, pending.transcript, 'party', 'Capital Accounts must be added from Accounts so opening capital and profit share stay correct.');
    }
    if (role === 'supplier' || role === 'customer') {
      const name = voiceCommandPartyName(command);
      if (!name) return clarify(command, pending.transcript, 'party', 'Which name should I create?');
      Object.assign(command, commandWithCreatedParty(command, name, role));
    } else {
      const party = cleanName(value);
      if (command.intent === 'bill' || command.intent === 'supplier_payment') command.supplierName = party;
      else if (command.intent === 'receipt') command.customerName = party;
      else command.partnerName = party;
    }
  } else if (pending.field === 'intent') {
    return parseLocalTransaction(`${value} ${command.amount || ''} ${pending.transcript}`, options);
  }

  const combined = `${pending.transcript} ${value}`;
  if (!Number.isFinite(Number(command.amount)) || Number(command.amount) <= 0) return clarify(command, combined, 'amount', 'What is the transaction amount?');
  if (pending.field === 'method' && !command.method) return clarify(command, combined, 'method', 'Was this Cash, Bank, Card, Mobile / UPI, or Cheque?');
  if (pending.field === 'party' && !String(command.supplierName || command.customerName || command.partnerName || '').trim()) return pending;
  if (options.requirePaymentMethod && ['expense', 'receipt', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent)) && !command.method) {
    return clarify(command, combined, 'method', 'Was this Cash, Bank, Card, Mobile / UPI, or Cheque?');
  }
  return { kind: 'confident', confidence: 'high', command, transcript: combined };
}
