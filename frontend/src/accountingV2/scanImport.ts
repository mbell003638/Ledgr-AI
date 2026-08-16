/**
 * Scan & Import — pure mapper from an analyzeDocumentAI result to reviewable,
 * bounds-checked import rows. NO side effects and NO React Native imports so it
 * is unit-testable and shared between the screen and the test suite.
 *
 * Every amount is validated against the SAME caps as the other AI channels
 * (MAX_AI_AMOUNT / MIN_AI_YEAR..MAX_AI_YEAR from aiActions) and every date is
 * normalized with normalizeDateInput before validation. Anything that fails
 * lands in flaggedRows with a human reason and can never be imported.
 */
import { MAX_AI_AMOUNT, MIN_AI_YEAR, MAX_AI_YEAR } from './aiActions';
import { normalizeDateInput, isValidDateString } from '../utils/dateValidation';

export type ScanEntryType = 'sale' | 'purchase_bill' | 'receipt_in' | 'payment_out' | 'expense';
export const SCAN_ENTRY_TYPES: ScanEntryType[] = ['sale', 'purchase_bill', 'receipt_in', 'payment_out', 'expense'];

export type ScanPaymentMethod = 'cash' | 'credit' | 'bank' | 'card' | 'mobile';
export const SCAN_PAYMENT_METHODS: ScanPaymentMethod[] = ['cash', 'credit', 'bank', 'card', 'mobile'];

export function normalizeScanMethod(value: unknown): ScanPaymentMethod | null {
  if (value == null || String(value).trim() === '') return 'cash';
  const method = String(value).trim().toLowerCase();
  if (method === 'upi') return 'mobile';
  return (SCAN_PAYMENT_METHODS as string[]).includes(method) ? method as ScanPaymentMethod : null;
}

export type ScanTransactionRow = {
  kind: 'transaction';
  entryType: ScanEntryType;
  date: string;
  partyName: string;
  amount: number;
  method: ScanPaymentMethod;
  notes: string;
};
export type ScanOpeningRow = { kind: 'opening_balances'; asOfDate: string; openingCash: number; stockValue: number };
export type ScanAssetRow = { kind: 'asset'; name: string; amount: number; date: string };
export type ScanLiabilityRow = { kind: 'liability'; name: string; amount: number; date: string };
export type ScanPartnerRow = { kind: 'partner'; name: string; capital: number; profitSharePct?: number; date: string };
export type ScanRow = ScanTransactionRow | ScanOpeningRow | ScanAssetRow | ScanLiabilityRow | ScanPartnerRow;

export type FlaggedScanRow = { label: string; reason: string };
export type MappedDocument = {
  docType: string;
  summary: string;
  validRows: ScanRow[];
  flaggedRows: FlaggedScanRow[];
};

export type BalancedOpeningSet = {
  date: string;
  cash: number;
  inventory: number;
  otherAssets: number;
  assetBreakdown: { name: string; amount: number }[];
  accountsPayable: number;
  otherLiabilities: number;
  liabilityBreakdown: { name: string; amount: number; type: 'creditor' | 'other' }[];
  ownerCapital: number;
  partnerCapitals: { name: string; amount: number; profitSharePct?: number }[];
  totalAssets: number;
  totalLiabilities: number;
};

export type BalancedOpeningSetResult =
  | { value: BalancedOpeningSet; error: null }
  | { value: null; error: string };

export const AMOUNT_BOUNDS_REASON = `Amount must be a positive number no greater than ${MAX_AI_AMOUNT.toLocaleString()}`;
export const DATE_BOUNDS_REASON = `Date must be a valid YYYY-MM-DD date between ${MIN_AI_YEAR} and ${MAX_AI_YEAR}`;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>) : undefined;
}

/** Positive, finite, and within the shared AI amount cap. */
export function isValidScanAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_AI_AMOUNT;
}

function nonNegativeAmount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_AI_AMOUNT) return null;
  return value;
}

/**
 * Normalize an AI/user supplied date. Returns the canonical YYYY-MM-DD string
 * when valid AND inside the AI year bounds, otherwise null.
 */
export function normalizeScanDate(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = normalizeDateInput(String(value));
  if (!isValidDateString(normalized)) return null;
  const year = Number(normalized.slice(0, 4));
  if (year < MIN_AI_YEAR || year > MAX_AI_YEAR) return null;
  return normalized;
}

const CASH_NAME = /\bcash\b/i;
const STOCK_NAME = /\b(stock|inventory)\b/i;
const CREDITOR_NAME = /^(creditors?|accounts? payable)$/i;
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Collapse editable setup rows into one balanced opening set. Balance-style
 * documents must be posted atomically: importing their assets and liabilities
 * as independent transactions would invent counter-balances and overstate the
 * balance sheet.
 */
export function buildBalancedOpeningSet(rows: ScanRow[]): BalancedOpeningSetResult {
  const setupRows = rows.filter((row) => row.kind !== 'transaction');
  const openings = setupRows.filter((row): row is ScanOpeningRow => row.kind === 'opening_balances');
  if (openings.length !== 1) return { value: null, error: 'A balance report must contain exactly one cash and stock opening row' };

  const dateValues = setupRows.map((row) => row.kind === 'opening_balances' ? row.asOfDate : row.date);
  const normalizedDates = dateValues.map(normalizeScanDate);
  if (normalizedDates.some((date) => !date)) {
    return { value: null, error: 'Enter the statement date shown on the report (YYYY-MM-DD); the scan date is not used automatically' };
  }
  const dates = [...new Set(normalizedDates as string[])];
  if (dates.length !== 1) return { value: null, error: 'All opening-balance rows must use the same statement date' };

  const opening = openings[0];
  if (![opening.openingCash, opening.stockValue].every((value) => Number.isFinite(value) && value >= 0 && value <= MAX_AI_AMOUNT)) {
    return { value: null, error: AMOUNT_BOUNDS_REASON };
  }
  const assets = setupRows.filter((row): row is ScanAssetRow => row.kind === 'asset');
  const liabilities = setupRows.filter((row): row is ScanLiabilityRow => row.kind === 'liability');
  const partners = setupRows.filter((row): row is ScanPartnerRow => row.kind === 'partner');
  if ([...assets, ...liabilities].some((row) => !row.name.trim() || !isValidScanAmount(row.amount)) ||
      partners.some((row) => !row.name.trim() || !isValidScanAmount(row.capital) ||
        (row.profitSharePct !== undefined && (!Number.isFinite(row.profitSharePct) || row.profitSharePct < 0 || row.profitSharePct > 100)))) {
    return { value: null, error: 'Every opening asset, liability, and partner needs a name and valid positive amount' };
  }

  const assetBreakdown = assets.map((row) => ({ name: row.name.trim(), amount: cents(row.amount) }));
  const liabilityBreakdown = liabilities.map((row) => ({
    name: row.name.trim(), amount: cents(row.amount), type: CREDITOR_NAME.test(row.name.trim()) ? 'creditor' as const : 'other' as const,
  }));
  const cash = cents(opening.openingCash);
  const inventory = cents(opening.stockValue);
  const otherAssets = cents(assetBreakdown.reduce((sum, row) => sum + row.amount, 0));
  const accountsPayable = cents(liabilityBreakdown.filter((row) => row.type === 'creditor').reduce((sum, row) => sum + row.amount, 0));
  const otherLiabilities = cents(liabilityBreakdown.filter((row) => row.type === 'other').reduce((sum, row) => sum + row.amount, 0));
  const totalAssets = cents(cash + inventory + otherAssets);
  const totalLiabilities = cents(accountsPayable + otherLiabilities);
  const ownerCapital = cents(totalAssets - totalLiabilities);
  if (ownerCapital < 0) return { value: null, error: 'Opening liabilities cannot exceed opening assets' };

  const partnerCapitals = partners.map((row) => ({
    name: row.name.trim(), amount: cents(row.capital),
    ...(row.profitSharePct === undefined ? {} : { profitSharePct: row.profitSharePct }),
  }));
  const partnerTotal = cents(partnerCapitals.reduce((sum, row) => sum + row.amount, 0));
  if (partnerCapitals.length && Math.abs(partnerTotal - ownerCapital) > 0.005) {
    return {
      value: null,
      error: `Capital accounts (${partnerTotal.toFixed(2)}) must equal assets minus liabilities (${ownerCapital.toFixed(2)})`,
    };
  }

  return {
    value: {
      date: dates[0], cash, inventory, otherAssets, assetBreakdown,
      accountsPayable, otherLiabilities, liabilityBreakdown, ownerCapital,
      partnerCapitals, totalAssets, totalLiabilities,
    },
    error: null,
  };
}

/**
 * Map the raw analyzeDocumentAI JSON into bounds-checked rows.
 *
 * Mapping rules (defense-in-depth: applied here even though the prompt also
 * instructs the model to do the same):
 * - entries[] → transaction rows; missing dates stay blank for editable review;
 *   invalid supplied amount/date/type → flagged.
 * - setup.extraAssets rows whose NAME contains "cash" are summed into opening
 *   cash; rows named stock/inventory are folded into stockValue; the rest
 *   become manual-asset rows.
 * - openingCash + stockValue collapse into ONE opening-balances row.
 * - creditorsTotal becomes a "Creditors" liability row; extraLiabilities map
 *   one-to-one to liability rows.
 * - partners map to partner-capital rows (the screen decides whether an
 *   existing investor ledger can absorb them or they stay a manual step).
 * - Non-object junk in any array is ignored silently.
 */
export function mapAnalyzedDocument(input: unknown): MappedDocument {
  const doc = asRecord(input);
  const validRows: ScanRow[] = [];
  const flaggedRows: FlaggedScanRow[] = [];
  if (!doc) return { docType: 'other', summary: '', validRows, flaggedRows };

  const docType = typeof doc.docType === 'string' ? doc.docType : 'other';
  const summary = typeof doc.summary === 'string' ? doc.summary : '';

  // ---- Transactions ----
  const isClosingReport = docType === 'closing_report';
  const entries = isClosingReport ? [] : (Array.isArray(doc.entries) ? doc.entries : []);
  if (isClosingReport && Array.isArray(doc.entries) && doc.entries.length > 0) {
    flaggedRows.push({
      label: 'Closing Report P&L summary entries',
      reason: 'Closing report summary totals cannot be imported as new individual ledger transactions',
    });
  }
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue; // junk (string/number/null) — ignore
    const label = `${String(entry.type || 'entry')} ${entry.partyName ? String(entry.partyName) + ' ' : ''}${entry.amount ?? '?'}`.trim();
    if (!SCAN_ENTRY_TYPES.includes(entry.type as ScanEntryType)) {
      flaggedRows.push({ label, reason: 'Unrecognized entry type' });
      continue;
    }
    if (!isValidScanAmount(entry.amount)) {
      flaggedRows.push({ label, reason: AMOUNT_BOUNDS_REASON });
      continue;
    }
    let date: string;
    if (entry.date === undefined || entry.date === null || String(entry.date).trim() === '') {
      // A missing transaction date is material accounting evidence, not a safe
      // place to guess. Keep the row editable but block it at review/import
      // until the user supplies the date shown by the source document.
      date = '';
    } else {
      const normalized = normalizeScanDate(entry.date);
      if (!normalized) {
        flaggedRows.push({ label, reason: DATE_BOUNDS_REASON });
        continue;
      }
      date = normalized;
    }
    const method = normalizeScanMethod(entry.method);
    if (!method) {
      flaggedRows.push({ label, reason: 'Payment method needs review' });
      continue;
    }
    validRows.push({
      kind: 'transaction',
      entryType: entry.type as ScanEntryType,
      date,
      partyName: typeof entry.partyName === 'string' ? entry.partyName.trim() : '',
      amount: entry.amount,
      method,
      notes: typeof entry.notes === 'string' ? entry.notes.trim() : '',
    });
  }

  // ---- Book setup ----
  const setup = asRecord(doc.setup);
  if (setup) {
    // A statement date is accounting evidence, not a convenience default. If
    // the document does not visibly provide one, leave it blank for review.
    const asOfDate = normalizeScanDate(setup.asOfDate) || '';

    let openingCash = nonNegativeAmount(setup.openingCash);
    let stockValue = nonNegativeAmount(setup.stockValue);
    if (setup.openingCash !== undefined && setup.openingCash !== null && openingCash === null) {
      flaggedRows.push({ label: `Opening cash ${setup.openingCash}`, reason: AMOUNT_BOUNDS_REASON });
    }
    if (setup.stockValue !== undefined && setup.stockValue !== null && stockValue === null) {
      flaggedRows.push({ label: `Stock value ${setup.stockValue}`, reason: AMOUNT_BOUNDS_REASON });
    }

    const assetRows: ScanAssetRow[] = [];
    const extraAssets = Array.isArray(setup.extraAssets) ? setup.extraAssets : [];
    for (const raw of extraAssets) {
      const asset = asRecord(raw);
      if (!asset) continue;
      const name = typeof asset.name === 'string' ? asset.name.trim() : '';
      const label = `Asset ${name || '?'} ${asset.amount ?? '?'}`;
      if (!name) { flaggedRows.push({ label, reason: 'Asset name is missing' }); continue; }
      if (!isValidScanAmount(asset.amount)) { flaggedRows.push({ label, reason: AMOUNT_BOUNDS_REASON }); continue; }
      if (CASH_NAME.test(name)) {
        openingCash = (openingCash ?? 0) + asset.amount; // fold cash rows into opening cash
      } else if (STOCK_NAME.test(name)) {
        stockValue = (stockValue ?? 0) + asset.amount; // fold stock rows into stock value
      } else {
        assetRows.push({ kind: 'asset', name, amount: asset.amount, date: asOfDate });
      }
    }

    const cappedCash = openingCash !== null && openingCash > MAX_AI_AMOUNT ? null : openingCash;
    const cappedStock = stockValue !== null && stockValue > MAX_AI_AMOUNT ? null : stockValue;
    if (openingCash !== null && cappedCash === null) flaggedRows.push({ label: `Opening cash ${openingCash}`, reason: AMOUNT_BOUNDS_REASON });
    if (stockValue !== null && cappedStock === null) flaggedRows.push({ label: `Stock value ${stockValue}`, reason: AMOUNT_BOUNDS_REASON });
    if ((cappedCash ?? 0) > 0 || (cappedStock ?? 0) > 0) {
      validRows.push({ kind: 'opening_balances', asOfDate, openingCash: cappedCash ?? 0, stockValue: cappedStock ?? 0 });
    }

    validRows.push(...assetRows);

    if (setup.creditorsTotal !== undefined && setup.creditorsTotal !== null) {
      if (isValidScanAmount(setup.creditorsTotal)) {
        validRows.push({ kind: 'liability', name: 'Creditors', amount: setup.creditorsTotal, date: asOfDate });
      } else {
        flaggedRows.push({ label: `Creditors ${setup.creditorsTotal}`, reason: AMOUNT_BOUNDS_REASON });
      }
    }

    const extraLiabilities = Array.isArray(setup.extraLiabilities) ? setup.extraLiabilities : [];
    for (const raw of extraLiabilities) {
      const liability = asRecord(raw);
      if (!liability) continue;
      const name = typeof liability.name === 'string' ? liability.name.trim() : '';
      const label = `Liability ${name || '?'} ${liability.amount ?? '?'}`;
      if (!name) { flaggedRows.push({ label, reason: 'Liability name is missing' }); continue; }
      if (!isValidScanAmount(liability.amount)) { flaggedRows.push({ label, reason: AMOUNT_BOUNDS_REASON }); continue; }
      validRows.push({ kind: 'liability', name, amount: liability.amount, date: asOfDate });
    }

    const partners = Array.isArray(setup.partners) ? setup.partners : [];
    for (const raw of partners) {
      const partner = asRecord(raw);
      if (!partner) continue;
      const name = typeof partner.name === 'string' ? partner.name.trim() : '';
      const label = `Capital account ${name || '?'} ${partner.capital ?? '?'}`;
      if (!name) { flaggedRows.push({ label, reason: 'Capital account name is missing' }); continue; }
      if (!isValidScanAmount(partner.capital)) { flaggedRows.push({ label, reason: AMOUNT_BOUNDS_REASON }); continue; }
      const profitSharePct = partner.profitSharePct === undefined ? undefined : Number(partner.profitSharePct);
      if (profitSharePct !== undefined && (!Number.isFinite(profitSharePct) || profitSharePct < 0 || profitSharePct > 100)) {
        flaggedRows.push({ label, reason: 'Capital-account profit share must be between 0 and 100 percent' });
        continue;
      }
      validRows.push({ kind: 'partner', name, capital: partner.capital, ...(profitSharePct === undefined ? {} : { profitSharePct }), date: asOfDate });
    }
  }

  return { docType, summary, validRows, flaggedRows };
}
