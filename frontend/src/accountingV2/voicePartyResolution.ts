type NamedAccount = { id: string; name: string };

export type VoicePartyDirectory = {
  suppliers: NamedAccount[];
  customers: NamedAccount[];
  capitalAccounts: NamedAccount[];
};

export type VoiceCommand = Record<string, unknown> & {
  intent?: string;
  amount?: number;
  date?: string;
  method?: string;
  paymentType?: 'cash' | 'credit';
  receiptMode?: 'cash_sale' | 'against_invoice' | 'advance';
  category?: string;
  notes?: string;
  supplierName?: string;
  customerName?: string;
  partnerName?: string;
  summary?: string;
};

export type VoicePartyResolution =
  | { ok: true; command: VoiceCommand }
  | { ok: false; question: string };

const normalized = (value: unknown) => String(value || '').trim().toLocaleLowerCase();
const exact = (rows: NamedAccount[], name: string) => rows.filter((row) => normalized(row.name) === normalized(name));
const one = (rows: NamedAccount[]) => rows.length === 1 ? rows[0] : null;

/**
 * Parse the common "paid AMOUNT ... to NAME" shape locally. This deliberately
 * handles only a narrow, high-confidence form: broader language still goes to
 * the configured AI provider. Keeping party resolution local means summary
 * mode does not have to disclose account names just to identify an exact
 * Supplier or Capital Account.
 */
export function parseSimpleOutgoingPayment(transcript: string): VoiceCommand | null {
  const match = transcript.match(/\b(?:pay|paid|paying|send|sent|gave|transfer|transferred)\b([\s\S]*?)\bto\b\s+([\s\S]+)$/i);
  if (!match) return null;

  // Explicit non-today dates need the provider's date parser; never silently
  // turn them into today's date.
  if (/\b(?:yesterday|tomorrow)\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\bon\s+\d{1,2}[\/-]\d{1,2}/i.test(transcript)) return null;

  const amountMatch = match[1].match(/(?:[$€£₹]\s*)?(\d[\d,]*(?:\.\d+)?)\s*(?:[$€£₹]|(?:USD|CAD|EUR|GBP|INR)\b)?/i);
  if (!amountMatch) return null;
  const amount = Number(amountMatch[1].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const name = match[2]
    .replace(/\s+(?:today|now)\s*$/i, '')
    .replace(/\s+(?:via|using|by|from)\s+(?:cash|bank(?:\s+transfer)?|card|mobile|upi)\b[\s\S]*$/i, '')
    .replace(/\s+(?:as|for)\s+(?:a\s+)?(?:supplier\s+payment|capital\s+(?:account|withdrawal)|drawing)\b[\s\S]*$/i, '')
    .replace(/^\s*(?:supplier|vendor|capital\s+account)\s+/i, '')
    .replace(/[.,!?;:]+\s*$/, '')
    .trim();
  if (!name || name.length > 160) return null;

  const method = /\bupi\b/i.test(transcript) ? 'upi'
    : /\bmobile\b/i.test(transcript) ? 'mobile'
    : /\bcard\b/i.test(transcript) ? 'card'
    : /\bbank(?:\s+transfer)?\b/i.test(transcript) ? 'bank'
    : /\bcash\b/i.test(transcript) ? 'cash'
    : undefined;

  return {
    intent: 'supplier_payment',
    amount,
    supplierName: name,
    ...(method ? { method } : {}),
    summary: `Pay ${amount} to ${name}`,
  };
}

function spokenName(command: VoiceCommand): string {
  return String(command.supplierName || command.customerName || command.partnerName || '').trim();
}

function roleQuestion(name: string, roles: string[]): VoicePartyResolution {
  if (!roles.length) {
    return { ok: false, question: `I could not find an existing Supplier, Customer, or Capital Account named "${name}". Add the correct account first, then try again.` };
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
 * voice UI offers a confirmation. It never creates a party and never guesses
 * between Supplier, Customer, and Capital Account records that share a name.
 */
export function resolveVoicePartyCommand(
  input: VoiceCommand,
  transcript: string,
  directory: VoicePartyDirectory,
): VoicePartyResolution {
  if (!['bill', 'supplier_payment', 'drawing', 'receipt', 'capital'].includes(String(input.intent || ''))) return { ok: true, command: { ...input } };

  const name = spokenName(input);
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
    return capital && (explicitlyCapital || (suppliers.length === 0 && customers.length === 0))
      ? { ok: true, command: { ...input, intent: 'capital', partnerName: capital.name, supplierName: undefined, customerName: undefined } }
      : roleQuestion(name, roles);
  }

  if (input.intent === 'receipt') {
    const customer = one(customers);
    if (customer && (explicitlyCustomer || (suppliers.length === 0 && capitalAccounts.length === 0))) {
      return { ok: true, command: { ...input, customerName: customer.name, supplierName: undefined, partnerName: undefined } };
    }
    return roleQuestion(name, roles);
  }

  if (input.intent === 'bill' && !(soundsLikePayment && !soundsLikePurchase)) {
    const supplier = one(suppliers);
    if (supplier && (explicitlySupplier || (customers.length === 0 && capitalAccounts.length === 0))) {
      return { ok: true, command: { ...input, supplierName: supplier.name, customerName: undefined, partnerName: undefined } };
    }
    return roleQuestion(name, roles);
  }

  if (explicitlySupplier && explicitlyCapital) return roleQuestion(name, roles);

  if (explicitlySupplier) {
    const supplier = one(suppliers);
    return supplier
      ? { ok: true, command: { ...input, intent: 'supplier_payment', supplierName: supplier.name, customerName: undefined, partnerName: undefined } }
      : roleQuestion(name, roles);
  }

  if (explicitlyCapital || input.intent === 'drawing') {
    const capital = one(capitalAccounts);
    return capital
      ? { ok: true, command: { ...input, intent: 'drawing', partnerName: capital.name, supplierName: undefined, customerName: undefined, summary: `Withdraw ${Number(input.amount || 0)} from ${capital.name} Capital Account` } }
      : roleQuestion(name, roles);
  }

  const supplier = one(suppliers);
  if (supplier && customers.length === 0 && capitalAccounts.length === 0) {
    return { ok: true, command: { ...input, intent: 'supplier_payment', supplierName: supplier.name, customerName: undefined, partnerName: undefined } };
  }
  const capital = one(capitalAccounts);
  if (capital && suppliers.length === 0 && customers.length === 0) {
    return { ok: true, command: { ...input, intent: 'drawing', partnerName: capital.name, supplierName: undefined, customerName: undefined, summary: `Withdraw ${Number(input.amount || 0)} from ${capital.name} Capital Account` } };
  }
  return roleQuestion(name, roles);
}
