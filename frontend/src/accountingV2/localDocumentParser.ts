import { mapAnalyzedDocument, normalizeScanDate, type MappedDocument, type ScanPaymentMethod } from './scanImport';

export type LocalDocumentParty = { id: string; name: string };
export type LocalDocumentDirectory = {
  suppliers?: LocalDocumentParty[];
  customers?: LocalDocumentParty[];
  capitalAccounts?: LocalDocumentParty[];
};

export type LocalAnalyzedDocument = {
  docType: 'receipt' | 'statement' | 'closing_report' | 'transaction_list' | 'other';
  summary: string;
  entries: {
    type: 'sale' | 'purchase_bill' | 'receipt_in' | 'payment_out' | 'expense' | 'capital_contribution';
    date?: string;
    partyName?: string;
    amount: number;
    method?: ScanPaymentMethod;
    notes?: string;
  }[];
  setup?: {
    asOfDate?: string;
    openingCash?: number;
    stockValue?: number;
    extraAssets?: { name: string; amount: number }[];
    extraLiabilities?: { name: string; amount: number }[];
    creditorsTotal?: number;
    partners?: { name: string; capital: number; profitSharePct?: number }[];
  };
};

export type LocalDocumentOutcome =
  | { status: 'confident'; confidence: number; source: 'local-ocr-rules'; document: LocalAnalyzedDocument; mapped: MappedDocument }
  | {
      status: 'clarification'; confidence: number; source: 'local-ocr-rules'; field: 'date' | 'amount' | 'document_type' | 'party';
      question: string; document?: LocalAnalyzedDocument; mapped?: MappedDocument; candidates?: number[];
    }
  | { status: 'unsupported'; confidence: 0; source: 'local-ocr-rules'; reason: string };

export type LocalDocumentOptions = { directory?: LocalDocumentDirectory };

const MONEY_TOKEN = /(?:[$€£₹]\s*)?(-?\d[\d,]*(?:\.\d{1,2})?)\s*(?:[$€£₹]|\b(?:USD|CAD|EUR|GBP|INR)\b)?/gi;
const TOTAL_LABEL = /\b(grand\s+total|amount\s+due|balance\s+due|total\s+due|net\s+(?:total|payable)|total)\b/i;
const NON_FINAL_TOTAL = /\b(sub\s*total|tax|gst|vat|discount|change|tender(?:ed)?|cash\s+(?:received|paid))\b/i;
const NOISE_LINE = /^(?:tax\s+invoice|invoice|receipt|bill|original|duplicate|thank\s+you|tel(?:ephone)?|phone|email|www\.|date\b|time\b)/i;

function cleanLines(text: string): string[] {
  return text.replace(/\0/g, '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 500);
}

function amountTokens(line: string): number[] {
  const values: number[] = [];
  for (const match of line.matchAll(MONEY_TOKEN)) {
    const end = (match.index || 0) + match[0].length;
    if (line.slice(end).trimStart().startsWith('%')) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value >= 0) values.push(value);
  }
  return values;
}

function lastAmount(line: string): number | undefined {
  const values = amountTokens(line);
  return values.length ? values[values.length - 1] : undefined;
}

function uniqueMoney(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.round(value * 100) / 100))];
}

function extractDate(lines: string[]): string | undefined {
  for (const line of lines) {
    const matches = line.match(/\b(?:20\d{2}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]20\d{2})\b/g) || [];
    for (const candidate of matches) {
      const normalized = normalizeScanDate(candidate);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase().replace(/\b(?:limited|ltd|incorporated|inc|llc|store|shop)\b\.?/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function exactParty(name: string, rows: LocalDocumentParty[] | undefined): LocalDocumentParty | undefined {
  const key = normalizeName(name);
  if (!key) return undefined;
  const matches = (rows || []).filter((row) => normalizeName(row.name) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function findKnownParty(lines: string[], rows: LocalDocumentParty[] | undefined): LocalDocumentParty | undefined {
  const normalizedLines = lines.slice(0, 20).map(normalizeName);
  const matches = (rows || []).filter((row) => {
    const name = normalizeName(row.name);
    return name.length >= 3 && normalizedLines.some((line) => line === name || line.includes(name));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function merchantName(lines: string[]): string {
  for (const line of lines.slice(0, 12)) {
    if (line.length < 2 || line.length > 80 || NOISE_LINE.test(line) || TOTAL_LABEL.test(line) || NON_FINAL_TOTAL.test(line)) continue;
    if (!/[\p{L}]/u.test(line) || /\b\d{4}[\/.-]\d/.test(line) || /^#?\d+$/.test(line)) continue;
    return line.replace(/[|]+/g, ' ').trim();
  }
  return '';
}

function paymentMethod(text: string): ScanPaymentMethod | undefined {
  if (/\b(?:upi|mobile\s*(?:money|payment)|m-pesa|mpesa)\b/i.test(text)) return 'mobile';
  if (/\b(?:bank\s+transfer|wire|eft|neft|rtgs)\b/i.test(text)) return 'bank';
  if (/\b(?:visa|mastercard|debit\s+card|credit\s+card|card)\b/i.test(text)) return 'card';
  if (/\b(?:paid\s+cash|cash\s+payment|payment\s+method\s*:?\s*cash)\b/i.test(text)) return 'cash';
  if (/\b(?:on\s+credit|terms\s*:?\s*(?:net\s*)?\d+|amount\s+due|balance\s+due)\b/i.test(text)) return 'credit';
  return undefined;
}

function invoiceReference(text: string): string {
  return (text.match(/\b(?:invoice|receipt|reference|ref)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,30})/i)?.[1] || '').trim();
}

function totalCandidates(lines: string[]): { values: number[]; explicit: boolean } {
  const strong: number[] = [];
  const plain: number[] = [];
  for (const line of lines) {
    if (!TOTAL_LABEL.test(line) || NON_FINAL_TOTAL.test(line)) continue;
    const amount = lastAmount(line);
    if (amount === undefined) continue;
    if (/\b(grand\s+total|amount\s+due|balance\s+due|total\s+due|net\s+(?:total|payable))\b/i.test(line)) strong.push(amount);
    else plain.push(amount);
  }
  const preferred = uniqueMoney(strong.length ? strong : plain);
  return { values: preferred, explicit: preferred.length > 0 };
}

function labeledAmount(lines: string[], pattern: RegExp): number | undefined {
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    const amount = lastAmount(line);
    if (amount !== undefined) return amount;
  }
  return undefined;
}

function openingBalanceAmount(lines: string[], pattern: RegExp, authoritative: RegExp): number | undefined {
  const authoritativeValue = labeledAmount(lines, authoritative);
  if (authoritativeValue !== undefined) return authoritativeValue;
  const values = lines.filter((line) => pattern.test(line)).map(lastAmount).filter((value): value is number => value !== undefined);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100 : undefined;
}

function lineNameBeforeAmount(line: string): string {
  return line.replace(MONEY_TOKEN, ' ').replace(/[:|.-]+$/g, '').replace(/\s+/g, ' ').trim();
}

function parseOpeningDocument(lines: string[], text: string): LocalDocumentOutcome | null {
  const balanceSignal = /\b(?:balance\s+sheet|trial\s+balance|closing\s+report|opening\s+balances?|net\s+worth|partner\s+stakes?)\b/i.test(text);
  const labeled = lines.filter((line) => /\b(?:cash|stock|inventory|asset|equipment|deposit|creditors?|accounts?\s+payable|liabilit|loan|capital|partner\s+stake)\b/i.test(line) && lastAmount(line) !== undefined);
  if (!balanceSignal && labeled.length < 3) return null;

  const setup: NonNullable<LocalAnalyzedDocument['setup']> = {};
  const date = extractDate(lines);
  if (date) setup.asOfDate = date;
  setup.openingCash = openingBalanceAmount(lines, /\bcash\b/i, /\b(?:opening\s+cash|cash\s+balance|total\s+cash)\b/i);
  setup.stockValue = openingBalanceAmount(lines, /\b(?:stock|inventory)\b/i, /\b(?:stock|inventory)\s+(?:value|balance|total)\b/i);
  setup.creditorsTotal = labeledAmount(lines, /\b(?:creditors?|accounts?\s+payable)\b/i);
  setup.extraAssets = [];
  setup.extraLiabilities = [];
  setup.partners = [];

  for (const line of labeled) {
    const amount = lastAmount(line);
    if (amount === undefined) continue;
    const name = lineNameBeforeAmount(line);
    if (/\btotal\s+(?:assets?|liabilit(?:y|ies)|capital|equity)\b/i.test(line)) continue;
    if (/\b(?:cash|stock|inventory|creditors?|accounts?\s+payable)\b/i.test(line)) continue;
    if (/\b(?:capital|partner\s+stake)\b/i.test(line)) {
      const partnerName = line.replace(/\b\d{1,3}(?:\.\d+)?\s*%/g, ' ').replace(MONEY_TOKEN, ' ')
        .replace(/\b(?:capital(?:\s+account)?|partner\s+stake|opening|closing|balance)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      if (partnerName) {
        const pct = Number(line.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/)?.[1]);
        setup.partners.push({ name: partnerName, capital: amount, ...(Number.isFinite(pct) && pct <= 100 ? { profitSharePct: pct } : {}) });
      }
    } else if (/\b(?:liabilit|loan|payable|accrued)\b/i.test(line)) setup.extraLiabilities.push({ name, amount });
    else if (/\b(?:asset|equipment|deposit|receivable|prepaid|vehicle|property)\b/i.test(line)) setup.extraAssets.push({ name, amount });
  }

  // Partner reports often place the word "Capital" in the column header and
  // show rows as just "Amit 68935.48 50%". Accept only rows with an explicit
  // percentage and a balance-report signal; this avoids treating receipt lines
  // as partner capital.
  for (const line of lines) {
    const pctMatch = line.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/);
    const amount = lastAmount(line);
    if (!pctMatch || amount === undefined || /\b(?:total|capital|stake|share)\b/i.test(line)) continue;
    const name = line.replace(/\b\d{1,3}(?:\.\d+)?\s*%/g, ' ').replace(MONEY_TOKEN, ' ').replace(/[:|.-]+$/g, '').replace(/\s+/g, ' ').trim();
    const pct = Number(pctMatch[1]);
    if (name && /[\p{L}]/u.test(name) && pct >= 0 && pct <= 100 && !setup.partners.some((row) => normalizeName(row.name) === normalizeName(name))) {
      setup.partners.push({ name, capital: amount, profitSharePct: pct });
    }
  }

  if (setup.openingCash === undefined && setup.stockValue === undefined && !setup.extraAssets.length && !setup.extraLiabilities.length && !setup.partners.length) return null;
  const document: LocalAnalyzedDocument = { docType: 'closing_report', summary: 'Locally extracted opening or closing balances for review.', entries: [], setup };
  const mapped = mapAnalyzedDocument(document);
  if (!date) return { status: 'clarification', confidence: 0.72, source: 'local-ocr-rules', field: 'date', question: 'What statement date is printed on this opening or closing report?', document, mapped };
  return { status: 'confident', confidence: 0.88, source: 'local-ocr-rules', document, mapped };
}

/**
 * Converts untrusted OCR or pasted text into the existing scan mapper contract.
 * It performs no writes. Even a confident result must continue through
 * mapAnalyzedDocument, the editable review screen, and explicit confirmation.
 */
export function interpretLocalDocumentText(text: string, options: LocalDocumentOptions = {}): LocalDocumentOutcome {
  const clipped = String(text || '').trim().slice(0, 20_000);
  if (clipped.length < 8) return { status: 'unsupported', confidence: 0, source: 'local-ocr-rules', reason: 'Local OCR did not return enough readable text.' };
  const lines = cleanLines(clipped);
  const opening = parseOpeningDocument(lines, clipped);
  if (opening) return opening;

  if (/\b(?:capital\s+(?:contribution|deposit|injection)|owner\s+investment)\b/i.test(clipped)) {
    const capitalAccount = findKnownParty(lines, options.directory?.capitalAccounts);
    const capitalAmounts = uniqueMoney(lines
      .filter((line) => /\b(?:capital\s+(?:contribution|deposit|injection)|owner\s+investment)\b/i.test(line))
      .map((line) => lastAmount(line)).filter((value): value is number => value !== undefined && value > 0));
    if (capitalAmounts.length !== 1) {
      return { status: 'clarification', confidence: 0.5, source: 'local-ocr-rules', field: 'amount', question: 'Which amount is the explicit capital contribution?', candidates: capitalAmounts };
    }
    if (!capitalAccount) {
      return { status: 'clarification', confidence: 0.6, source: 'local-ocr-rules', field: 'party', question: 'Which existing Capital Account made this contribution?' };
    }
    const date = extractDate(lines);
    const document: LocalAnalyzedDocument = {
      docType: 'receipt',
      summary: `Locally extracted capital contribution for ${capitalAccount.name}.`,
      entries: [{ type: 'capital_contribution', ...(date ? { date } : {}), partyName: capitalAccount.name, amount: capitalAmounts[0], method: paymentMethod(clipped) || 'cash', notes: 'Explicit capital contribution extracted locally; verify before import.' }],
    };
    const mapped = mapAnalyzedDocument(document);
    if (!date) return { status: 'clarification', confidence: 0.75, source: 'local-ocr-rules', field: 'date', question: 'What date is printed for this capital contribution?', document, mapped };
    return { status: 'confident', confidence: 0.94, source: 'local-ocr-rules', document, mapped };
  }

  const totals = totalCandidates(lines);
  if (!totals.explicit) {
    return { status: 'clarification', confidence: 0.35, source: 'local-ocr-rules', field: 'amount', question: 'I could not identify a labelled final total. Enter the amount shown as Grand Total or Amount Due.' };
  }
  if (totals.values.length !== 1) {
    return { status: 'clarification', confidence: 0.5, source: 'local-ocr-rules', field: 'amount', question: 'More than one possible final total was found. Which amount should be used?', candidates: totals.values };
  }

  const amount = totals.values[0];
  if (!(amount > 0)) return { status: 'unsupported', confidence: 0, source: 'local-ocr-rules', reason: 'The detected final total is not a positive transaction amount.' };
  const date = extractDate(lines);
  const method = paymentMethod(clipped);
  const header = merchantName(lines);
  const supplier = findKnownParty(lines, options.directory?.suppliers) || exactParty(header, options.directory?.suppliers);
  const customer = findKnownParty(lines, options.directory?.customers) || exactParty(header, options.directory?.customers);
  const reference = invoiceReference(clipped);
  const notes = `${reference ? `Reference ${reference}. ` : ''}Locally extracted from OCR; verify the total and party before import.`;
  const isInvoice = /\b(?:tax\s+invoice|invoice|bill\s+to|amount\s+due|payment\s+terms)\b/i.test(clipped);
  const isPaid = /\b(?:paid|payment\s+(?:received|approved|successful)|balance\s*:?\s*0(?:\.00)?)\b/i.test(clipped) || (method !== undefined && method !== 'credit');
  const isIncoming = /\b(?:payment\s+received|received\s+from|customer\s+receipt)\b/i.test(clipped);
  const incomingName = (clipped.match(/\breceived\s+from\s*[:#-]?\s*([^\r\n]{2,100})/i)?.[1] || '')
    .replace(MONEY_TOKEN, ' ').replace(/\s+/g, ' ').trim();

  let type: LocalAnalyzedDocument['entries'][number]['type'];
  const partyName = supplier?.name || customer?.name || incomingName || header;
  if (isIncoming && customer) type = 'receipt_in';
  else if (isIncoming && !supplier) type = 'receipt_in';
  else if (isInvoice) type = supplier || !customer ? 'purchase_bill' : 'sale';
  else type = supplier || !customer ? 'expense' : 'sale';

  const resolvedMethod: ScanPaymentMethod = type === 'purchase_bill' && !isPaid ? 'credit' : (method || 'cash');
  const document: LocalAnalyzedDocument = {
    docType: 'receipt',
    summary: `Locally extracted ${type.replace(/_/g, ' ')}${partyName ? ` for ${partyName}` : ''}.`,
    entries: [{ type, ...(date ? { date } : {}), ...(partyName ? { partyName } : {}), amount, method: resolvedMethod, notes }],
  };
  const mapped = mapAnalyzedDocument(document);

  if (!date) return { status: 'clarification', confidence: 0.7, source: 'local-ocr-rules', field: 'date', question: 'What transaction date is printed on this document?', document, mapped };
  if (isIncoming && !customer) {
    return { status: 'clarification', confidence: 0.66, source: 'local-ocr-rules', field: 'party', question: `Which existing Customer does "${partyName || 'this payment'}" belong to?`, document, mapped };
  }
  if (isInvoice && !supplier && !customer) {
    return { status: 'clarification', confidence: 0.68, source: 'local-ocr-rules', field: 'party', question: `Is "${partyName || 'the document issuer'}" a Supplier or Customer?`, document, mapped };
  }
  return { status: 'confident', confidence: supplier || customer ? 0.91 : 0.84, source: 'local-ocr-rules', document, mapped };
}
