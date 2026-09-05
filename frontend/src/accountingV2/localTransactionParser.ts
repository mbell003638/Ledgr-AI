import { isValidDateString, localTodayIso, normalizeDateInput } from '../utils/dateValidation';
import { splitSpokenTransactions } from './spokenTransactions';
import {
  CAPITAL_CUE,
  CAPITAL_IN_PHRASE,
  CAPITAL_OUT_PHRASE,
  commandWithCreatedParty,
  normalizeSpokenPaymentVerb,
  parseVoicePartyCreateRole,
  resolveVoicePartyCommand,
  sanitizeSpokenPartyName,
  stripRoleQualifiers,
  suggestedVoicePartyCreateRole,
  voiceCommandPartyName,
  type VoiceCommand,
  type VoicePartyDirectory,
} from './voicePartyResolution';

export type LocalTransactionMissingField = 'amount' | 'date' | 'party' | 'party_role' | 'method' | 'transaction_type';

export type LocalTransactionContinuation = {
  originalTranscript: string;
  partial: VoiceCommand;
  missingField: LocalTransactionMissingField;
};

export type LocalTransactionOutcome =
  | { status: 'confident'; command: VoiceCommand; commands?: VoiceCommand[]; confidence: number; source: 'local-rules' }
  | {
      status: 'clarification';
      question: string;
      partial: VoiceCommand;
      confidence: number;
      continuation: LocalTransactionContinuation;
      source: 'local-rules';
    }
  | { status: 'unsupported'; reason: string; confidence: 0; source: 'local-rules' };

export type LocalTransactionOptions = {
  /** Local calendar date used for "today" and "yesterday". */
  today?: string;
  /** Ask for the settlement account instead of silently assuming cash. */
  requirePaymentMethod?: boolean;
};

const MONEY = /(?:[$€£₹]\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:[$€£₹]|\b(?:USD|CAD|EUR|GBP|INR)\b)?/gi;
const METHOD_WORDS = /\b(cash|bank(?:\s+transfer)?|card|mobile|upi)\b/i;

function isoDaysBefore(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - days);
  return localTodayIso(date);
}

function parseDate(transcript: string, today: string): { date?: string; invalid?: boolean } {
  if (/\byesterday\b/i.test(transcript)) return { date: isoDaysBefore(today, 1) };
  if (/\btoday\b/i.test(transcript)) return { date: today };

  const match = transcript.match(/\b(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})\b/);
  if (!match) return {};
  const normalized = normalizeDateInput(match[1]);
  return isValidDateString(normalized) ? { date: normalized } : { invalid: true };
}

function parseAmount(transcript: string): number | undefined {
  const withoutDates = transcript
    .replace(/\b\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}\b/g, ' ');
  for (const match of withoutDates.matchAll(MONEY)) {
    const amount = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return undefined;
}

function parseMethod(transcript: string): VoiceCommand['method'] {
  const match = transcript.match(METHOD_WORDS)?.[1]?.toLowerCase();
  if (!match) return undefined;
  if (match === 'upi') return 'mobile';
  return match.startsWith('bank') ? 'bank' : match;
}

function tidyName(value: string): string {
  return stripRoleQualifiers(sanitizeSpokenPartyName(stripRoleQualifiers(value)
    .replace(MONEY, ' ')
    .replace(/\b(?:today|yesterday|now|on\s+credit|credit|cash|bank(?:\s+transfer)?|card|mobile|upi)\b/gi, ' ')
    .replace(/\b(?:supplier|vendor|customer|client|owner|partner|capital\s+account)\b/gi, ' ')
    .replace(/\b(?:by|via|using|as|for)\b[\s\S]*$/i, ' ')
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()));
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** True when a party answer plainly names an existing Supplier or Customer. */
function namesExistingParty(name: string, directory?: VoicePartyDirectory): boolean {
  if (!name.trim()) return false;
  return [...(directory?.suppliers || []), ...(directory?.customers || [])].some((row) => sameName(row.name, name));
}

/**
 * Finds the Capital Account a party answer refers to, but only once something
 * actually points at one. Without the gate a plain Supplier name could
 * prefix-match a Capital Account and silently repost the draft as a drawing.
 * An exact name always wins; a looser prefix match counts only when it is the
 * single possibility.
 */
function matchCapitalAccount(
  candidateNames: string[],
  capitalIntended: boolean,
  directory?: VoicePartyDirectory,
) {
  if (!capitalIntended) return null;
  const accounts = directory?.capitalAccounts || [];
  const matches = accounts.filter((acc) => candidateNames.some((cName) => {
    const accNorm = acc.name.trim().toLowerCase();
    const cNorm = cName.trim().toLowerCase();
    return accNorm === cNorm || accNorm.startsWith(cNorm + ' ') || cNorm.startsWith(accNorm + ' ');
  }));
  return matches.find((acc) => candidateNames.some((cName) => sameName(acc.name, cName)))
    || (matches.length === 1 ? matches[0] : null)
    || (candidateNames.length === 0 && accounts.length === 1 ? accounts[0] : null);
}

function commonCommand(transcript: string, options: LocalTransactionOptions): Pick<VoiceCommand, 'amount' | 'date' | 'method' | 'notes'> & { invalidDate?: boolean } {
  const today = options.today && isValidDateString(options.today) ? options.today : localTodayIso();
  const parsedDate = parseDate(transcript, today);
  return {
    amount: parseAmount(transcript),
    ...(parsedDate.date ? { date: parsedDate.date } : {}),
    method: parseMethod(transcript),
    notes: transcript.trim(),
    ...(parsedDate.invalid ? { invalidDate: true } : {}),
  };
}

function parseCommand(transcript: string, options: LocalTransactionOptions): VoiceCommand | null {
  const text = normalizeSpokenPaymentVerb(transcript.trim());
  if (!text || text.length > 1_000) return null;
  const common = commonCommand(text, options);

  // Capital movements are checked before generic receipts/payments so the
  // accounting meaning is not lost when the sentence also contains "cash".
  if (/\b(?:invested|contributed|capital\s+(?:contribution|deposit|injection)|added\s+capital)\b/i.test(text)) {
    const leading = text.match(/^([\p{L}][\p{L}\p{M}' .-]{0,100}?)\s+(?:invested|contributed)\b/iu)?.[1];
    const from = text.match(/\bfrom\s+([\s\S]+)$/i)?.[1];
    const partnerName = tidyName(leading || from || '');
    return { ...common, intent: 'capital', ...(partnerName ? { partnerName } : {}), summary: `Capital contribution${common.amount ? ` of ${common.amount}` : ''}${partnerName ? ` from ${partnerName}` : ''}` };
  }

  if (/\b(?:withdrew|withdraw(?:al|n)?|drawing|personal\s+(?:use|withdrawal)|took\s+(?:out|cash))\b/i.test(text)) {
    const leading = text.match(/^([\p{L}][\p{L}\p{M}' .-]{0,100}?)\s+(?:withdrew|withdraws?)\b/iu)?.[1];
    const to = text.match(/\bto\s+([\s\S]+)$/i)?.[1];
    const from = text.match(/\bfrom\s+([\s\S]+)$/i)?.[1];
    const partnerName = tidyName(to || leading || from || '');
    return { ...common, intent: 'drawing', ...(partnerName ? { partnerName } : {}), summary: `Capital withdrawal${common.amount ? ` of ${common.amount}` : ''}${partnerName ? ` for ${partnerName}` : ''}` };
  }

  if (/\b(?:received|collected|receipt)\b/i.test(text)) {
    const from = text.match(/\bfrom\s+([\s\S]+)$/i)?.[1] || '';
    const customerName = tidyName(from);
    return {
      ...common,
      intent: 'receipt',
      // Leave a named-customer receipt unallocated until the review flow can
      // select an invoice. An unnamed receipt is an unambiguous walk-in sale.
      ...(customerName ? {} : { receiptMode: 'cash_sale' }),
      ...(customerName ? { customerName } : {}),
      summary: `Receipt${common.amount ? ` of ${common.amount}` : ''}${customerName ? ` from ${customerName}` : ''}`,
    };
  }

  if (/\b(?:cash\s+sale|sale|sold)\b/i.test(text)) {
    return { ...common, intent: 'sale', paymentType: /\bcredit\b/i.test(text) ? 'credit' : 'cash', summary: `Sale${common.amount ? ` of ${common.amount}` : ''}` };
  }

  if (/\b(?:bill|invoice\s+from|bought|purchased?|buy)\b/i.test(text)) {
    const from = text.match(/\bfrom\s+([\s\S]+)$/i)?.[1] || '';
    const supplierName = tidyName(from);
    return {
      ...common,
      intent: 'bill',
      paymentType: /\b(?:on\s+credit|credit)\b/i.test(text) ? 'credit' : 'cash',
      ...(supplierName ? { supplierName } : {}),
      summary: `Purchase${common.amount ? ` of ${common.amount}` : ''}${supplierName ? ` from ${supplierName}` : ''}`,
    };
  }

  if (/\b(?:spent|expense|fuel|rent|utilities|salary|wages|office\s+supplies)\b/i.test(text)) {
    const category = tidyName(text.match(/\b(?:on|for)\s+([\s\S]+)$/i)?.[1] || '') || 'General';
    return { ...common, intent: 'expense', category, summary: `Expense${common.amount ? ` of ${common.amount}` : ''} for ${category}` };
  }

  if (/\b(?:pay|paid|paying|send|sent|gave|transfer|transferred|settled)\b/i.test(text)) {
    const to = text.match(/\bto\s+([\s\S]+)$/i)?.[1];
    const afterRole = text.match(/\b(?:supplier|vendor)\s+([\s\S]+)$/i)?.[1];
    const supplierName = tidyName(to || afterRole || '');
    return { ...common, intent: 'supplier_payment', ...(supplierName ? { supplierName } : {}), summary: `Payment${common.amount ? ` of ${common.amount}` : ''}${supplierName ? ` to ${supplierName}` : ''}` };
  }

  return null;
}

function clarification(originalTranscript: string, partial: VoiceCommand, missingField: LocalTransactionMissingField, question: string, confidence: number): LocalTransactionOutcome {
  return {
    status: 'clarification', question, partial, confidence, source: 'local-rules',
    continuation: { originalTranscript, partial, missingField },
  };
}

/**
 * Interprets routine accounting speech without an API call. The result is only
 * a draft command: it never writes to the ledger and must still pass the shared
 * proposal validator and explicit review/confirmation flow.
 */
export function interpretLocalTransaction(
  transcript: string,
  directory?: VoicePartyDirectory,
  options: LocalTransactionOptions = {},
): LocalTransactionOutcome {
  const command = parseCommand(transcript, options);
  if (!command) return { status: 'unsupported', reason: 'The local parser could not identify a supported transaction type.', confidence: 0, source: 'local-rules' };
  if (command.invalidDate) return clarification(transcript, command, 'date', 'I could not read that date. Please use YYYY-MM-DD.', 0.35);
  if (!command.amount) return clarification(transcript, command, 'amount', 'What is the transaction amount?', 0.55);

  if (directory && ['bill', 'supplier_payment', 'drawing', 'receipt', 'capital'].includes(String(command.intent))) {
    const resolution = resolveVoicePartyCommand(command, transcript, directory);
    if (!resolution.ok) return clarification(transcript, command, 'party_role', resolution.question, 0.65);
    Object.assign(command, resolution.command);
  } else if (['bill', 'supplier_payment'].includes(String(command.intent)) && !command.supplierName) {
    return clarification(transcript, command, 'party', 'Which supplier is this for?', 0.6);
  } else if (command.intent === 'capital' && !command.partnerName) {
    return clarification(transcript, command, 'party', 'Which Capital Account made this contribution?', 0.6);
  }

  const needsMethod = options.requirePaymentMethod !== false
    && ['expense', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent));
  if (needsMethod && !command.method) {
    return clarification(transcript, command, 'method', 'Was this Cash, Bank, Card, or Mobile?', 0.78);
  }
  return { status: 'confident', command, commands: [command], confidence: 0.92, source: 'local-rules' };
}

/** Parses compound speech such as “paid 100 to Amit and 50 to Rahim”. */
export function interpretLocalTransactions(
  transcript: string,
  directory?: VoicePartyDirectory,
  options: LocalTransactionOptions = {},
): LocalTransactionOutcome {
  const utterances = splitSpokenTransactions(transcript);
  if (utterances.length <= 1) return interpretLocalTransaction(transcript, directory, options);
  const parsed = utterances.map((utterance) => interpretLocalTransaction(utterance, undefined, { ...options, requirePaymentMethod: false }));
  const commands = parsed.filter((row): row is Extract<LocalTransactionOutcome, { status: 'confident' }> => row.status === 'confident').map((row) => row.command);
  if (commands.length === parsed.length && commands.length > 1) {
    return { status: 'confident', command: commands[0], commands, confidence: 0.9, source: 'local-rules' };
  }
  return interpretLocalTransaction(transcript, directory, options);
}

/** Continue one focused clarification without discarding the original draft. */
export function continueLocalTransaction(
  pending: LocalTransactionContinuation,
  answer: string,
  directory?: VoicePartyDirectory,
  options: LocalTransactionOptions = {},
): LocalTransactionOutcome {
  const command: VoiceCommand = { ...pending.partial };
  let resolutionTranscript = pending.originalTranscript;
  if (pending.missingField === 'amount') command.amount = parseAmount(answer);
  if (pending.missingField === 'date') {
    const today = options.today && isValidDateString(options.today) ? options.today : localTodayIso();
    const parsedDate = parseDate(answer, today);
    if (parsedDate.date) {
      command.date = parsedDate.date;
      delete command.invalidDate;
    }
  }
  if (pending.missingField === 'method') command.method = parseMethod(answer);
  if (pending.missingField === 'party') {
    const name = tidyName(answer.replace(/\b(?:capital(?:\s+account)?|partner|owner|investor|drawing)\b/gi, '').trim()) || tidyName(answer);
    const mentionsCapital = CAPITAL_CUE.test(answer) || /\binvestor\b/i.test(answer);
    const capitalIntended = mentionsCapital
      || (!namesExistingParty(name, directory) && (
        command.intent === 'capital'
        || command.intent === 'drawing'
        || CAPITAL_OUT_PHRASE.test(pending.originalTranscript)
        || CAPITAL_IN_PHRASE.test(pending.originalTranscript)
      ));
    const matchedCapital = matchCapitalAccount([name].filter(Boolean), capitalIntended, directory);

    if (matchedCapital) {
      command.intent = (command.intent === 'capital' || command.intent === 'receipt' || CAPITAL_IN_PHRASE.test(pending.originalTranscript)) ? 'capital' : 'drawing';
      command.partnerName = matchedCapital.name;
      delete command.supplierName;
      delete command.customerName;
      delete command.pendingPartyCreate;
      command.summary = command.intent === 'drawing'
        ? `Withdraw ${command.amount || '?'} from ${matchedCapital.name} Capital Account`
        : `Add ${command.amount || '?'} capital for ${matchedCapital.name}`;
    } else if (command.intent === 'capital' || command.intent === 'drawing') {
      command.partnerName = name;
    } else if (command.intent === 'receipt') {
      command.customerName = name;
    } else {
      command.supplierName = name;
    }
  }
  if (pending.missingField === 'party_role') {
    const role = parseVoicePartyCreateRole(answer, suggestedVoicePartyCreateRole(String(command.intent)));
    const existingPartyName = tidyName(voiceCommandPartyName(command));
    const cleanedAnswerName = tidyName(answer.replace(/\b(?:capital(?:\s+account)?|partner|owner|investor|drawing|withdraw(?:al|n)?|as\s+a)\b/gi, '').trim());
    const candidateNames = [cleanedAnswerName, existingPartyName].filter(Boolean);
    // Only reach for a Capital Account when the answer, the draft, or the
    // original sentence actually points at one, and never when the answer names
    // an existing Supplier or Customer outright.
    const capitalIntended = role === 'capital'
      || (!namesExistingParty(cleanedAnswerName, directory) && (
        command.intent === 'capital'
        || command.intent === 'drawing'
        || CAPITAL_CUE.test(answer) || /\binvestor\b/i.test(answer)
        || CAPITAL_OUT_PHRASE.test(pending.originalTranscript)
        || CAPITAL_IN_PHRASE.test(pending.originalTranscript)
      ));
    const matchedCapital = matchCapitalAccount(candidateNames, capitalIntended, directory);

    if (matchedCapital) {
      const isContribution = command.intent === 'capital' || command.intent === 'receipt'
        || CAPITAL_IN_PHRASE.test(pending.originalTranscript);
      command.intent = isContribution ? 'capital' : 'drawing';
      command.partnerName = matchedCapital.name;
      delete command.supplierName;
      delete command.customerName;
      delete command.pendingPartyCreate;
      command.summary = command.intent === 'drawing'
        ? `Withdraw ${command.amount || '?'} from ${matchedCapital.name} Capital Account`
        : `Add ${command.amount || '?'} capital for ${matchedCapital.name}`;
      resolutionTranscript = `${pending.originalTranscript} ${answer}`.trim();
    } else if (role === 'capital') {
      return clarification(pending.originalTranscript, command, 'party_role', 'Capital Accounts must be added from Accounts so opening capital and profit share stay correct.', 0.65);
    } else if ((role === 'supplier' || role === 'customer') && voiceCommandPartyName(command)) {
      Object.assign(command, commandWithCreatedParty(command, voiceCommandPartyName(command), role));
      resolutionTranscript = `${pending.originalTranscript} ${answer}`.trim();
    } else if (directory) {
      resolutionTranscript = `${pending.originalTranscript} ${answer}`.trim();
      const resolution = resolveVoicePartyCommand(command, resolutionTranscript, directory);
      if (!resolution.ok) return clarification(pending.originalTranscript, command, 'party_role', resolution.question, 0.65);
      Object.assign(command, resolution.command);
    }
  }

  if (!command.amount) return clarification(pending.originalTranscript, command, 'amount', 'What is the transaction amount?', 0.55);
  if (pending.missingField === 'date' && !command.date) return clarification(pending.originalTranscript, command, 'date', 'Please use a valid date such as 2026-09-01.', 0.5);
  if (pending.missingField === 'method' && !command.method) return clarification(pending.originalTranscript, command, 'method', 'Please choose Cash, Bank, Card, or Mobile.', 0.7);
  if (pending.missingField === 'party' && !(command.supplierName || command.customerName || command.partnerName)) {
    return clarification(pending.originalTranscript, command, 'party', 'Which account or party is this for?', 0.55);
  }
  return interpretResolvedCommand(resolutionTranscript, command, directory, options);
}

function interpretResolvedCommand(
  originalTranscript: string,
  command: VoiceCommand,
  directory: VoicePartyDirectory | undefined,
  options: LocalTransactionOptions,
): LocalTransactionOutcome {
  if (directory && ['bill', 'supplier_payment', 'drawing', 'receipt', 'capital'].includes(String(command.intent))) {
    const resolution = resolveVoicePartyCommand(command, originalTranscript, directory);
    if (!resolution.ok) return clarification(originalTranscript, command, 'party_role', resolution.question, 0.65);
    command = resolution.command;
  }
  const needsMethod = options.requirePaymentMethod !== false
    && ['expense', 'supplier_payment', 'drawing', 'capital'].includes(String(command.intent));
  if (needsMethod && !command.method) return clarification(originalTranscript, command, 'method', 'Was this Cash, Bank, Card, or Mobile?', 0.78);
  return { status: 'confident', command, confidence: 0.9, source: 'local-rules' };
}
