type NamedAccount = { id: string; name: string };

export type VoicePartyDirectory = {
  suppliers: NamedAccount[];
  customers: NamedAccount[];
  capitalAccounts: NamedAccount[];
};

export type VoicePartyCreateRole = 'supplier' | 'customer';

export type VoiceCommand = Record<string, unknown> & {
  intent?: string;
  amount?: number;
  supplierName?: string;
  customerName?: string;
  partnerName?: string;
  summary?: string;
  pendingPartyCreate?: { role: VoicePartyCreateRole; name: string };
};

export type VoicePartyCreateProposal = {
  name: string;
  suggestedRole?: VoicePartyCreateRole;
  suggestions?: string[];
};

export type VoicePartyResolution =
  | { ok: true; command: VoiceCommand }
  | { ok: false; question: string; createProposal?: VoicePartyCreateProposal };

const normalized = (value: unknown) => String(value || '').trim().toLocaleLowerCase();
const exact = (rows: NamedAccount[], name: string) => rows.filter((row) => normalized(row.name) === normalized(name));
const prefixOrWordMatch = (rows: NamedAccount[], targetName: string) => {
  const normTarget = normalized(targetName);
  if (normTarget.length < 2) return [];
  return rows.filter((row) => {
    const rowNorm = normalized(row.name);
    return rowNorm === normTarget || rowNorm.startsWith(normTarget + ' ') || normTarget.startsWith(rowNorm + ' ');
  });
};
const one = (rows: NamedAccount[]) => rows.length === 1 ? rows[0] : null;

/**
 * Trailing capital-account role phrases that speech leaves attached to a party
 * name, such as "Amit withdrawal from capital account" or "Amit as a drawing".
 * Each pattern needs an explicit capital/drawing cue, so ordinary business
 * wording like "as security deposit" or "by bank deposit" keeps its name.
 */
const ROLE_QUALIFIER_TAILS: RegExp[] = [
  /\s+(?:(?:as|for)\s+(?:a\s+)?)?capital\s+(?:withdrawal|drawing|deposit|contribution)\b[\s\S]*$/i,
  /\s+(?:as|for)\s+(?:a\s+)?(?:withdrawal|drawing|contribution)\b[\s\S]*$/i,
  /\s+(?:withdrawal|withdrawn|withdraw|drawing)\s+(?:from|out\s+of|of)\b[\s\S]*$/i,
  /\s+(?:withdrawal|drawing)$/i,
  /\s+(?:from|to|for|in|as|of)\s+(?:a\s+|the\s+|his\s+|her\s+|their\s+)?capital\s+account\b[\s\S]*$/i,
];

/** Removes trailing capital-account role phrases from a spoken party name. */
export function stripRoleQualifiers(value: string): string {
  return ROLE_QUALIFIER_TAILS.reduce((text, pattern) => text.replace(pattern, ''), String(value || '')).trim();
}

/**
 * A spoken sentence only means a Capital Account movement when it names one.
 * "Deposit" and "contribution" on their own are ordinary business words, so
 * they need a capital cue before they can retype a payment as capital.
 */
/**
 * Speech recognition mishears the opening "paid" of a spoken transaction as
 * "play"/"played"/"pled", which used to fail the whole parse with "could not
 * identify a supported transaction type" even though the rest of the sentence
 * was understood. Only rewrites when an amount follows within a few
 * characters, so ordinary uses of "play" are left alone.
 */
const MISHEARD_PAID = /\b(?:play|played|plays|playing|pled)\b(?=[^\d\n]{0,12}\d)/gi;

export function normalizeSpokenPaymentVerb(transcript: string): string {
  return String(transcript || '').replace(MISHEARD_PAID, (word) => (
    word[0] === word[0].toUpperCase() ? 'Paid' : 'paid'
  ));
}

export const CAPITAL_CUE = /\bcapital\b|\bpartner(?:'s|s')?\b|\bowner(?:'s|s')?\b|\bdrawings?\b/i;
export const CAPITAL_IN_PHRASE = /\b(?:invested|invest|contributed|contribute)\b|\b(?:added|add|deposit(?:ed)?)\b[\s\S]*\bcapital\b|\bcapital\s+(?:contribution|deposit|injection)\b/i;
export const CAPITAL_OUT_PHRASE = /\b(?:withdrawal|withdrawals|withdrawn|withdraws|withdrew|withdraw|drawings?|drew)\b/i;

/**
 * Parse the common "paid AMOUNT ... to NAME" shape locally. This deliberately
 * handles only a narrow, high-confidence form: broader language still goes to
 * the configured AI provider. Keeping party resolution local means summary
 * mode does not have to disclose account names just to identify an exact
 * Supplier or Capital Account.
 */
export function parseSimpleOutgoingPayment(rawTranscript: string): VoiceCommand | null {
  const transcript = normalizeSpokenPaymentVerb(rawTranscript);
  const match = transcript.match(/\b(?:pay|paid|paying|send|sent|gave|transfer|transferred)\b([\s\S]*?)\bto\b\s+([\s\S]+)$/i);
  if (!match) return null;

  // Explicit non-today dates need the provider's date parser; never silently
  // turn them into today's date.
  if (/\b(?:yesterday|tomorrow)\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\bon\s+\d{1,2}[\/-]\d{1,2}/i.test(transcript)) return null;

  const amountMatch = match[1].match(/(?:[$€£₹]\s*)?(\d[\d,]*(?:\.\d+)?)\s*(?:[$€£₹]|(?:USD|CAD|EUR|GBP|INR)\b)?/i);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const name = sanitizeSpokenPartyName(stripRoleQualifiers(match[2]
    .replace(/\s+(?:via|using|by|from)\s+(?:cash|bank(?:\s+transfer)?|card|mobile|upi)\b[\s\S]*$/i, '')
    .replace(/\s+(?:as|for)\s+(?:a\s+)?(?:supplier\s+payment|capital\s+(?:account|withdrawal)|drawing)\b[\s\S]*$/i, '')
    .replace(/^\s*(?:supplier|vendor|capital\s+account)\s+/i, '')));
  if (!name || name.length > 160) return null;

  const method = /\bupi\b/i.test(transcript) ? 'upi'
    : /\bmobile\b/i.test(transcript) ? 'mobile'
    : /\bcard\b/i.test(transcript) ? 'card'
    : /\bbank(?:\s+transfer)?\b/i.test(transcript) ? 'bank'
    : /\bcash\b/i.test(transcript) ? 'cash'
    : undefined;

  // Money coming in only becomes partner capital when the sentence says so.
  // Plain "security deposit" or "bank deposit" wording used to be reposted as a
  // capital contribution, which put the payment in the wrong account.
  const isDrawing = CAPITAL_OUT_PHRASE.test(transcript);
  const isCapitalIn = CAPITAL_IN_PHRASE.test(transcript);

  if (isDrawing) {
    return {
      intent: 'drawing',
      amount,
      partnerName: name,
      ...(method ? { method } : {}),
      summary: `Withdraw ${amount} from ${name} Capital Account`,
    };
  }

  if (isCapitalIn) {
    return {
      intent: 'capital',
      amount,
      partnerName: name,
      ...(method ? { method } : {}),
      summary: `Add ${amount} capital for ${name}`,
    };
  }

  return {
    intent: 'supplier_payment',
    amount,
    supplierName: name,
    ...(method ? { method } : {}),
    summary: `Pay ${amount} to ${name}`,
  };
}

export function sanitizeSpokenPartyName(name: string): string {
  const cleaned = String(name || '')
    .replace(/\s+(?:today|now|please)$/i, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim();
  if (!cleaned) return '';
  if (/^(make|made|pay|paid|get|got|buy|bought|do|did|go|went|take|took|send|sent|have|had)$/i.test(cleaned)) return '';
  return cleaned;
}

export function suggestPartyNames(name: string, directory: VoicePartyDirectory): string[] {
  const needle = normalized(name);
  if (needle.length < 2) return [];
  const pool = [...directory.suppliers, ...directory.customers, ...directory.capitalAccounts];
  const hits = pool.filter((row) => {
    const value = normalized(row.name);
    return value === needle || value.includes(needle) || needle.includes(value) || (needle.length >= 3 && value.startsWith(needle.slice(0, 3)));
  });
  return [...new Set(hits.map((row) => row.name))].slice(0, 3);
}

export function voiceCommandPartyName(command: VoiceCommand): string {
  return sanitizeSpokenPartyName(String(command.supplierName || command.customerName || command.partnerName || ''));
}

export function suggestedVoicePartyCreateRole(intent?: string): VoicePartyCreateRole | undefined {
  if (intent === 'receipt') return 'customer';
  if (intent === 'bill' || intent === 'supplier_payment') return 'supplier';
  return undefined;
}

export function parseVoicePartyCreateRole(
  answer: string,
  suggested?: VoicePartyCreateRole,
): VoicePartyCreateRole | 'capital' | null {
  const text = String(answer || '').trim().toLowerCase();
  if (!text) return null;
  if (/\b(supplier|vendor|creditor)\b/.test(text)) return 'supplier';
  if (/\b(customer|client|debtor)\b/.test(text)) return 'customer';
  if (/\b(capital|partner|owner|investor)\b/.test(text)) return 'capital';
  if (suggested && /^(yes|y|ok|okay|create|new|do it|add it)$/i.test(text)) return suggested;
  return null;
}

export function commandWithCreatedParty(
  command: VoiceCommand,
  name: string,
  role: VoicePartyCreateRole,
): VoiceCommand {
  if (role === 'customer') {
    return {
      ...command,
      intent: command.intent === 'receipt' ? command.intent : 'receipt',
      customerName: name,
      supplierName: undefined,
      partnerName: undefined,
      pendingPartyCreate: { role, name },
    };
  }
  const intent = command.intent === 'bill' ? 'bill' : 'supplier_payment';
  return {
    ...command,
    intent,
    supplierName: name,
    customerName: undefined,
    partnerName: undefined,
    pendingPartyCreate: { role, name },
  };
}

export async function materializePendingVoiceParty(
  command: VoiceCommand,
  create: { supplier: (name: string) => Promise<unknown>; customer: (name: string) => Promise<unknown> },
): Promise<VoiceCommand> {
  const pending = command.pendingPartyCreate;
  if (!pending?.name) return command;
  if (pending.role === 'supplier') await create.supplier(pending.name);
  else await create.customer(pending.name);
  const next = { ...command };
  delete next.pendingPartyCreate;
  return next;
}

function unknownPartyQuestion(name: string, intent?: string, directory?: VoicePartyDirectory): VoicePartyResolution {
  const suggested = suggestedVoicePartyCreateRole(intent);
  const suggestions = directory ? suggestPartyNames(name, directory) : [];
  const recommended = suggested === 'customer'
    ? ' Create a Customer (recommended for this receipt) or a Supplier.'
    : suggested === 'supplier'
      ? ' Create a Supplier (recommended for this payment) or a Customer.'
      : ' Create a Supplier or Customer.';
  const didYouMean = suggestions.length ? ` Did you mean ${suggestions.join(' or ')}?` : '';
  return {
    ok: false,
    question: `No existing account named "${name}".${recommended}${didYouMean} Nothing is saved until you confirm the draft.`,
    createProposal: { name, suggestedRole: suggested, suggestions },
  };
}

function roleQuestion(name: string, roles: string[], intent?: string, directory?: VoicePartyDirectory): VoicePartyResolution {
  if (!roles.length) {
    if (intent === 'capital' || intent === 'drawing') {
      return { ok: false, question: `No Capital Account named "${name}" exists. Add it from Accounts, then try again.` };
    }
    return unknownPartyQuestion(name, intent, directory);
  }
  if (roles.length === 1 && roles[0] === 'Customer') {
    return { ok: false, question: `${name} is a Customer. Is this a refund, an expense, or another outgoing payment?` };
  }
  if (roles.length === 1 && roles[0] === 'Capital Account') {
    return { ok: false, question: `${name} is a Capital Account. Do you mean "withdraw capital from ${name}"?` };
  }
  return { ok: false, question: `${name} matches more than one role: ${roles.join(' and ')}. Say "pay supplier ${name}" or "withdraw capital from ${name}".` };
}

/**
 * Resolves money-movement party roles against existing app records before the
 * voice UI offers a confirmation. It never silently creates a party and never
 * guesses between Supplier, Customer, and Capital Account records that share a
 * name. A missing name can be created after the user names the role.
 */
export function resolveVoicePartyCommand(
  input: VoiceCommand,
  transcript: string,
  directory: VoicePartyDirectory,
): VoicePartyResolution {
  if (!['bill', 'supplier_payment', 'drawing', 'capital', 'receipt'].includes(String(input.intent || ''))) return { ok: true, command: { ...input } };

  const name = voiceCommandPartyName(input);
  if (!name && input.intent === 'receipt' && input.receiptMode === 'cash_sale') return { ok: true, command: { ...input } };
  if (!name) return { ok: false, question: 'Which Supplier, Customer, or Capital Account is this payment for?' };

  const suppliers = exact(directory.suppliers, name);
  const customers = exact(directory.customers, name);
  const capitalAccounts = exact(directory.capitalAccounts, name);
  const roles = [
    ...(suppliers.length ? ['Supplier'] : []),
    ...(customers.length ? ['Customer'] : []),
    ...(capitalAccounts.length ? ['Capital Account'] : []),
  ];
  const explicitlySupplier = /\b(supplier|vendor|creditor)\b/i.test(transcript);
  const explicitlyCustomer = /\b(customer|client|debtor)\b/i.test(transcript);
  const explicitlyCapital = /\b(capital|partner|owner|drawing|withdraw(?:al|n)?)\b/i.test(transcript);
  const soundsLikePayment = /\b(pay|paid|payment|settled?)\b/i.test(transcript);
  const soundsLikePurchase = /\b(bill|invoice|bought|buy|purchase[ds]?)\b/i.test(transcript);

  if (input.intent === 'capital') {
    const capital = one(capitalAccounts);
    return capital
      ? { ok: true, command: { ...input, intent: 'capital', partnerName: capital.name, supplierName: undefined, customerName: undefined, summary: `Add ${Number(input.amount || 0)} capital for ${capital.name}` } }
      : roleQuestion(name, roles, 'capital', directory);
  }

  if (input.intent === 'receipt') {
    const customer = one(customers);
    if (customer && (explicitlyCustomer || (suppliers.length === 0 && capitalAccounts.length === 0))) {
      return { ok: true, command: { ...input, customerName: customer.name, supplierName: undefined, partnerName: undefined } };
    }
    if (explicitlyCustomer && !roles.length) {
      return { ok: true, command: commandWithCreatedParty(input, name, 'customer') };
    }
    return roleQuestion(name, roles, input.intent, directory);
  }

  if (input.intent === 'bill' && !(soundsLikePayment && !soundsLikePurchase)) {
    const supplier = one(suppliers);
    if (supplier && (explicitlySupplier || (customers.length === 0 && capitalAccounts.length === 0))) {
      return { ok: true, command: { ...input, supplierName: supplier.name, customerName: undefined, partnerName: undefined } };
    }
    if (explicitlySupplier && !roles.length) {
      return { ok: true, command: commandWithCreatedParty(input, name, 'supplier') };
    }
    return roleQuestion(name, roles, input.intent, directory);
  }

  if (explicitlySupplier && explicitlyCapital) return roleQuestion(name, roles, input.intent, directory);

  if (explicitlySupplier) {
    const supplier = one(suppliers);
    if (supplier) {
      return { ok: true, command: { ...input, intent: 'supplier_payment', supplierName: supplier.name, customerName: undefined, partnerName: undefined } };
    }
    if (!roles.length) return { ok: true, command: commandWithCreatedParty({ ...input, intent: 'supplier_payment' }, name, 'supplier') };
    return roleQuestion(name, roles, 'supplier_payment', directory);
  }

  if (explicitlyCustomer && !roles.length) {
    return { ok: true, command: commandWithCreatedParty({ ...input, intent: 'receipt' }, name, 'customer') };
  }

  if (explicitlyCapital || input.intent === 'drawing') {
    const capital = one(capitalAccounts) || (capitalAccounts.length === 0 ? one(prefixOrWordMatch(directory.capitalAccounts, name)) : null);
    return capital
      ? { ok: true, command: { ...input, intent: 'drawing', partnerName: capital.name, supplierName: undefined, customerName: undefined, summary: `Withdraw ${Number(input.amount || 0)} from ${capital.name} Capital Account` } }
      : roleQuestion(name, roles, 'drawing', directory);
  }

  const supplier = one(suppliers);
  if (supplier && customers.length === 0 && capitalAccounts.length === 0) {
    return { ok: true, command: { ...input, intent: 'supplier_payment', supplierName: supplier.name, customerName: undefined, partnerName: undefined } };
  }
  const capital = one(capitalAccounts) || (capitalAccounts.length === 0 && suppliers.length === 0 && customers.length === 0 ? one(prefixOrWordMatch(directory.capitalAccounts, name)) : null);
  if (capital && suppliers.length === 0 && customers.length === 0) {
    return { ok: true, command: { ...input, intent: 'drawing', partnerName: capital.name, supplierName: undefined, customerName: undefined, summary: `Withdraw ${Number(input.amount || 0)} from ${capital.name} Capital Account` } };
  }
  return roleQuestion(name, roles, String(input.intent || 'supplier_payment'), directory);
}
