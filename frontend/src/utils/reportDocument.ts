/**
 * Monthly Report document builder.
 *
 * Pure, unit-testable HTML builder for the monthly financial report that
 * reproduces the user-approved prototype: a hero card (Net Profit / partner
 * share / profit before commission / commission), a two-column
 * assets/liabilities body, and a partner-stakes reconciliation card.
 *
 * The same layout is rendered as a MINI native preview inside
 * `app/monthly-summary.tsx`; this file owns ONLY the print/PDF HTML plus the
 * shared theme→palette resolver (exported so invoices could reuse it later).
 *
 * IMPORTANT: keep this file free of any React Native imports so it stays
 * trivially unit-testable in a plain Node/jest environment.
 */

export type InvoiceThemeId = 'navy_gold' | 'amoled_blue' | 'emerald' | 'minimal';

/**
 * Accent palette derived from an invoice theme. The PAGE always stays a
 * print-light cream/white with dark text (dark backgrounds don't print);
 * only the accents (card tints, section labels, headings, rule/positive/
 * negative hues) adapt per theme.
 */
export type ReportPalette = {
  /** Soft tint behind the hero (net-profit) card. */
  heroTint: string;
  /** Border of the hero card. */
  heroBorder: string;
  /** Soft tint behind the partner-stakes reconciliation card. */
  reconTint: string;
  /** Border of the reconciliation card. */
  reconBorder: string;
  /** Colour of the small uppercase section labels (ASSETS / LIABILITIES …). */
  sectionLabel: string;
  /** Colour of the reconciliation heading. */
  heading: string;
  /** Hairline rule colour. */
  rule: string;
  /** Positive/credit figures (profit share). */
  positive: string;
  /** Negative/debit figures (drawings, negative numbers). */
  negative: string;
  /** Primary dark text colour for values. */
  ink: string;
  /** Muted secondary text colour. */
  muted: string;
};

/**
 * Per-theme accent mapping. Cream page + dark ink is constant across ALL
 * themes for print legibility; the accents are derived from each theme's
 * primary/accent pair (mirroring src/utils/transactionActions.ts palettes).
 */
const PALETTES: Record<InvoiceThemeId, ReportPalette> = {
  // Warm black/gold — the natural fit for the reference image.
  navy_gold: {
    heroTint: '#F2F6EF',
    heroBorder: '#D6E0D0',
    reconTint: '#F7F1E1',
    reconBorder: '#E6D9B0',
    sectionLabel: '#9A9385',
    heading: '#A67C1A',
    rule: '#E2E0D8',
    positive: '#2D6B45',
    negative: '#B83A2E',
    ink: '#1C221F',
    muted: '#8A938E',
  },
  // Black/blue — cool accents on the same cream page.
  amoled_blue: {
    heroTint: '#EEF4FB',
    heroBorder: '#CFE0F1',
    reconTint: '#EDF1F6',
    reconBorder: '#CBD8E6',
    sectionLabel: '#8B93A2',
    heading: '#2C6BB0',
    rule: '#E0E4EA',
    positive: '#1F7A4D',
    negative: '#C0392B',
    ink: '#141B22',
    muted: '#7E879A',
  },
  // Classic emerald.
  emerald: {
    heroTint: '#EAF4EE',
    heroBorder: '#CBE3D5',
    reconTint: '#F4F1E4',
    reconBorder: '#DED6B4',
    sectionLabel: '#8A938E',
    heading: '#1C4030',
    rule: '#E2E5DF',
    positive: '#2E8B57',
    negative: '#B83A2E',
    ink: '#16241C',
    muted: '#7E877F',
  },
  // Clean minimal — soft sage accents.
  minimal: {
    heroTint: '#F1F5F1',
    heroBorder: '#D9E2D9',
    reconTint: '#F4F3EE',
    reconBorder: '#E0DDCE',
    sectionLabel: '#9AA09A',
    heading: '#4A5B4E',
    rule: '#E4E6E1',
    positive: '#4C7A5C',
    negative: '#B0483B',
    ink: '#111513',
    muted: '#8A938E',
  },
};

/** Resolve the report accent palette for an invoice theme (defaults to navy_gold). */
export function resolveReportPalette(theme?: string | null): ReportPalette {
  const key = (theme || 'navy_gold') as InvoiceThemeId;
  return PALETTES[key] || PALETTES.navy_gold;
}

// ---------- Input shape ----------

export type ReportLineItem = { label: string; amount: number };

export type ReportPartner = {
  name: string;
  opening: number;
  profitShare: number;
  drawings: number;
  ending: number;
};

export type MonthlyReportData = {
  /** Period title, e.g. "Jul 2026". */
  periodTitle: string;
  /** Period start date (ISO/display string) shown in the subline. */
  periodStart: string;
  /** Saved/generated timestamp shown in the subline. */
  savedAt: string;
  /** Currency symbol used for every figure. */
  currencySymbol: string;

  // Hero (monthly P&L). netProfit === profitBeforeCommission − commission.
  netProfit: number;
  profitBeforeCommission: number;
  commission: number;
  commissionPct: number; // e.g. 18 -> "Commission (18%)"

  // Partner share (hero row). Omitted/empty when the book has no partners.
  partnerCount: number;
  partnerShareEach: number;
  /** Split label, e.g. "50/50" or "33/33/34"; blank hides the % in the label. */
  splitLabel?: string;

  // Assets (left column) — cash accounts, physical stock, deposits/other.
  assets: ReportLineItem[];
  totalAssets: number;

  // Liabilities (right column).
  liabilities: ReportLineItem[];

  // Drawings this period (right column, under liabilities).
  drawings: ReportLineItem[];

  // Partner-stakes reconciliation card. Empty => card hidden.
  partners: ReportPartner[];
};

// ---------- Data assembly (pure, app-layer) ----------

/**
 * Assemble a {@link MonthlyReportData} from the app's existing report sources.
 * Pure and RN-free so it can be unit-tested and reused.
 *
 * @param summary   api.monthlySummary(m) result (monthly P&L figures).
 * @param dash      api.dashboard() result (cumulative balance-sheet snapshot).
 * @param capital   api.capitalStatement() result (per-partner reconciliation).
 * @param settings  api.getSettings() result (currency, invoiceTheme, extras).
 * @param opts      Display strings for the header (title + timestamp).
 */
export function assembleMonthlyReport(
  summary: any,
  dash: any,
  capital: any,
  settings: any,
  opts: { periodTitle: string; savedAt: string },
): MonthlyReportData {
  const currencySymbol = symbolFor(settings?.currency);

  // Hero: distributable profit = gross − commission (matches the prototype,
  // where Net Profit = Profit Before Commission − Commission).
  const profitBeforeCommission = num(summary?.grossProfit);
  const commission = num(summary?.commission);
  const netProfit = round2(profitBeforeCommission - commission);
  const commissionPct = Math.round(num(summary?.managerCommissionPct) * 100) / 100;

  const investors: any[] = Array.isArray(capital?.investors) ? capital.investors : [];
  const partnerCount = investors.length;
  const partnerShareEach = partnerCount > 0 ? round2(netProfit / partnerCount) : 0;
  const splitLabel = partnerCount > 1
    ? Array.from({ length: partnerCount }, () => Math.round(100 / partnerCount)).join('/')
    : '';

  // ASSETS: cash on hand, physical stock, then any custom extra assets.
  const assets: ReportLineItem[] = [];
  assets.push({ label: 'Cash on Hand', amount: num(dash?.cash) });
  assets.push({ label: 'Physical Stock', amount: num(dash?.inventoryValue) });
  if (num(dash?.accountsReceivable) > 0) {
    assets.push({ label: 'Accounts Receivable', amount: num(dash.accountsReceivable) });
  }
  for (const a of (Array.isArray(dash?.extraAssets) ? dash.extraAssets : [])) {
    assets.push({ label: String(a?.name || 'Other Asset'), amount: num(a?.amount) });
  }
  const totalAssets = num(dash?.assets);

  // LIABILITIES: creditors (suppliers payable) + commission payable + extras.
  const outstandingCommission = num(dash?.outstandingCommission);
  const creditors = round2(num(dash?.liabilities) - outstandingCommission);
  const liabilities: ReportLineItem[] = [];
  if (creditors !== 0) liabilities.push({ label: 'Supplier Payables', amount: creditors });
  if (outstandingCommission !== 0) liabilities.push({ label: 'Commission Payable', amount: outstandingCommission });
  for (const l of (Array.isArray(dash?.extraLiabilities) ? dash.extraLiabilities : [])) {
    liabilities.push({ label: String(l?.name || 'Other Liability'), amount: num(l?.amount) });
  }

  // DRAWINGS THIS PERIOD: per-partner from the capital statement.
  const drawings: ReportLineItem[] = investors.map((inv) => ({
    label: `${String(inv?.name || 'Capital Account')} Capital Withdrawn`,
    amount: num(inv?.drawings),
  }));

  // Partner-stakes reconciliation: opening (contributed) → +share → −drawings → ending.
  const partners: ReportPartner[] = investors.map((inv) => ({
    name: String(inv?.name || 'Capital Account'),
    opening: num(inv?.contributed),
    profitShare: num(inv?.profitShare),
    drawings: num(inv?.drawings),
    ending: num(inv?.balance),
  }));

  return {
    periodTitle: opts.periodTitle,
    periodStart: String(summary?.periodStart || dash?.periodStart || ''),
    savedAt: opts.savedAt,
    currencySymbol,
    netProfit,
    profitBeforeCommission,
    commission,
    commissionPct,
    partnerCount,
    partnerShareEach,
    splitLabel,
    assets,
    totalAssets,
    liabilities,
    drawings,
    partners,
  };
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(v: number): number { return Math.round(v * 100) / 100; }
/** Currency symbol for a settings currency code (shared with the custom report). */
export function symbolFor(code?: string): string {
  const map: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', PKR: 'Rs', AED: 'AED', SAR: 'SAR' };
  if (!code) return '$';
  return map[code] || '$';
}

// ---------- HTML helpers ----------

/** Shared HTML escaper (also used by the custom-report document builder). */
export const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** Format a number as a $ thousands-separated money string. */
export function money(n: number | null | undefined, symbol = '$'): string {
  const v = Number(n ?? 0);
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}${symbol}${s}`;
}

/** Wrap a money value in a coloured span when negative. */
function moneyCell(n: number, p: ReportPalette, symbol: string): string {
  const neg = Number(n) < 0;
  const color = neg ? p.negative : p.ink;
  return `<span class="num" style="color:${color}">${escapeHtml(money(n, symbol))}</span>`;
}

// ---------- Builder ----------

/**
 * Build the print/PDF HTML for the monthly report.
 *
 * @param input  Fully-assembled report data (assembled at the app layer).
 * @param theme  Invoice theme id used to derive the accent palette.
 */
export function buildMonthlyReportHtml(input: MonthlyReportData, theme: InvoiceThemeId): string {
  const p = resolveReportPalette(theme);
  const sym = input.currencySymbol || '$';
  const hasPartners = Array.isArray(input.partners) && input.partners.length > 0;

  // --- Hero card rows ---
  const heroRows: string[] = [];
  heroRows.push(`
    <div class="hero-row hero-net">
      <span class="hero-label">Net Profit</span>
      <span class="hero-net-value">${escapeHtml(money(input.netProfit, sym))}</span>
    </div>`);
  if (hasPartners && input.partnerCount > 0) {
    const split = input.splitLabel ? ` (${escapeHtml(input.splitLabel)})` : '';
    heroRows.push(`
    <div class="hero-row">
      <span class="hero-label">Profit Share${split}</span>
      <span class="num">${escapeHtml(money(input.partnerShareEach, sym))}</span>
    </div>`);
  }
  heroRows.push(`
    <div class="hero-row">
      <span class="hero-label">Profit Before Commission</span>
      <span class="num">${escapeHtml(money(input.profitBeforeCommission, sym))}</span>
    </div>`);
  if (input.commission !== 0 || input.commissionPct > 0) {
    const pctLabel = input.commissionPct > 0 ? ` (${escapeHtml(String(input.commissionPct))}%)` : '';
    heroRows.push(`
    <div class="hero-row">
      <span class="hero-label">Commission${pctLabel}</span>
      <span class="num">${escapeHtml(money(input.commission, sym))}</span>
    </div>`);
  }

  // --- Assets column ---
  const assetRows = input.assets.map((a) => `
      <div class="line-row">
        <span class="line-label">${escapeHtml(a.label)}</span>
        ${moneyCell(a.amount, p, sym)}
      </div>`).join('');
  const assetsBlock = `
    <div class="section-label">ASSETS</div>
    <div class="lines">
      ${assetRows}
      <div class="line-row total-row">
        <span class="line-label total-label">Total Assets</span>
        <span class="num total-num">${escapeHtml(money(input.totalAssets, sym))}</span>
      </div>
    </div>`;

  // --- Liabilities + Drawings column ---
  const liabRows = input.liabilities.map((l) => `
      <div class="line-row">
        <span class="line-label">${escapeHtml(l.label)}</span>
        ${moneyCell(l.amount, p, sym)}
      </div>`).join('');
  const drawingRows = input.drawings.map((d) => `
      <div class="line-row">
        <span class="line-label">${escapeHtml(d.label)}</span>
        ${moneyCell(d.amount, p, sym)}
      </div>`).join('');
  const liabBlock = `
    <div class="section-label">LIABILITIES</div>
    <div class="lines">${liabRows || `<div class="line-row"><span class="line-label muted">None</span></div>`}</div>
    ${input.drawings.length ? `
    <div class="section-label" style="margin-top:20px">CAPITAL WITHDRAWALS THIS PERIOD</div>
    <div class="lines">${drawingRows}</div>` : ''}`;

  // --- Reconciliation card ---
  const reconBlock = hasPartners ? `
    <div class="recon-card">
      <div class="recon-heading">Capital Accounts Reconciliation</div>
      ${input.partners.map((pt, i) => `
        <div class="recon-partner${i > 0 ? ' recon-sep' : ''}">
          <div class="line-row">
            <span class="line-label">${escapeHtml(pt.name)} Opening</span>
            <span class="num">${escapeHtml(money(pt.opening, sym))}</span>
          </div>
          <div class="line-row indent">
            <span class="line-label">+ Profit Share</span>
            <span class="num" style="color:${p.positive}">+${escapeHtml(money(pt.profitShare, sym))}</span>
          </div>
          <div class="line-row indent">
            <span class="line-label">&minus; Capital Withdrawn</span>
            <span class="num" style="color:${p.negative}">&minus;${escapeHtml(money(pt.drawings, sym))}</span>
          </div>
          <div class="line-row">
            <span class="line-label total-label">${escapeHtml(pt.name)} Ending Stake</span>
            <span class="num total-num" style="color:${p.positive}">${escapeHtml(money(pt.ending, sym))}</span>
          </div>
        </div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    @media print {
      * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      body { background: #FBFAF5 !important; }
    }
    :root { --ink: ${p.ink}; --muted: ${p.muted}; --rule: ${p.rule}; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0; padding: 28px; color: var(--ink); background: #FBFAF5; font-size: 13px; line-height: 1.4;
    }
    .num {
      font-family: 'Courier New', 'SFMono-Regular', Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
      text-align: right; font-weight: 600; white-space: nowrap;
    }
    .header { margin-bottom: 20px; }
    .period-title { font-size: 22px; font-weight: 800; margin: 0; color: var(--ink); }
    .period-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .hero-card {
      background: ${p.heroTint}; border: 1px solid ${p.heroBorder}; border-radius: 14px;
      padding: 6px 20px; margin-bottom: 26px;
    }
    .hero-row {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: 13px 0; border-bottom: 1px solid ${p.heroBorder};
    }
    .hero-row:last-child { border-bottom: none; }
    .hero-label { font-weight: 700; color: var(--ink); }
    .hero-net .hero-label { font-size: 15px; }
    .hero-net-value {
      font-family: 'Courier New', monospace; font-variant-numeric: tabular-nums;
      font-size: 26px; font-weight: 800; text-align: right; color: var(--ink); letter-spacing: -0.5px;
    }
    .body-grid { display: flex; gap: 48px; margin-bottom: 26px; }
    .body-col { flex: 1; min-width: 0; }
    .section-label {
      font-size: 10px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase;
      color: ${p.sectionLabel}; margin-bottom: 8px;
    }
    .lines { }
    .line-row {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: 9px 0; border-bottom: 1px solid var(--rule); gap: 12px;
    }
    .line-label { color: var(--ink); }
    .line-label.muted { color: var(--muted); }
    .indent .line-label { padding-left: 14px; color: var(--muted); }
    .total-row { border-bottom: none; border-top: 2px solid var(--ink); margin-top: 2px; }
    .total-label { font-weight: 800; }
    .total-num { font-weight: 800; }
    .recon-card {
      background: ${p.reconTint}; border: 1px solid ${p.reconBorder}; border-radius: 14px; padding: 20px 22px;
    }
    .recon-heading { color: ${p.heading}; font-weight: 800; font-size: 17px; margin-bottom: 8px; }
    .recon-partner { padding: 6px 0; }
    .recon-sep { border-top: 2px solid ${p.reconBorder}; margin-top: 6px; padding-top: 12px; }
    .recon-partner .line-row { border-bottom: 1px solid ${p.reconBorder}; }
    .recon-partner .line-row:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <div class="header">
    <h1 class="period-title">${escapeHtml(input.periodTitle)}</h1>
    <div class="period-sub">${escapeHtml(input.periodStart)} &middot; Saved ${escapeHtml(input.savedAt)}</div>
  </div>

  <div class="hero-card">
    ${heroRows.join('')}
  </div>

  <div class="body-grid">
    <div class="body-col">${assetsBlock}</div>
    <div class="body-col">${liabBlock}</div>
  </div>

  ${reconBlock}
</body>
</html>`;
}
