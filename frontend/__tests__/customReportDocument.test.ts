/**
 * Unit tests for the Custom Report document builder.
 *
 * The builder is pure (no RN imports), so we drive it with real engine output
 * (buildV2Reports → buildCustomReport) and assert on the produced HTML: real
 * trial-balance table markup, the P&L hero rows, per-theme accents, graceful
 * empty/zero handling — and, critically, NO generic key:value pipe-joined
 * object dumps anywhere (the bug this builder replaced).
 */

import fs from 'fs';
import path from 'path';
import { buildCustomReport, summarizeCustomReport, CUSTOM_REPORT_FIELDS } from '../src/accountingV2/customReports';
import { buildV2Reports } from '../src/accountingV2/reports';
import { defaultAccounts, defaultBook, emptyV2Store } from '../src/accountingV2/schema';
import { resolveReportPalette, money } from '../src/utils/reportDocument';
import {
  buildCustomReportHtml,
  buildPnlRows,
  customReportShareText,
  trialBalanceTotals,
  type CustomReportPnl,
} from '../src/utils/customReportDocument';

function seededReports(withJournals = true) {
  const store = emptyV2Store();
  store.books.push(defaultBook('b', 'Test'));
  store.accounts.push(...defaultAccounts('b'));
  if (withJournals) {
    store.journals.push(
      { id: 'sale', bookId: 'b', periodId: 'p', date: '2026-02-01', memo: 'Cash sale', sourceId: 's1', lines: [
        { accountId: 'b:account:1000', debit: 125, credit: 0 },
        { accountId: 'b:account:4000', debit: 0, credit: 125 },
      ] },
      { id: 'expense', bookId: 'b', periodId: 'p', date: '2026-02-02', memo: 'Rent', lines: [
        { accountId: 'b:account:6000', debit: 25, credit: 0 },
        { accountId: 'b:account:1000', debit: 0, credit: 25 },
      ] },
    );
  }
  return buildV2Reports(store, { bookId: 'b', from: '2026-02-01', to: '2026-02-28' });
}

function seededDoc(withJournals = true) {
  const reports = seededReports(withJournals);
  const output = buildCustomReport(reports, {
    sections: ['trialBalance', 'profit', 'balanceSheet', 'sales'],
    fields: [...CUSTOM_REPORT_FIELDS], groupBy: 'none', sortBy: 'date', sortDirection: 'asc',
  });
  const pnl: CustomReportPnl = { ...reports.profitAndLoss };
  return { output, pnl, summary: summarizeCustomReport(output) };
}

const baseInput = (withJournals = true) => {
  const { output, pnl, summary } = seededDoc(withJournals);
  return { output, pnl, summary, businessName: 'Acme Traders', currencySymbol: '$', generatedAt: '8/3/2026, 9:00:00 AM' };
};

function detailedOpeningInput() {
  const store = emptyV2Store();
  store.books.push(defaultBook('b', 'Test'));
  store.accounts.push(...defaultAccounts('b'));
  store.sources.push({ id: 'opening', bookId: 'b', type: 'opening_balance', date: '2026-07-16', metadata: {
    assetBreakdown: [{ name: 'Shop Deposit', amount: 7500 }, { name: 'House Deposit', amount: 750 }],
    partnerCapitals: [{ name: 'Amit', amount: 4000 }, { name: 'Rahim', amount: 4250 }],
  } });
  store.journals.push({ id: 'opening-journal', bookId: 'b', periodId: 'p', date: '2026-07-16', memo: 'Opening balances', sourceId: 'opening', lines: [
    { accountId: 'b:account:1500', debit: 8250, credit: 0 },
    { accountId: 'b:account:3000', debit: 0, credit: 8250 },
  ] });
  const reports = buildV2Reports(store, { bookId: 'b' });
  const output = buildCustomReport(reports, { sections: ['trialBalance', 'balanceSheet', 'members'], fields: [...CUSTOM_REPORT_FIELDS], groupBy: 'none', detailLevel: 'both' });
  return { output, businessName: 'Acme Traders', currencySymbol: '$' };
}

describe('buildCustomReportHtml — trial balance table', () => {
  const html = buildCustomReportHtml(baseInput(), 'navy_gold');

  it('renders a real table with Account/Debit/Credit columns', () => {
    expect(html).toContain('<table');
    expect(html).toContain('<thead>');
    expect(html).toContain('>Account<');
    expect(html).toContain('>Debit<');
    expect(html).toContain('>Credit<');
  });

  it('shows account names with muted codes and monospace numbers', () => {
    expect(html).toContain('Cash in Hand');
    expect(html).toContain('(1000)');
    expect(html).toContain('tb-code');
    expect(html).toContain("'Courier New'");
  });

  it('keeps zero rows present but de-emphasized', () => {
    // Seeded book only touches 1000/4000/6000 — other default accounts are zero.
    expect(html).toContain('tb-zero');
  });

  it('renders a bold totals row whose Dr/Cr tie out', () => {
    const { output } = seededDoc();
    const tb = output.sections.find((s) => s.id === 'trialBalance')!;
    const totals = trialBalanceTotals(tb.rows);
    expect(totals.debit).toBe(150);
    expect(totals.credit).toBe(150);
    expect(html).toContain('tb-totals');
    expect(html).toContain('Totals');
    expect(html).toContain(money(totals.debit)); // $150.00 appears in the tfoot
  });
});

describe('buildCustomReportHtml — P&L hero', () => {
  it('renders the full Revenue/COGS/Gross/Operating/Net stack when the engine provides it', () => {
    const html = buildCustomReportHtml(baseInput(), 'navy_gold');
    expect(html).toContain('Revenue');
    expect(html).toContain('Cost of Goods Sold');
    expect(html).toContain('Gross Profit');
    expect(html).toContain('Operating Expenses');
    expect(html).toContain('Net Profit');
    expect(html).toContain('hero-net-value'); // net large & bold
    expect(html).toContain('$125.00'); // revenue
    expect(html).toContain('$100.00'); // net profit
  });

  it('degrades gracefully when only revenue/expenses/netProfit exist', () => {
    // Profit section only (no trial balance, whose 5000 account is literally
    // named "Cost of Goods Sold"), and no engine pnl enrichment — the hero
    // falls back to the section row's revenue/expenses/netProfit.
    const output = buildCustomReport(seededReports(), {
      sections: ['profit'], fields: [...CUSTOM_REPORT_FIELDS], groupBy: 'none',
    });
    const html = buildCustomReportHtml({ output, businessName: 'Acme Traders' }, 'navy_gold');
    expect(html).not.toContain('Cost of Goods Sold');
    expect(html).not.toContain('Operating Expenses');
    expect(html).toContain('Revenue');
    expect(html).toContain('Expenses');
    expect(html).toContain('Net Profit');
  });

  it('buildPnlRows derives operating expenses as gross − net', () => {
    const rows = buildPnlRows({ revenue: 200, cogs: 60, grossProfit: 140, expenses: 100, netProfit: 100 });
    expect(rows.map((r) => r.label)).toEqual(['Revenue', 'Cost of Goods Sold', 'Gross Profit', 'Operating Expenses', 'Net Profit']);
    expect(rows.find((r) => r.label === 'Operating Expenses')!.amount).toBe(40);
    expect(rows[rows.length - 1].net).toBe(true);
  });
});

describe('buildCustomReportHtml — balance sheet, registers, summary, header', () => {
  const html = buildCustomReportHtml(baseInput(), 'navy_gold');

  it('groups Assets / Liabilities / Equity with a bold identity row', () => {
    expect(html).toContain('Assets');
    expect(html).toContain('Liabilities');
    expect(html).toContain('Equity');
    expect(html).toContain('Liabilities + Equity');
    expect(html).toContain('total-row');
  });

  it('renders register rows with date, description and amount', () => {
    expect(html).toContain('2026-02-01');
    expect(html).toContain('Cash sale');
    expect(html).toContain('reg-date');
    expect(html).toContain('Total Sales');
  });

  it('renders the summary as prose in a tinted card', () => {
    expect(html).toContain('summary-card');
    expect(html).toContain('Revenue was 125.00');
  });

  it('renders the header chrome: title, period, generated-at, business name', () => {
    expect(html).toContain('Custom Report');
    expect(html).toContain('2026-02-01');
    expect(html).toContain('2026-02-28');
    expect(html).toContain('Generated 8/3/2026, 9:00:00 AM');
    expect(html).toContain('Acme Traders');
    expect(html).toContain('@page');
  });

  it('supports landscape A4', () => {
    const html2 = buildCustomReportHtml({ ...baseInput(), landscape: true }, 'navy_gold');
    expect(html2).toContain('A4 landscape');
  });

  it('renders individual opening balances and their reconciled account subtotal in Both mode', () => {
    const html = buildCustomReportHtml(detailedOpeningInput(), 'navy_gold');
    expect(html).toContain('Other Assets &amp; Deposits');
    expect(html).toContain('Shop Deposit');
    expect(html).toContain('House Deposit');
    expect(html).toContain('Reconciled subtotal');
    expect(html).toContain('$8,250.00');
  });
});

describe('buildCustomReportHtml — NO generic object dumps', () => {
  it('never emits raw field names or pipe-joined key:value rows', () => {
    const html = buildCustomReportHtml(baseInput(), 'navy_gold');
    expect(html).not.toContain('accountCode');
    expect(html).not.toContain('accountName:');
    expect(html).not.toContain('netProfit:');
    expect(html).not.toMatch(/\w+: [\d.]+ \| \w+:/); // "debit: 100.00 | credit: 0.00"
    expect(html).not.toContain(' | ');
  });

  it('share text is clean label:value lines with tied-out totals — no pipes', () => {
    const { output, pnl, summary } = seededDoc();
    const text = customReportShareText(output, { pnl, summary });
    expect(text).not.toContain('|');
    expect(text).not.toContain('accountCode');
    expect(text).toContain('Cash in Hand (1000): Dr $125.00 · Cr $25.00');
    expect(text).toContain('Totals: Dr $150.00 · Cr $150.00');
    expect(text).toContain('Net Profit: $100.00');
    expect(text).toContain('Liabilities + Equity:');
    expect(text).toContain('SUMMARY');
  });
});

describe('buildCustomReportHtml — themes and empty/zero books', () => {
  it('applies per-theme accents on a print-light cream page', () => {
    for (const t of ['navy_gold', 'amoled_blue', 'emerald', 'minimal'] as const) {
      const p = resolveReportPalette(t);
      const html = buildCustomReportHtml(baseInput(), t);
      expect(html).toContain('background: #FBFAF5');
      expect(html).toContain(p.heroTint);
      expect(html).toContain(p.reconTint);
      expect(html).toContain(p.sectionLabel);
    }
  });

  it('stays composed on an all-zero book: muted zero rows, $0.00 hero, No entries', () => {
    const html = buildCustomReportHtml(baseInput(false), 'navy_gold');
    expect(html).toContain('tb-zero');
    expect(html).toContain('$0.00');
    expect(html).toContain('Net Profit');
    expect(html).toContain('No entries'); // empty sales register
    expect(html).not.toContain(' | ');
  });
});

describe('custom-report screen UI contract', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'custom-report.tsx'), 'utf8');

  it('wires the new document builder into PDF share and Print', () => {
    expect(src).toContain('buildCustomReportHtml');
    expect(src).toContain('printHtml');
    expect(src).toContain('customReportShareText');
    expect(src).toContain('testID="btn-custom-print"');
    expect(src).toContain('testID="btn-custom-share-pdf"');
    expect(src).toContain('testID="btn-custom-share-text"');
  });

  it('no longer uses the generic pipe serializer for preview or PDF', () => {
    expect(src).not.toMatch(/\bcustomReportText\b/);
    expect(src).not.toContain("split('|')");
    expect(src).not.toContain("' | '");
  });

  it('renders the structured mini preview in the approved report grammar', () => {
    expect(src).toContain('testID="custom-report-preview"');
    expect(src).toContain('testID="custom-report-hero"');
    expect(src).toContain('testID="custom-report-trial-balance"');
    expect(src).toContain('testID="custom-report-balance-sheet"');
    expect(src).toContain('testID="custom-report-summary"');
    expect(src).toContain('buildPnlRows');
    expect(src).toContain('trialBalanceTotals');
    expect(src).toContain('drCrLabel');
  });

  it('themes the PDF via the settings invoice theme', () => {
    expect(src).toContain('invoiceTheme');
    expect(src).toMatch(/buildCustomReportHtml\(\{/);
  });
});
