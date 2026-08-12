/**
 * Unit tests for the monthly report document builder + assembler.
 *
 * The builder is pure (no RN imports), so we can construct inputs directly and
 * assert on the produced HTML and pure assembled report shape.
 */

import fs from 'fs';
import path from 'path';
import {
  buildMonthlyReportHtml,
  assembleMonthlyReport,
  resolveReportPalette,
  money,
  type MonthlyReportData,
} from '../src/utils/reportDocument';

const baseInput = (over: Partial<MonthlyReportData> = {}): MonthlyReportData => ({
  periodTitle: 'Jul 2026',
  periodStart: '2026-07-01',
  savedAt: '7/16/2026, 8:18:27 AM',
  currencySymbol: '$',
  netProfit: 27621.01,
  profitBeforeCommission: 33684.16,
  commission: 6063.15,
  commissionPct: 18,
  partnerCount: 2,
  partnerShareEach: 13810.51,
  splitLabel: '50/50',
  assets: [
    { label: 'Cash on Hand', amount: 37741.17 },
    { label: 'Physical Stock', amount: 150527.46 },
  ],
  totalAssets: 197466.67,
  liabilities: [
    { label: 'Creditors', amount: 36215.42 },
    { label: 'Commission Payable', amount: 6063.15 },
  ],
  drawings: [
    { label: 'Amit Drawings', amount: 0 },
    { label: 'Rahim Drawings', amount: 0 },
  ],
  partners: [
    { name: 'Amit', opening: 55124.97, profitShare: 13810.51, drawings: 0, ending: 68935.48 },
    { name: 'Rahim', opening: 72442.12, profitShare: 13810.51, drawings: 0, ending: 86252.63 },
  ],
  ...over,
});

describe('buildMonthlyReportHtml — structure', () => {
  it('renders header, hero, both sections and reconciliation', () => {
    const html = buildMonthlyReportHtml(baseInput(), 'navy_gold');
    // Header
    expect(html).toContain('Jul 2026');
    expect(html).toContain('Saved 7/16/2026');
    // Hero
    expect(html).toContain('Net Profit');
    expect(html).toContain('Profit Before Commission');
    expect(html).toContain('Commission (18%)');
    expect(html).toContain("Profit Share (50/50)");
    // Sections
    expect(html).toContain('>ASSETS<');
    expect(html).toContain('>LIABILITIES<');
    expect(html).toContain('CAPITAL WITHDRAWALS THIS PERIOD');
    expect(html).toContain('Total Assets');
    // Reconciliation
    expect(html).toContain('Capital Accounts Reconciliation');
    expect(html).toContain('Amit Opening');
    expect(html).toContain('Amit Ending Stake');
    expect(html).toContain('Rahim Ending Stake');
    // A4 print CSS + monospace numerals
    expect(html).toContain('@page');
    expect(html).toContain("'Courier New'");
  });

  it('formats money with thousands separators and $ symbol', () => {
    const html = buildMonthlyReportHtml(baseInput(), 'navy_gold');
    expect(html).toContain('$27,621.01'); // net profit
    expect(html).toContain('$197,466.67'); // total assets
    expect(html).toContain('$150,527.46'); // physical stock
  });

  it('renders negative figures in the palette negative colour', () => {
    const p = resolveReportPalette('navy_gold');
    const html = buildMonthlyReportHtml(baseInput({
      liabilities: [{ label: 'Creditors', amount: -1250.5 }],
    }), 'navy_gold');
    expect(html).toContain('-$1,250.50');
    expect(html).toContain(`color:${p.negative}`);
  });
});

describe('buildMonthlyReportHtml — solo / empty handling', () => {
  it('hides partner share, drawings and reconciliation when no partners', () => {
    const html = buildMonthlyReportHtml(baseInput({
      partnerCount: 0, partners: [], drawings: [], partnerShareEach: 0, splitLabel: '',
    }), 'navy_gold');
    expect(html).not.toContain("Profit Share");
    expect(html).not.toContain('Capital Accounts Reconciliation');
    expect(html).not.toContain('CAPITAL WITHDRAWALS THIS PERIOD');
    // Solo still shows the core hero rows.
    expect(html).toContain('Net Profit');
    expect(html).toContain('Profit Before Commission');
  });

  it('omits the commission row when commission is zero and no pct', () => {
    const html = buildMonthlyReportHtml(baseInput({
      commission: 0, commissionPct: 0, partnerCount: 0, partners: [], drawings: [],
    }), 'navy_gold');
    expect(html).not.toContain('Commission (');
  });

  it('shows "None" when there are no liabilities', () => {
    const html = buildMonthlyReportHtml(baseInput({ liabilities: [] }), 'navy_gold');
    expect(html).toContain('None');
  });
});

describe('resolveReportPalette — per-theme accents', () => {
  it('returns a distinct palette per invoice theme, all with a light page', () => {
    for (const t of ['navy_gold', 'amoled_blue', 'emerald', 'minimal'] as const) {
      const p = resolveReportPalette(t);
      expect(p.heroTint).toMatch(/^#/);
      expect(p.heading).toMatch(/^#/);
      // Page stays print-light: builder always uses a cream background.
      const html = buildMonthlyReportHtml(baseInput(), t);
      expect(html).toContain('background: #FBFAF5');
      expect(html).toContain(p.heroTint);
      expect(html).toContain(p.heading);
    }
  });

  it('defaults unknown themes to navy_gold', () => {
    expect(resolveReportPalette('bogus' as any)).toEqual(resolveReportPalette('navy_gold'));
    expect(resolveReportPalette(null)).toEqual(resolveReportPalette('navy_gold'));
  });
});

describe('money()', () => {
  it('formats positive, negative and zero', () => {
    expect(money(1234.5)).toBe('$1,234.50');
    expect(money(-99)).toBe('-$99.00');
    expect(money(0)).toBe('$0.00');
    expect(money(1000, '€')).toBe('€1,000.00');
  });
});

describe('assembleMonthlyReport — pure inputs', () => {
  it('wires journal-derived totals and partner rows without reading settings balances', () => {
    const report = assembleMonthlyReport(
      { periodStart: '2026-07-01', grossProfit: 33684.16, commission: 6063.15, managerCommissionPct: 18 },
      { cash: 37741.17, inventoryValue: 150527.46, assets: 197466.67, liabilities: 42278.57 },
      { investors: [
        { name: 'Amit', contributed: 55124.97, profitShare: 13810.51, drawings: 0, balance: 68935.48 },
        { name: 'Rahim', contributed: 72442.12, profitShare: 13810.51, drawings: 0, balance: 86252.63 },
      ] },
      { currency: 'USD' },
      { periodTitle: 'Jul 2026', savedAt: 'now' },
    );
    expect(report.netProfit).toBeCloseTo(27621.01, 2);
    expect(report.partnerCount).toBe(2);
    expect(report.partners.map((partner) => partner.name)).toEqual(['Amit', 'Rahim']);
    expect(report.totalAssets).toBe(197466.67);
  });
});

describe('monthly-summary screen UI contract', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'monthly-summary.tsx'), 'utf8');

  it('wires the report builder into PDF share and a Print button', () => {
    expect(src).toContain('buildMonthlyReportHtml');
    expect(src).toContain('assembleMonthlyReport');
    expect(src).toContain('printHtml');
    expect(src).toContain('testID="btn-print"');
    expect(src).toContain('testID="btn-share-pdf"');
  });

  it('keeps the plain-text share button working', () => {
    expect(src).toContain('testID="btn-share-text"');
    expect(src).toContain('buildTextSummary');
    expect(src).toContain('Share.share');
  });

  it('renders the mini preview with hero, sections and reconciliation', () => {
    expect(src).toContain('testID="report-preview"');
    expect(src).toContain('testID="report-hero"');
    expect(src).toContain('testID="report-assets"');
    expect(src).toContain('testID="report-liabilities"');
    expect(src).toContain('testID="report-reconciliation"');
  });

  it('resolves the invoice theme for the PDF accents', () => {
    expect(src).toContain('invoiceTheme');
    expect(src).toMatch(/buildMonthlyReportHtml\(report,\s*invoiceTheme\)/);
  });
});
