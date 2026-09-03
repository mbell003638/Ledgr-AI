import { isValidDateString, normalizeDateInput } from '../utils/dateValidation';
import { MAX_AI_AMOUNT } from './aiActions';
import type { ScanEntryType, ScanPaymentMethod } from './scanImport';

export type LocalDocumentType = 'receipt' | 'statement' | 'closing_report' | 'transaction_list' | 'other';
export type LocalDocumentClarificationField = 'documentType' | 'date' | 'amount' | 'party' | 'method' | 'openingBalance';

export type LocalDocumentEntry = {
  type: ScanEntryType;
  date?: string;
  partyName?: string;
  amount: number;
  method?: ScanPaymentMethod;
  notes?: string;
};

export type LocalDocumentSetup = {
  asOfDate?: string;
  openingCash?: number;
  stockValue?: number;
  extraAssets?: { name: string; amount: number }[];
  creditorsTotal?: number;
  extraLiabilities?: { name: string; amount: number }[];
  partners?: { name: string; capital: number; profitSharePct?: number }[];
};

/** Same raw contract accepted by mapAnalyzedDocument; this function never imports it. */
export type LocalDocumentAnalysis = {
  docType: LocalDocumentType;
  summary: string;
  entries: LocalDocumentEntry[];
  setup?: LocalDocumentSetup;
};

export type LocalDocumentEvidence = {
  dateCandidates: string[];
  amountCandidates: number[];
  partyCandidates: string[];
  selectedTotalLabel?: string;
  invoiceNumber?: string;
  subtotal?: number;
  tax?: number;
};

export type LocalDocumentParseResult =
  | { kind: 'confident'; confidence: 'high' | 'medium'; analysis: LocalDocumentAnalysis; evidence: LocalDocumentEvidence; sourceText: string }
  | { kind: 'clarification'; confidence: 'medium' | 'low'; analysis: LocalDocumentAnalysis; field: LocalDocumentClarificationField; question: string; candidates?: string[]; evidence: LocalDocumentEvidence; sourceText: string }
  | { kind: 'unsupported'; confidence: 'low'; reason: string; sourceText: string };

type NamedParty = { id?: string; name: string };
export type LocalDocumentParserOptions = {
  defaultCurrency?: string;
  knownSuppliers?: NamedParty[];
  knownCustomers?: NamedParty[];
  knownCapitalAccounts?: NamedParty[];
  /** Backward-compatible aliases for non-UI callers. */
  suppliers?: NamedParty[];
  customers?: NamedParty[];
  capitalAccounts?: NamedParty[];
};

type AmountCandidate = { amount: number; label: string; priority: number; line: string };

const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const unique = <T,>(rows: T[]) => [...new Set(rows)];
const validAmount = (amount: number) => Number.isFinite(amount) && amount > 0 && amount <= MAX_AI_AMOUNT;

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map(compact).filter(Boolean).slice(0, 500);
}

function numberFrom(value: string): number | undefined {
  let cleaned = value.replace(/[₹$€£]/g, '').replace(/\s/g, '');
  if (/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(cleaned)) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  else cleaned = cleaned.replace(/,/g, '');
  const amount = Number(cleaned);
  return validAmount(amount) ? cents(amount) : undefined;
}

function amountsOnLine(line: string): number[] {
  const values: number[] = [];
  const regex = /(?:[$€£₹]\s*)?\d[\d,.]*(?:\s*(?:USD|CAD|EUR|GBP|INR))?/gi;
  for (const match of line.matchAll(regex)) {
    const amount = numberFrom(match[0]);
    if (amount !== undefined) values.push(amount);
  }
  return values;
}

const STATEMENT_HEADER_NOISE = /\b(?:net\s+profit|profit\s+share|profit\s+before|each\s+partner|commission|assets?|liabilities?|drawings?|partner\s+stakes?|capital\s+accounts?\s+reconciliation|total)\b/i;
const POSITION_HEADER = /\b(?:opening\s+balance|closing\s+(?:report|balance)|trial\s+balance|balance\s+sheet|net\s+worth|statement\s+of\s+financial\s+position|partner\s+stakes?|capital\s+accounts?\s+reconciliation|drawings?\s+this\s+period|capital\s+withdrawals?\s+this\s+period|each\s+partner(?:'s)?\s+share)\b/i;
const POSITION_TOTAL = /\btotal\s+(?:assets?|liabilit(?:y|ies)|equity|capital)\b/i;
const PNL_OR_RECON_DETAIL = /\b(?:net\s+profit|profit\s+before\s+commission|profit\s+share|each\s+partner|drawings?\s+this\s+period|capital\s+withdrawn)\b/i;

/** OCR of label-left/amount-right rows often emits the figure on the next line. */
function isAmountOnlyLine(line: string): boolean {
  const trimmed = compact(line).replace(/^[+\-−]\s*/, '');
  if (!trimmed) return false;
  const amounts = amountsOnLine(trimmed);
  if (amounts.length !== 1) return false;
  if (Number.isInteger(amounts[0]) && amounts[0] >= 1900 && amounts[0] <= 2100) return false;
  return compact(trimmed.replace(/(?:[$€£₹]\s*)?\d[\d,.]*(?:\s*(?:USD|CAD|EUR|GBP|INR))?/gi, '')).length === 0;
}

function pairLabelledAmountLines(lines: string[]): string[] {
  const paired: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (!amountsOnLine(line).length && next && isAmountOnlyLine(next)) {
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
      unpacked.push(...matches.map((match) => compact(match[0])));
      continue;
    }
    unpacked.push(line);
  }
  return unpacked;
}

function looksLikePositionReport(lines: string[]): boolean {
  const text = lines.join('\n');
  const header = POSITION_HEADER.test(text)
    || (lines.some((line) => /^assets$/i.test(line)) && lines.some((line) => /^liabilities$/i.test(line)))
    || (/\bnet\s+profit\b/i.test(text) && /\b(?:total\s+assets|physical\s+stock|creditors?)\b/i.test(text));
  const balanceRows = lines.filter((line) =>
    /\b(?:cash(?:\s+in\s+hand)?|stock|inventory|creditors?|accounts?\s+payable|partner\s+capital|capital\s+account|ending\s+stake|deposit)\b/i.test(line)
    && amountsOnLine(line).length > 0
  ).length;
  return (header && balanceRows >= 1) || balanceRows >= 3;
}

function applyVisiblePartnerSplit(partners: NonNullable<LocalDocumentSetup['partners']>, lines: string[]): void {
  if (!partners.length || partners.some((row) => row.profitSharePct != null)) return;
  const match = lines.join(' ').match(/\((\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{1,2}))?\)/);
  if (!match) return;
  const parts = [match[1], match[2], match[3]].filter(Boolean).map(Number);
  if (parts.length !== partners.length) return;
  if (parts.some((value) => !Number.isFinite(value) || value <= 0 || value > 100)) return;
  if (Math.abs(parts.reduce((sum, value) => sum + value, 0) - 100) > 0.5) return;
  partners.forEach((partner, index) => { partner.profitSharePct = parts[index]; });
}

function upsertPartner(partners: NonNullable<LocalDocumentSetup['partners']>, name: string, capital: number): void {
  const existing = partners.find((row) => normalizeParty(row.name) === normalizeParty(name));
  if (existing) existing.capital = capital;
  else partners.push({ name, capital });
}

function extractTotals(lines: string[]): { selected?: AmountCandidate; ambiguous: boolean; candidates: AmountCandidate[]; subtotal?: number; tax?: number } {
  const candidates: AmountCandidate[] = [];
  let subtotal: number | undefined;
  let tax: number | undefined;
  for (const line of lines) {
    const amounts = amountsOnLine(line);
    if (!amounts.length) continue;
    const amount = amounts[amounts.length - 1];
    if (/\b(?:sub\s*total|subtotal)\b/i.test(line)) { subtotal = amount; continue; }
    if (/\b(?:total\s+(?:tax|vat|gst)|(?:tax|vat|gst)\s+total)\b/i.test(line)) { tax = amount; continue; }
    if (/\b(?:tax|vat|gst)\b/i.test(line) && !/\btotal\b/i.test(line.replace(/\b(?:tax|vat|gst)\b/ig, ''))) { tax = amount; continue; }
    let priority = 0;
    let label = '';
    if (/\bgrand\s+total\b/i.test(line)) { priority = 100; label = 'grand total'; }
    else if (/\b(?:amount|balance)\s+due\b/i.test(line)) { priority = 95; label = 'amount due'; }
    else if (/\bnet\s+total\b/i.test(line)) { priority = 90; label = 'net total'; }
    else if (/\btotal\s+(?:paid|amount)\b/i.test(line)) { priority = 88; label = 'total paid'; }
    else if (POSITION_TOTAL.test(line) || PNL_OR_RECON_DETAIL.test(line)) { continue; }
    else if (/\btotal\b/i.test(line) && !/\b(?:items?|qty|quantity)\b/i.test(line)) { priority = 80; label = 'total'; }
    else if (/\b(?:amount|paid)\b/i.test(line) && /[$€£₹]|\d+[.,]\d{2}\b/.test(line)) { priority = 45; label = 'amount'; }
    if (priority) candidates.push({ amount, label, priority, line });
  }
  if (!candidates.length) {
    for (const line of lines) {
      if (/\b(?:qty|quantity|change|tender(?:ed)?|items?|rate)\b/i.test(line)) continue;
      if (/\b(?:tax|vat|gst|sub\s*total)\b/i.test(line)) continue;
      if (/\b(?:20\d{2}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]20\d{2}|date)\b/i.test(line)) continue;
      const amounts = amountsOnLine(line).filter((value) => !(Number.isInteger(value) && value >= 1900 && value <= 2100));
      if (!amounts.length) continue;
      candidates.push({ amount: amounts[amounts.length - 1], label: 'visible amount', priority: 20, line });
    }
  }
  if (!candidates.length) return { ambiguous: false, candidates, subtotal, tax };
  const maxPriority = Math.max(...candidates.map((row) => row.priority));
  const best = candidates.filter((row) => row.priority === maxPriority);
  const distinct = unique(best.map((row) => row.amount));
  if (maxPriority <= 20 && distinct.length > 1) {
    const largest = Math.max(...distinct);
    const chosen = best.filter((row) => row.amount === largest);
    return { selected: chosen[chosen.length - 1], ambiguous: false, candidates, subtotal, tax };
  }
  return { selected: best[best.length - 1], ambiguous: distinct.length > 1, candidates, subtotal, tax };
}

function extractDates(lines: string[]): { selected?: string; candidates: string[]; ambiguous: boolean } {
  const labelled: string[] = [];
  const other: string[] = [];
  const monthNames = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const numeric = /\b(?:\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\b/g;
  const month = new RegExp(`\\b(?:(?:${monthNames})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthNames})\\s+\\d{4})\\b`, 'ig');
  for (const line of lines) {
    if (/\b(?:due\s+date|valid\s+until|expiry|expires)\b/i.test(line)) continue;
    const found = [...line.matchAll(numeric), ...line.matchAll(month)].map((match) => parsePrintedDate(match[0])).filter((value): value is string => Boolean(value));
    if (/\b(?:invoice\s+date|receipt\s+date|statement\s+date|as\s+of|dated?|date)\b/i.test(line)) labelled.push(...found);
    else other.push(...found);
  }
  const pool = unique(labelled.length ? labelled : other);
  return { selected: pool.length === 1 ? pool[0] : undefined, candidates: pool, ambiguous: pool.length > 1 };
}

const MONTH_NUMBER: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parsePrintedDate(raw: string): string | undefined {
  const normalized = normalizeDateInput(raw);
  if (isValidDateString(normalized)) return normalized;
  const cleaned = compact(raw);
  const monthFirst = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))$/i);
  const dayFirst = cleaned.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/i);
  if (!monthFirst && !dayFirst) return undefined; // Never infer a missing document year from scan time.
  const monthText = monthFirst?.[1] || dayFirst![2];
  const dayText = monthFirst?.[2] || dayFirst![1];
  const yearText = monthFirst?.[3] || dayFirst![3];
  const month = MONTH_NUMBER[monthText.slice(0, 3).toLowerCase()];
  const candidate = `${yearText}-${String(month).padStart(2, '0')}-${String(Number(dayText)).padStart(2, '0')}`;
  return month && isValidDateString(candidate) ? candidate : undefined;
}

function methodFrom(lines: string[], isInvoice: boolean): ScanPaymentMethod | undefined {
  const text = lines.join(' ');
  if (/\b(?:upi|mobile\s+money|m-?pesa|mobile\s+payment)\b/i.test(text)) return 'mobile';
  if (/\b(?:visa|mastercard|credit\s+card|debit\s+card|card)\b/i.test(text)) return 'card';
  if (/\b(?:bank\s+transfer|wire|eft|ach)\b/i.test(text)) return 'bank';
  if (/\b(?:paid\s+cash|cash\s+paid|payment\s+method\s*:?\s*cash|tendered\s+cash)\b/i.test(text)) return 'cash';
  if (lines.some((line) => /^cash\b/i.test(line))) return 'cash';
  if (isInvoice && /\b(?:amount\s+due|balance\s+due|payment\s+terms|net\s+\d+)\b/i.test(text)) return 'credit';
  return undefined;
}

function normalizeParty(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/\b(?:limited|ltd|incorporated|inc|llc|corp(?:oration)?|company|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]; previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[b.length];
}

function likelyHeader(lines: string[]): string | undefined {
  const labelled = lines.map((line) => line.match(/\b(?:supplier|vendor|merchant|sold\s+by|from)\s*:?\s*([A-Za-z][A-Za-z0-9 &'.,'-]{2,100})/i)?.[1]).find(Boolean);
  if (labelled) return compact(labelled);
  return lines.slice(0, 6).find((line) => /[A-Za-z]{3}/.test(line)
    && !/\b(?:tax\s+invoice|invoice|receipt|date|phone|tel|address|gst|vat|bill\s+to)\b/i.test(line)
    && !STATEMENT_HEADER_NOISE.test(line)
    && !/^\d[\d\s()+-]+$/.test(line)
    && line.length <= 100);
}

function resolveKnownParty(raw: string | undefined, rows: NamedParty[]): { selected?: string; candidates: string[] } {
  if (!raw) return { candidates: [] };
  const needle = normalizeParty(raw);
  const exact = rows.filter((row) => normalizeParty(row.name) === needle);
  if (exact.length === 1) return { selected: exact[0].name, candidates: [exact[0].name] };
  const fuzzy = rows.filter((row) => {
    const name = normalizeParty(row.name);
    const allowance = Math.max(1, Math.floor(Math.max(name.length, needle.length) * 0.12));
    return name.includes(needle) || needle.includes(name) || editDistance(name, needle) <= allowance;
  });
  return fuzzy.length === 1 ? { selected: fuzzy[0].name, candidates: [fuzzy[0].name] } : { candidates: fuzzy.map((row) => row.name) };
}

function resolvePartyFromDocument(lines: string[], header: string | undefined, rows: NamedParty[]): { selected?: string; candidates: string[] } {
  const normalizedLines = lines.map(normalizeParty).filter(Boolean);
  const visible = rows.filter((row) => {
    const name = normalizeParty(row.name);
    return name.length >= 3 && normalizedLines.some((line) => line === name || line.includes(name));
  });
  if (visible.length === 1) return { selected: visible[0].name, candidates: [visible[0].name] };
  if (visible.length > 1) return { candidates: visible.map((row) => row.name) };
  return resolveKnownParty(header, rows);
}

function labelledAmount(line: string): { name: string; amount: number } | undefined {
  const amounts = amountsOnLine(line);
  if (!amounts.length) return undefined;
  const rawName = compact(
    line
      .replace(/(?:[$€£₹]\s*)?\d[\d,.]*(?:\s*(?:USD|CAD|EUR|GBP|INR))?/gi, ' ')
      .replace(/[:=-]+$/g, '')
      .replace(/^(?:assets?|liabilities?|equity|capital|drawings?(?:\s+this\s+period)?)\s+/i, ''),
  );
  return rawName ? { name: rawName, amount: amounts[amounts.length - 1] } : undefined;
}

function parseOpeningAnalysis(lines: string[], dates: ReturnType<typeof extractDates>): LocalDocumentAnalysis {
  const setup: LocalDocumentSetup = { extraAssets: [], extraLiabilities: [], partners: [] };
  for (const line of lines) {
    const row = labelledAmount(line);
    if (!row) continue;
    if (POSITION_TOTAL.test(row.name) || PNL_OR_RECON_DETAIL.test(row.name)) continue;
    if (/^\s*commission\b/i.test(row.name) && !/\bpayable\b/i.test(row.name)) continue;
    if (/\b(?:total|net\s+worth|assets?|liabilities?|profit|loss|revenue|sales|expenses?)\b/i.test(row.name)
        && !/\b(?:cash|stock|inventory|creditors?|accounts?\s+payable)\b/i.test(row.name)) continue;
    if (/\b(?:cash(?:\s+in\s+hand)?|petty\s+cash|cash\s+at)\b/i.test(row.name)
        || /\b(?:stock|inventory)\b/i.test(row.name)) {
      setup.extraAssets!.push({ name: row.name, amount: row.amount });
    }
    else if (/\b(?:creditors?|accounts?\s+payable)\b/i.test(row.name)) setup.creditorsTotal = cents((setup.creditorsTotal || 0) + row.amount);
    else if (/\b(?:loan|payable|liabilit|accrued)\b/i.test(row.name)) setup.extraLiabilities!.push({ name: row.name, amount: row.amount });
    else {
      const ending = row.name.match(/^(.*?)\s+(?:ending|closing)\s+(?:stake|capital|balance)$/i);
      if (ending?.[1].trim() && !/^(?:owner|total|partner)$/i.test(ending[1].trim())) {
        upsertPartner(setup.partners!, ending[1].trim(), row.amount);
        continue;
      }
      if (/\b(?:opening(?:\s+stake)?|profit\s+share|drawings?|capital\s+withdrawn)\b/i.test(row.name)) continue;
      const capital = row.name.match(/^(.*?)\s+(?:capital|stake|closing\s+balance)$/i)
        || row.name.match(/^(?:capital|stake)\s+(?:account\s+)?(?:of\s+)?(.*?)$/i);
      if (capital && capital[1].trim() && !/^(?:owner|total)$/i.test(capital[1].trim())) {
        upsertPartner(setup.partners!, capital[1].trim(), row.amount);
      } else if (/\b(?:equipment|deposit|receivable|asset|prepaid|vehicle|property|bank)\b/i.test(row.name)) {
        setup.extraAssets!.push({ name: row.name, amount: row.amount });
      }
    }
  }
  applyVisiblePartnerSplit(setup.partners!, lines);
  if (dates.selected) setup.asOfDate = dates.selected;
  return { docType: 'closing_report', summary: 'Local OCR found labelled balances for review. Totals such as Net Profit and Total Assets are not imported as extra rows.', entries: [], setup };
}

function evidenceFor(dates: ReturnType<typeof extractDates>, totals: ReturnType<typeof extractTotals>, parties: string[]): LocalDocumentEvidence {
  return {
    dateCandidates: dates.candidates,
    amountCandidates: unique(totals.candidates.map((row) => row.amount)),
    partyCandidates: unique(parties),
    selectedTotalLabel: totals.selected?.label,
    subtotal: totals.subtotal,
    tax: totals.tax,
  };
}

function clarify(
  analysis: LocalDocumentAnalysis,
  field: LocalDocumentClarificationField,
  question: string,
  sourceText: string,
  evidence: LocalDocumentEvidence,
  candidates?: string[],
): LocalDocumentParseResult {
  return { kind: 'clarification', confidence: analysis.entries.length || analysis.setup ? 'medium' : 'low', analysis, field, question, ...(candidates?.length ? { candidates } : {}), evidence, sourceText };
}

/**
 * Converts Android OCR text into a bounded, review-only analysis object. It
 * deliberately prefers one question over guessing between total/subtotal,
 * invoice/receipt direction, dates, or approximate party matches.
 */
export function parseLocalDocumentText(sourceText: string, options: LocalDocumentParserOptions = {}): LocalDocumentParseResult {
  const text = sourceText.trim();
  if (!text) return { kind: 'unsupported', confidence: 'low', reason: 'Local OCR did not return readable document text.', sourceText: text };
  const lines = pairLabelledAmountLines(unpackPackedAmountLines(linesOf(text)));
  if (lines.length < 2 && text.length < 12) return { kind: 'unsupported', confidence: 'low', reason: 'Not enough readable text was found to prepare a safe draft.', sourceText: text };

  const dates = extractDates(lines);
  const totals = extractTotals(lines);
  if (looksLikePositionReport(lines)) {
    const analysis = parseOpeningAnalysis(lines, dates);
    const capitalDirectory = options.knownCapitalAccounts || options.capitalAccounts || [];
    const ambiguousCapitalNames: string[] = [];
    for (const partner of analysis.setup?.partners || []) {
      const resolution = resolveKnownParty(partner.name, capitalDirectory);
      if (resolution.selected) partner.name = resolution.selected;
      else if (resolution.candidates.length > 1) ambiguousCapitalNames.push(...resolution.candidates);
    }
    const evidence = evidenceFor(dates, totals, ambiguousCapitalNames.length ? ambiguousCapitalNames : (analysis.setup?.partners || []).map((row) => row.name));
    const setup = analysis.setup!;
    const hasBalances = Boolean(setup.openingCash || setup.stockValue || setup.creditorsTotal || setup.extraAssets?.length || setup.extraLiabilities?.length || setup.partners?.length);
    if (!hasBalances) return { kind: 'unsupported', confidence: 'low', reason: 'A balance report was detected, but no labelled balances were readable.', sourceText: text };
    if (dates.ambiguous || !setup.asOfDate) return clarify(analysis, 'date', dates.ambiguous ? 'Which visible date is the statement date?' : 'What statement date is printed on this report?', text, evidence, dates.candidates);
    if (ambiguousCapitalNames.length) return clarify(analysis, 'party', 'Which existing Capital Account matches the OCR name?', text, evidence, unique(ambiguousCapitalNames));
    return { kind: 'confident', confidence: 'medium', analysis, evidence, sourceText: text };
  }

  const evidence = evidenceFor(dates, totals, []);
  if (!totals.selected) {
    const analysis: LocalDocumentAnalysis = {
      docType: 'other',
      summary: 'Local OCR found document text but no readable amount. Enter the total to continue.',
      entries: [],
    };
    return clarify(analysis, 'amount', 'I could not find a total on this document. Enter the amount to record.', text, evidence);
  }

  const invoice = lines.some((line) => /\b(?:tax\s+invoice|invoice\s*(?:no|number|#)|amount\s+due|bill\s+to|payment\s+terms)\b/i.test(line));
  const receipt = lines.some((line) => /\b(?:receipt|thank\s+you|change|tendered|paid)\b/i.test(line));
  const explicitSupplier = lines.some((line) => /\b(?:supplier|vendor|purchase\s+bill|bill\s+from)\b/i.test(line));
  const explicitCustomer = lines.some((line) => /\b(?:customer\s+receipt|received\s+from|sales\s+receipt)\b/i.test(line));
  const capitalEvidence = lines.some((line) => /\b(?:capital\s+contribution|owner\s+investment|partner\s+deposit)\b/i.test(line));
  const header = likelyHeader(lines);
  const capitalLabel = lines.map((line) => line.match(/\b(?:capital\s+account|partner|owner|member)\s*:?\s*([A-Za-z][A-Za-z0-9 &'.,'-]{1,100})/i)?.[1]
    || line.match(/^([A-Za-z][A-Za-z0-9 &'.,'-]{1,100}?)\s+(?:capital\s+contribution|owner\s+investment|partner\s+deposit)\b/i)?.[1]).find(Boolean);
  const partyPool = capitalEvidence
    ? (options.knownCapitalAccounts || options.capitalAccounts || [])
    : explicitCustomer
    ? (options.knownCustomers || options.customers || [])
    : (options.knownSuppliers || options.suppliers || []);
  const partyMatch = resolvePartyFromDocument(lines, capitalEvidence ? capitalLabel : header, partyPool);
  evidence.partyCandidates = partyMatch.candidates.length ? partyMatch.candidates : ((capitalEvidence ? capitalLabel : header) ? [String(capitalEvidence ? capitalLabel : header)] : []);
  evidence.invoiceNumber = lines.map((line) => line.match(/\b(?:invoice|receipt)\s*(?:no|number|#)\s*:?\s*([A-Za-z0-9/-]+)/i)?.[1]).find(Boolean);

  let type: ScanEntryType = capitalEvidence ? 'capital_contribution' : explicitCustomer ? 'receipt_in' : invoice || explicitSupplier ? 'purchase_bill' : 'expense';
  const method = methodFrom(lines, invoice);
  const partyName = partyMatch.selected || (capitalEvidence ? capitalLabel : header);
  const notes = [
    totals.selected.label ? `Local OCR ${totals.selected.label}` : 'Local OCR total',
    totals.subtotal !== undefined ? `subtotal ${totals.subtotal.toFixed(2)}` : '',
    totals.tax !== undefined ? `tax ${totals.tax.toFixed(2)}` : '',
  ].filter(Boolean).join('; ');
  const analysis: LocalDocumentAnalysis = {
    docType: receipt ? 'receipt' : invoice ? 'statement' : 'other',
    summary: totals.selected.label === 'visible amount'
      ? 'Local OCR inferred a total from visible amounts. Verify the type, party, date, tax and payment method.'
      : 'Local OCR prepared one accounting draft from a labelled final total. Verify the type, party, date, tax and payment method.',
    entries: [{ type, ...(dates.selected ? { date: dates.selected } : {}), ...(partyName ? { partyName } : {}), amount: totals.selected.amount, ...(method ? { method } : {}), notes }],
  };

  if (totals.ambiguous) return clarify(analysis, 'amount', 'More than one different final total was detected. Which amount should be recorded?', text, evidence, unique(totals.candidates.filter((row) => row.priority === totals.selected!.priority).map((row) => row.amount.toFixed(2))));
  if (dates.ambiguous || !dates.selected) return clarify(analysis, 'date', dates.ambiguous ? 'Which visible date is the transaction date?' : 'What transaction date is printed on the document?', text, evidence, dates.candidates);
  if (invoice && !explicitSupplier && !explicitCustomer && !capitalEvidence) {
    type = 'purchase_bill';
    analysis.entries[0].type = type;
    analysis.summary = 'Local OCR prepared a supplier-bill draft. Confirm the party and total before import.';
  }
  if (partyMatch.candidates.length > 1) return clarify(analysis, 'party', 'Which existing account matches the OCR name?', text, evidence, partyMatch.candidates);
  if (capitalEvidence && !partyMatch.selected) return clarify(analysis, 'party', 'Which existing Capital Account received this contribution?', text, evidence, partyPool.map((party) => party.name));
  if (['purchase_bill', 'receipt_in', 'payment_out'].includes(type) && !partyName) return clarify(analysis, 'party', type === 'receipt_in' ? 'Which Customer is this from?' : 'Which Supplier is this from?', text, evidence);
  if (type === 'capital_contribution' && method && method !== 'cash') {
    return { kind: 'unsupported', confidence: 'low', reason: 'On-device Capital contribution import currently supports Cash only. Record a Bank, Card, or Mobile-funded contribution manually so the correct funding account is used.', sourceText: text };
  }
  if (!method) {
    if (type === 'capital_contribution') {
      return clarify(analysis, 'method', 'Was this paid into Cash? Non-cash Capital funding must currently be recorded manually.', text, evidence, ['cash']);
    }
    analysis.entries[0].method = 'cash';
    analysis.entries[0].notes = [analysis.entries[0].notes, 'Payment method assumed cash; change it on the review screen if needed.'].filter(Boolean).join('; ');
  }

  // A merchant receipt with a clear total/date/method is a safe expense draft;
  // it remains editable and still passes through mapAnalyzedDocument + review.
  if (receipt && !invoice && !capitalEvidence) type = 'expense';
  analysis.entries[0].type = type;
  return { kind: 'confident', confidence: partyMatch.selected ? 'high' : 'medium', analysis, evidence, sourceText: text };
}

/** Applies one user answer to a pending local draft without writing or losing OCR evidence. */
export function continueLocalDocumentParse(
  pending: Extract<LocalDocumentParseResult, { kind: 'clarification' }>,
  answer: string,
): LocalDocumentParseResult {
  const value = compact(answer);
  if (!value) return pending;
  const analysis: LocalDocumentAnalysis = { ...pending.analysis, entries: pending.analysis.entries.map((entry) => ({ ...entry })), setup: pending.analysis.setup ? { ...pending.analysis.setup } : undefined };
  const entry = analysis.entries[0];
  if (pending.field === 'date') {
    const date = parsePrintedDate(value);
    if (!date) return pending;
    if (entry) entry.date = date;
    if (analysis.setup) analysis.setup.asOfDate = date;
  } else if (pending.field === 'amount') {
    const amount = amountsOnLine(value)[0];
    if (amount === undefined) return pending;
    if (!entry) analysis.entries.push({ type: 'expense', amount, notes: 'Amount entered after local OCR.' });
    else entry.amount = amount;
  } else if (pending.field === 'party') {
    if (entry) entry.partyName = value;
    else if (analysis.setup?.partners?.length === 1) analysis.setup.partners[0].name = value;
    else return pending;
  } else if (pending.field === 'method') {
    if (!entry) return pending;
    const method = /\bmobile|upi\b/i.test(value) ? 'mobile' : /\bcard\b/i.test(value) ? 'card' : /\bbank\b/i.test(value) ? 'bank' : /\bcredit\b/i.test(value) ? 'credit' : /\bcash\b/i.test(value) ? 'cash' : undefined;
    if (!method) return pending;
    entry.method = method;
  } else if (pending.field === 'documentType') {
    if (!entry) return pending;
    if (/\b(?:supplier|purchase|bill)\b/i.test(value)) { entry.type = 'purchase_bill'; analysis.docType = 'statement'; }
    else if (/\b(?:sales?\s+invoice|sale)\b/i.test(value)) { entry.type = 'sale'; analysis.docType = 'statement'; }
    else if (/\b(?:expense|receipt)\b/i.test(value)) { entry.type = 'expense'; analysis.docType = 'receipt'; }
    else return pending; // Capital contribution needs its dedicated review route, never a sales/receipt shortcut.
  } else return pending;

  if (entry && !entry.date) return clarify(analysis, 'date', 'What transaction date is printed on the document?', pending.sourceText, pending.evidence);
  if (entry && ['purchase_bill', 'receipt_in', 'payment_out'].includes(entry.type) && !entry.partyName) return clarify(analysis, 'party', entry.type === 'receipt_in' ? 'Which Customer is this from?' : 'Which Supplier is this from?', pending.sourceText, pending.evidence);
  if (entry?.type === 'capital_contribution' && entry.method && entry.method !== 'cash') {
    return { kind: 'unsupported', confidence: 'low', reason: 'On-device Capital contribution import currently supports Cash only. Record a non-cash contribution manually so the correct funding account is used.', sourceText: pending.sourceText };
  }
  if (entry && !entry.method) return entry.type === 'capital_contribution'
    ? clarify(analysis, 'method', 'Was this paid into Cash? Non-cash Capital funding must currently be recorded manually.', pending.sourceText, pending.evidence, ['cash'])
    : clarify(analysis, 'method', 'Was this Cash, Credit, Bank, Card, or Mobile / UPI?', pending.sourceText, pending.evidence, ['cash', 'credit', 'bank', 'card', 'mobile']);
  return { kind: 'confident', confidence: 'high', analysis, evidence: pending.evidence, sourceText: pending.sourceText };
}
