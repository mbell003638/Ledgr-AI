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
const TOTAL_LABEL = /\b(grand\s+total|amount\s+due|balance\s+due|total\s+due|net\s+(?:total|payable)|total(?!\s+(?:assets?|liabilit|equity|capital)))\b/i;
const NON_FINAL_TOTAL = /\b(sub\s*total|tax|gst|vat|discount|change|tender(?:ed)?|cash\s+(?:received|paid)|net\s+profit|profit\s+before|profit\s+share)\b/i;
const NOISE_LINE = /^(?:tax\s+invoice|invoice|receipt|bill|original|duplicate|thank\s+you|tel(?:ephone)?|phone|email|www\.|date\b|time\b)/i;
const STATEMENT_HEADER_NOISE = /\b(?:net\s+profit|profit\s+share|profit\s+before|each\s+partner|commission|assets?|liabilities?|drawings?|partner\s+stakes?|capital\s+accounts?\s+reconciliation|total)\b/i;
const POSITION_HEADER = /\b(?:balance\s+sheet|trial\s+balance|closing\s+report|opening\s+balances?|net\s+worth|partner\s+stakes?|capital\s+accounts?\s+reconciliation|drawings?\s+this\s+period|capital\s+withdrawals?\s+this\s+period|each\s+partner(?:'s)?\s+share)\b/i;

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

function isAmountOnlyLine(line: string): boolean {
  const trimmed = line.replace(/^[+\-−]\s*/, '').trim();
  if (!trimmed) return false;
  const values = amountTokens(trimmed);
  if (values.length !== 1) return false;
  if (Number.isInteger(values[0]) && values[0] >= 1900 && values[0] <= 2100) return false;
  return trimmed.replace(/(?:[$€£₹]\s*)?(-?\d[\d,]*(?:\.\d{1,2})?)\s*(?:[$€£₹]|\b(?:USD|CAD|EUR|GBP|INR)\b)?/gi, ' ').replace(/\s+/g, ' ').trim().length === 0;
}

function pairLabelledAmountLines(lines: string[]): string[] {
  const paired: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (lastAmount(line) === undefined && next && isAmountOnlyLine(next)) {
      paired.push(`${line} ${next}`);
      index += 1;
      continue;
    }
    paired.push(line);
  }
  return paired;
}

const PACKED_AMOUNT = /[+\-−]?[$€£₹]?\s*\d{1,3}(?:,\d{3})+(?:\.\d{2})?|[+\-−]?[$€£₹]?\s*\d+\.\d{2}|[+\-−]?[$€£₹]\s*\d+(?:\.\d{2})?/;

/** ML Kit often dumps several label/amount rows onto one line. */
function unpackPackedAmountLines(lines: string[]): string[] {
  const unpacked: string[] = [];
  for (const line of lines) {
    const pair = new RegExp(
      `([A-Za-z][A-Za-z0-9 &'./()%-]{0,80}?)\\s*(${PACKED_AMOUNT.source})(?:\\s*(?:USD|CAD|EUR|GBP|INR))?`,
      'g',
    );
    const matches = [...line.matchAll(pair)];
    if (matches.length >= 2) {
      unpacked.push(...matches.map((match) => match[0].replace(/\s+/g, ' ').trim()));
      continue;
    }
    unpacked.push(line);
  }
  return unpacked;
}

function applyVisiblePartnerSplit(partners: NonNullable<LocalAnalyzedDocument['setup']>['partners'], lines: string[]): void {
  if (!partners?.length || partners.some((row) => row.profitSharePct != null)) return;
  const match = lines.join(' ').match(/\((\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{1,2}))?\)/);
  if (!match) return;
  const parts = [match[1], match[2], match[3]].filter(Boolean).map(Number);
  if (parts.length !== partners.length) return;
  if (parts.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)) return;
  if (Math.abs(parts.reduce((sum, value) => sum + value, 0) - 100) > 0.5) return;
  partners.forEach((partner, index) => { partner.profitSharePct = parts[index]; });
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
    if (line.length < 2 || line.length > 80 || NOISE_LINE.test(line) || TOTAL_LABEL.test(line) || NON_FINAL_TOTAL.test(line) || STATEMENT_HEADER_NOISE.test(line)) continue;
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

function totalCandidates(lines: string[]): { values: number[]; explicit: boolean; inferred: boolean } {
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
  if (preferred.length) return { values: preferred, explicit: true, inferred: false };

  const inferred: number[] = [];
  for (const line of lines) {
    if (NON_FINAL_TOTAL.test(line)) continue;
    if (/\b(?:qty|quantity|items?|rate)\b/i.test(line)) continue;
    if (/\b(?:20\d{2}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]20\d{2}|date)\b/i.test(line)) continue;
    const amount = lastAmount(line);
    if (amount === undefined || amount <= 0) continue;
    if (Number.isInteger(amount) && amount >= 1900 && amount <= 2100) continue;
    inferred.push(amount);
  }
  const uniqueInferred = uniqueMoney(inferred);
  if (uniqueInferred.length === 1) return { values: uniqueInferred, explicit: true, inferred: true };
  if (uniqueInferred.length > 1) return { values: [Math.max(...uniqueInferred)], explicit: true, inferred: true };
  return { values: [], explicit: false, inferred: false };
}

function labeledAmount(lines: string[], pattern: RegExp): number | undefined {
  for (const line of lines) {
    if (!pattern.test(line)) continue;
    const amount = lastAmount(line);
    if (amount !== undefined) return amount;
  }
  return undefined;
}

function lineNameBeforeAmount(line: string): string {
  return line.replace(MONEY_TOKEN, ' ').replace(/[:|.-]+$/g, '')
    .replace(/^(?:assets?|liabilities?|equity|capital|drawings?(?:\s+this\s+period)?)\s+/i, '')
    .replace(/\s+/g, ' ').trim();
}

function parseOpeningDocument(lines: string[], text: string): LocalDocumentOutcome | null {
  const balanceSignal = POSITION_HEADER.test(text)
    || (lines.some((line) => /^assets$/i.test(line)) && lines.some((line) => /^liabilities$/i.test(line)))
    || (/\bnet\s+profit\b/i.test(text) && /\b(?:total\s+assets|physical\s+stock|creditors?)\b/i.test(text));
  const labeled = lines.filter((line) => /\b(?:cash|stock|inventory|asset|equipment|deposit|creditors?|accounts?\s+payable|liabilit|loan|payable|capital|stake)\b/i.test(line) && lastAmount(line) !== undefined);
  if (!balanceSignal && labeled.length < 3) return null;

  const setup: NonNullable<LocalAnalyzedDocument['setup']> = {};
  const date = extractDate(lines);
  if (date) setup.asOfDate = date;
  setup.creditorsTotal = labeledAmount(lines, /\b(?:creditors?|accounts?\s+payable)\b/i);
  setup.extraAssets = [];
  setup.extraLiabilities = [];
  setup.partners = [];

  for (const line of labeled) {
    const amount = lastAmount(line);
    if (amount === undefined || amount <= 0) continue;
    const name = lineNameBeforeAmount(line);
    if (/\btotal\s+(?:assets?|liabilit(?:y|ies)|capital|equity)\b/i.test(line)) continue;
    if (/\b(?:net\s+profit|profit\s+before|profit\s+share|each\s+partner|drawings?\s+this\s+period|capital\s+withdrawn)\b/i.test(line)) continue;
    if (/^\s*commission\b/i.test(line) && !/\bpayable\b/i.test(line)) continue;
    if (/\b(?:creditors?|accounts?\s+payable)\b/i.test(line)) continue;
    if (/\bcash\b/i.test(line) || /\b(?:stock|inventory)\b/i.test(line)) {
      setup.extraAssets.push({ name, amount });
      continue;
    }
    if (/\b(?:capital|stake)\b/i.test(line)) {
      if (/\b(?:opening(?:\s+stake)?|profit\s+share|drawings?)\b/i.test(line) && !/\b(?:ending|closing)\b/i.test(line)) continue;
      const partnerName = line.replace(/\b\d{1,3}(?:\.\d+)?\s*%/g, ' ').replace(MONEY_TOKEN, ' ')
        .replace(/\b(?:capital(?:\s+account)?|partner\s+stakes?|ending|opening|closing|balance|stake)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      if (partnerName && !/^(?:owner|total|partner)$/i.test(partnerName)) {
        const pct = Number(line.match(/\b(\d{1,3}(?:\.\d+)?)\s*%/)?.[1]);
        const existing = setup.partners.find((row) => normalizeName(row.name) === normalizeName(partnerName));
        if (existing) existing.capital = amount;
        else setup.partners.push({ name: partnerName, capital: amount, ...(Number.isFinite(pct) && pct <= 100 ? { profitSharePct: pct } : {}) });
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
    if (!pctMatch || amount === undefined || /\b(?:total|capital|stake|share|commission|payable|profit|drawings?)\b/i.test(line)) continue;
    const name = line.replace(/\b\d{1,3}(?:\.\d+)?\s*%/g, ' ').replace(MONEY_TOKEN, ' ').replace(/[:|.-]+$/g, '').replace(/\s+/g, ' ').trim();
    const pct = Number(pctMatch[1]);
    if (name && /[\p{L}]/u.test(name) && pct >= 0 && pct <= 100 && !setup.partners.some((row) => normalizeName(row.name) === normalizeName(name))) {
      setup.partners.push({ name, capital: amount, profitSharePct: pct });
    }
  }

  applyVisiblePartnerSplit(setup.partners, lines);
  if (!setup.extraAssets.length && !setup.extraLiabilities.length && !setup.partners.length && setup.creditorsTotal === undefined) return null;
  const document: LocalAnalyzedDocument = { docType: 'closing_report', summary: 'Locally extracted labelled balances for review. Totals such as Net Profit and Total Assets are not imported as extra rows.', entries: [], setup };
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
  const lines = pairLabelledAmountLines(unpackPackedAmountLines(cleanLines(clipped)));
  const opening = parseOpeningDocument(lines, lines.join('\n'));
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
  const date = extractDate(lines);
  const method = paymentMethod(clipped);
  const header = merchantName(lines);
  if (!totals.explicit) {
    return {
      status: 'clarification',
      confidence: 0.35,
      source: 'local-ocr-rules',
      field: 'amount',
      question: 'I could not find a total on this document. Enter the amount to record. Scan & Import can still create the supplier or customer when you confirm.',
    };
  }
  if (totals.values.length !== 1) {
    return { status: 'clarification', confidence: 0.5, source: 'local-ocr-rules', field: 'amount', question: 'More than one possible final total was found. Which amount should be used?', candidates: totals.values };
  }

  const amount = totals.values[0];
  if (!(amount > 0)) return { status: 'unsupported', confidence: 0, source: 'local-ocr-rules', reason: 'The detected final total is not a positive transaction amount.' };
  const supplier = findKnownParty(lines, options.directory?.suppliers) || exactParty(header, options.directory?.suppliers);
  const customer = findKnownParty(lines, options.directory?.customers) || exactParty(header, options.directory?.customers);
  const reference = invoiceReference(clipped);
  const notes = [
    reference ? `Reference ${reference}.` : '',
    totals.inferred ? 'Amount inferred from visible figures; confirm before import.' : 'Locally extracted from OCR; verify the total and party before import.',
  ].filter(Boolean).join(' ');
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
    summary: `Locally extracted ${type.replace(/_/g, ' ')}${partyName ? ` for ${partyName}` : ''}${totals.inferred ? '. Confirm the inferred total before import' : ''}.`,
    entries: [{ type, ...(date ? { date } : {}), ...(partyName ? { partyName } : {}), amount, method: resolvedMethod, notes }],
  };
  const mapped = mapAnalyzedDocument(document);

  if (!date) return { status: 'clarification', confidence: 0.7, source: 'local-ocr-rules', field: 'date', question: 'What transaction date is printed on this document?', document, mapped };
  return { status: 'confident', confidence: supplier || customer ? 0.91 : totals.inferred ? 0.72 : 0.84, source: 'local-ocr-rules', document, mapped };
}
