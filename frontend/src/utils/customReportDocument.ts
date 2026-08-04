/**
 * Custom Report document builder.
 *
 * Pure, unit-testable HTML builder for the Custom Report screen that renders
 * each selected section in the app's approved report grammar (the same design
 * language as the monthly report in `reportDocument.ts`):
 *
 *   - Profit & Loss  → hero card (Revenue / COGS / Gross Profit / Operating
 *                      Expenses / Net Profit, net large & bold), degrading to
 *                      Revenue / Expenses / Net Profit when only those exist.
 *   - Trial Balance  → a real table: Account (name + muted code) | Debit |
 *                      Credit, monospace tabular numbers, zero rows muted,
 *                      bold totals row tying out Dr/Cr.
 *   - Balance Sheet  → Assets / Liabilities / Equity rows plus a bold
 *                      "Liabilities + Equity" identity row.
 *   - Registers      → date | description | amount rows with hairlines,
 *                      optional group headers + group totals, section total.
 *   - Summary        → a prose paragraph in a tinted card.
 *
 * It replaces the old generic serializer (`customReportText`) that walked row
 * objects and printed pipe-joined "key: value | key: value" dumps.
 *
 * IMPORTANT: keep this file free of any React Native imports so it stays
 * trivially unit-testable in a plain Node/jest environment.
 */

import type { CustomReportOutput, CustomReportRow, CustomReportSection } from '../accountingV2/customReports';
import { escapeHtml, money, resolveReportPalette } from './reportDocument';

// ---------- Shared row derivation (used by BOTH the PDF and the native preview) ----------

export type CustomReportPnl = {
  revenue?: number;
  /** Cost of goods sold — optional; present when the engine provides it. */
  cogs?: number;
  /** revenue − cogs — optional; present when the engine provides it. */
  grossProfit?: number;
  expenses?: number;
  netProfit?: number;
};

export type PnlDisplayRow = { label: string; amount: number; strong?: boolean; net?: boolean };

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(v: number): number { return Math.round(v * 100) / 100; }

/**
 * Derive the P&L hero rows. When the engine provides the full stack
 * (revenue, cogs, grossProfit, netProfit) we render
 * Revenue / COGS / Gross Profit / Operating Expenses (= gross − net) / Net
 * Profit; otherwise we degrade to Revenue / Expenses / Net Profit.
 */
export function buildPnlRows(input: CustomReportPnl | CustomReportRow): PnlDisplayRow[] {
  const pnl = input as Record<string, unknown>;
  const rows: PnlDisplayRow[] = [{ label: 'Revenue', amount: num(pnl.revenue) }];
  if (pnl.cogs !== undefined && pnl.grossProfit !== undefined) {
    rows.push({ label: 'Cost of Goods Sold', amount: num(pnl.cogs) });
    rows.push({ label: 'Gross Profit', amount: num(pnl.grossProfit), strong: true });
    rows.push({ label: 'Operating Expenses', amount: round2(num(pnl.grossProfit) - num(pnl.netProfit)) });
  } else {
    rows.push({ label: 'Expenses', amount: num(pnl.expenses) });
  }
  rows.push({ label: 'Net Profit', amount: num(pnl.netProfit), net: true });
  return rows;
}

/** Dr/Cr totals for a trial-balance section (must tie out on balanced books). */
export function trialBalanceTotals(rows: CustomReportRow[]): { debit: number; credit: number } {
  return {
    debit: round2(rows.reduce((sum, r) => sum + num(r.debit), 0)),
    credit: round2(rows.reduce((sum, r) => sum + num(r.credit), 0)),
  };
}

/** Compact "Dr X · Cr Y" display for a debit/credit pair ("—" when both zero). */
export function drCrLabel(row: CustomReportRow, symbol = '$'): string {
  const parts: string[] = [];
  if (row.debit !== undefined) parts.push(`Dr ${money(num(row.debit), symbol)}`);
  if (row.credit !== undefined) parts.push(`Cr ${money(num(row.credit), symbol)}`);
  return parts.join(' · ') || '—';
}

/** Human description for a register/daybook row (memo → account → party). */
export function registerRowLabel(row: CustomReportRow): string {
  const memo = String(row.memo || '').trim();
  if (memo) return memo;
  const account = String(row.accountName || '').trim();
  if (account) return account;
  const party = String(row.partyId || '').trim();
  return party || 'Entry';
}

/** Right-hand value for a register row: amount when present, else Dr/Cr. */
export function registerRowValue(row: CustomReportRow, symbol = '$'): string {
  if (row.amount !== undefined) return money(num(row.amount), symbol);
  if (row.debit !== undefined || row.credit !== undefined) return drCrLabel(row, symbol);
  return '—';
}

// ---------- Plain-text share format (clean, colon rows — NO pipe dumps) ----------

export type CustomReportShareOptions = { pnl?: CustomReportPnl; summary?: string; currencySymbol?: string };

/** Clean plain-text rendition for Share-as-text (no pipe-joined key:value dumps). */
export function customReportShareText(output: CustomReportOutput, opts: CustomReportShareOptions = {}): string {
  const sym = opts.currencySymbol || '$';
  const lines = ['Ledgr Custom Report', `Period: ${output.from || 'All time'} to ${output.to || 'All time'}`];
  for (const section of output.sections) {
    lines.push('', section.title.toUpperCase());
    if (section.id === 'profit') {
      const row = section.rows[0] || {};
      for (const r of buildPnlRows(opts.pnl || row)) lines.push(`${r.label}: ${money(r.amount, sym)}`);
    } else if (section.id === 'balanceSheet') {
      const row = section.rows[0] || {};
      lines.push(`Assets: ${money(num(row.assets), sym)}`);
      lines.push(`Liabilities: ${money(num(row.liabilities), sym)}`);
      lines.push(`Equity: ${money(num(row.equity), sym)}`);
      lines.push(`Liabilities + Equity: ${money(round2(num(row.liabilities) + num(row.equity)), sym)}`);
    } else if (section.id === 'trialBalance') {
      if (!section.rows.length) { lines.push('No entries'); continue; }
      for (const row of section.rows) {
        const code = row.accountCode !== undefined ? ` (${row.accountCode})` : '';
        lines.push(`${row.accountName || 'Account'}${code}: ${drCrLabel(row, sym)}`);
      }
      const totals = trialBalanceTotals(section.rows);
      lines.push(`Totals: Dr ${money(totals.debit, sym)} · Cr ${money(totals.credit, sym)}`);
    } else {
      const groups = section.groups || [{ key: '', rows: section.rows, total: section.total || 0 }];
      if (!section.rows.length) { lines.push('No entries'); continue; }
      for (const group of groups) {
        if (group.key) lines.push(`[${group.key}]`);
        for (const row of group.rows) {
          const date = row.date ? `${row.date} — ` : '';
          lines.push(`${date}${registerRowLabel(row)}: ${registerRowValue(row, sym)}`);
        }
        if (section.groups) lines.push(`Group total: ${money(group.total, sym)}`);
      }
      if (section.total !== undefined) lines.push(`Total: ${money(num(section.total), sym)}`);
    }
  }
  if (opts.summary) lines.push('', 'SUMMARY', opts.summary);
  return lines.join('\n');
}

// ---------- PDF/print HTML builder ----------

export type CustomReportDocumentInput = {
  output: CustomReportOutput;
  businessName: string;
  /** Period bounds for the header (falls back to output.from/to). */
  from?: string;
  to?: string;
  /** Generated-at display string (defaults to now). */
  generatedAt?: string;
  currencySymbol?: string;
  landscape?: boolean;
  /**
   * Full engine P&L (revenue, cogs, grossProfit, expenses, netProfit) when
   * available; the hero degrades gracefully when only the section row's
   * revenue/expenses/netProfit exist.
   */
  pnl?: CustomReportPnl;
  /** Prose summary paragraph shown in a tinted card. */
  summary?: string;
};

/**
 * Build the print/PDF HTML for the custom report, themed via
 * {@link resolveReportPalette}(invoiceTheme): cream print-light page, per-theme
 * accents, hairline rules, label-left / monospace-value-right rows.
 */
export function buildCustomReportHtml(input: CustomReportDocumentInput, theme?: string | null): string {
  const p = resolveReportPalette(theme);
  const sym = input.currencySymbol || '$';
  const from = input.from || input.output.from || 'All time';
  const to = input.to || input.output.to || 'All time';
  const generated = input.generatedAt || new Date().toLocaleString();

  const numCell = (n: number, cls = '') =>
    `<span class="num${cls ? ` ${cls}` : ''}" style="color:${n < 0 ? p.negative : 'inherit'}">${escapeHtml(money(n, sym))}</span>`;

  const sectionLabel = (title: string) => `<div class="section-label">${escapeHtml(title.toUpperCase())}</div>`;

  const renderProfit = (section: CustomReportSection): string => {
    const rows = buildPnlRows(input.pnl || section.rows[0] || {});
    const body = rows.map((r) => r.net ? `
      <div class="hero-row hero-net">
        <span class="hero-label">${escapeHtml(r.label)}</span>
        <span class="hero-net-value" style="color:${r.amount < 0 ? p.negative : 'inherit'}">${escapeHtml(money(r.amount, sym))}</span>
      </div>` : `
      <div class="hero-row${r.strong ? ' hero-strong' : ''}">
        <span class="hero-label">${escapeHtml(r.label)}</span>
        ${numCell(r.amount)}
      </div>`).join('');
    return `<section class="report-section">${sectionLabel(section.title)}<div class="hero-card">${body}</div></section>`;
  };

  const renderTrialBalance = (section: CustomReportSection): string => {
    if (!section.rows.length) return `<section class="report-section">${sectionLabel(section.title)}<div class="empty">No entries</div></section>`;
    const body = section.rows.map((row) => {
      const zero = num(row.debit) === 0 && num(row.credit) === 0;
      const code = row.accountCode !== undefined ? ` <span class="tb-code">(${escapeHtml(row.accountCode)})</span>` : '';
      return `
        <tr${zero ? ' class="tb-zero"' : ''}>
          <td class="tb-account">${escapeHtml(row.accountName || 'Account')}${code}</td>
          <td class="num">${escapeHtml(money(num(row.debit), sym))}</td>
          <td class="num">${escapeHtml(money(num(row.credit), sym))}</td>
        </tr>`;
    }).join('');
    const totals = trialBalanceTotals(section.rows);
    return `<section class="report-section">${sectionLabel(section.title)}
      <table class="tb-table">
        <thead><tr><th class="tb-account">Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr class="tb-totals"><td class="tb-account">Totals</td><td class="num">${escapeHtml(money(totals.debit, sym))}</td><td class="num">${escapeHtml(money(totals.credit, sym))}</td></tr></tfoot>
      </table>
    </section>`;
  };

  const renderBalanceSheet = (section: CustomReportSection): string => {
    const row = section.rows[0] || {};
    const liabilities = num(row.liabilities);
    const equity = num(row.equity);
    const groups: { label: string; amount: number }[] = [
      { label: 'Assets', amount: num(row.assets) },
      { label: 'Liabilities', amount: liabilities },
      { label: 'Equity', amount: equity },
    ];
    const body = groups.map((g) => `
      <div class="line-row">
        <span class="line-label">${escapeHtml(g.label)}</span>
        ${numCell(g.amount)}
      </div>`).join('');
    return `<section class="report-section">${sectionLabel(section.title)}
      <div class="lines">${body}
        <div class="line-row total-row">
          <span class="line-label total-label">Liabilities + Equity</span>
          <span class="num total-num">${escapeHtml(money(round2(liabilities + equity), sym))}</span>
        </div>
      </div>
    </section>`;
  };

  const renderRegister = (section: CustomReportSection): string => {
    if (!section.rows.length) return `<section class="report-section">${sectionLabel(section.title)}<div class="empty">No entries</div></section>`;
    const rowHtml = (row: CustomReportRow) => `
      <div class="line-row">
        ${row.date !== undefined ? `<span class="reg-date">${escapeHtml(row.date)}</span>` : ''}
        <span class="line-label">${escapeHtml(registerRowLabel(row))}</span>
        <span class="num">${escapeHtml(registerRowValue(row, sym))}</span>
      </div>`;
    const groups = section.groups;
    const body = groups ? groups.map((group) => `
      <div class="reg-group-label">${escapeHtml(group.key)}</div>
      ${group.rows.map(rowHtml).join('')}
      <div class="line-row reg-group-total">
        <span class="line-label">Group total</span>
        <span class="num">${escapeHtml(money(group.total, sym))}</span>
      </div>`).join('') : section.rows.map(rowHtml).join('');
    const total = section.total !== undefined ? `
      <div class="line-row total-row">
        <span class="line-label total-label">Total ${escapeHtml(section.title)}</span>
        <span class="num total-num">${escapeHtml(money(num(section.total), sym))}</span>
      </div>` : '';
    return `<section class="report-section">${sectionLabel(section.title)}<div class="lines">${body}${total}</div></section>`;
  };

  const sectionsHtml = input.output.sections.map((section) => {
    if (section.id === 'profit') return renderProfit(section);
    if (section.id === 'trialBalance') return renderTrialBalance(section);
    if (section.id === 'balanceSheet') return renderBalanceSheet(section);
    return renderRegister(section);
  }).join('\n');

  const summaryHtml = input.summary ? `
  <section class="report-section">
    <div class="summary-card">
      <div class="summary-heading">Summary</div>
      <p class="summary-text">${escapeHtml(input.summary)}</p>
    </div>
  </section>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    @page { size: A4${input.landscape ? ' landscape' : ''}; margin: 18mm 16mm; }
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
    .header { margin-bottom: 22px; }
    .period-title { font-size: 22px; font-weight: 800; margin: 0; color: var(--ink); }
    .period-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .report-section { margin-bottom: 26px; break-inside: avoid; }
    .section-label {
      font-size: 10px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase;
      color: ${p.sectionLabel}; margin-bottom: 8px;
    }
    .hero-card {
      background: ${p.heroTint}; border: 1px solid ${p.heroBorder}; border-radius: 14px;
      padding: 6px 20px;
    }
    .hero-row {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: 13px 0; border-bottom: 1px solid ${p.heroBorder}; gap: 12px;
    }
    .hero-row:last-child { border-bottom: none; }
    .hero-label { font-weight: 700; color: var(--ink); }
    .hero-strong .hero-label, .hero-strong .num { font-weight: 800; }
    .hero-net .hero-label { font-size: 15px; }
    .hero-net-value {
      font-family: 'Courier New', monospace; font-variant-numeric: tabular-nums;
      font-size: 26px; font-weight: 800; text-align: right; letter-spacing: -0.5px;
    }
    .lines { }
    .line-row {
      display: flex; align-items: baseline; justify-content: space-between;
      padding: 9px 0; border-bottom: 1px solid var(--rule); gap: 12px;
    }
    .line-label { color: var(--ink); flex: 1; min-width: 0; }
    .reg-date { color: var(--muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .reg-group-label { color: ${p.heading}; font-weight: 700; font-size: 11px; margin: 12px 0 2px; }
    .reg-group-total .line-label, .reg-group-total .num { font-weight: 700; color: var(--muted); }
    .total-row { border-bottom: none; border-top: 2px solid var(--ink); margin-top: 2px; }
    .total-label { font-weight: 800; }
    .total-num { font-weight: 800; }
    .empty { color: var(--muted); padding: 6px 0; }
    .tb-table { width: 100%; border-collapse: collapse; }
    .tb-table th {
      font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
      color: ${p.sectionLabel}; padding: 6px 0; border-bottom: 2px solid var(--ink); text-align: left;
    }
    .tb-table th.num, .tb-table td.num { text-align: right; }
    .tb-table th.num { padding-left: 18px; }
    .tb-table td { padding: 8px 0 8px 0; border-bottom: 1px solid var(--rule); }
    .tb-table td.num { padding-left: 18px; }
    .tb-account { color: var(--ink); }
    .tb-code { color: var(--muted); font-size: 11px; }
    .tb-zero td, .tb-zero .tb-account { color: var(--muted); }
    .tb-zero td.num { font-weight: 400; }
    .tb-totals td { border-top: 2px solid var(--ink); border-bottom: none; font-weight: 800; }
    .tb-totals td.num { font-weight: 800; }
    .summary-card {
      background: ${p.reconTint}; border: 1px solid ${p.reconBorder}; border-radius: 14px; padding: 18px 22px;
    }
    .summary-heading { color: ${p.heading}; font-weight: 800; font-size: 15px; margin-bottom: 6px; }
    .summary-text { margin: 0; color: var(--ink); line-height: 1.55; }
  </style>
</head>
<body>
  <div class="header">
    <h1 class="period-title">Custom Report</h1>
    <div class="period-sub">${escapeHtml(from)} &ndash; ${escapeHtml(to)} &middot; Generated ${escapeHtml(generated)} &middot; ${escapeHtml(input.businessName || 'Ledgr')}</div>
  </div>

  ${sectionsHtml}
  ${summaryHtml}
</body>
</html>`;
}
