import type { V2Reports, V2ReportDetail } from './reports';

export const CUSTOM_REPORT_SECTIONS = ['trialBalance', 'profit', 'balanceSheet', 'sales', 'purchases', 'receipts', 'expenses', 'cash', 'inventory', 'debtors', 'creditors', 'members', 'tax', 'notes'] as const;
export type CustomReportSectionId = typeof CUSTOM_REPORT_SECTIONS[number];
export const CUSTOM_REPORT_FIELDS = ['date', 'memo', 'reference', 'accountCode', 'accountName', 'partyId', 'debit', 'credit', 'amount', 'revenue', 'expenses', 'netProfit', 'assets', 'liabilities', 'equity'] as const;
export type CustomReportField = typeof CUSTOM_REPORT_FIELDS[number];
export type CustomReportGroup = 'none' | 'day' | 'month' | 'account' | 'party';
export type CustomReportOptions = { sections: CustomReportSectionId[]; fields: CustomReportField[]; groupBy: CustomReportGroup; sortBy?: 'date' | 'amount' | 'account'; sortDirection?: 'asc' | 'desc' };
export type CustomReportRow = Partial<Record<CustomReportField, string | number>>;
export type CustomReportGroupOutput = { key: string; rows: CustomReportRow[]; total: number };
export type CustomReportSection = { id: CustomReportSectionId; title: string; fields: CustomReportField[]; rows: CustomReportRow[]; groups?: CustomReportGroupOutput[]; total?: number };
export type CustomReportOutput = { bookId: string; from?: string; to?: string; sections: CustomReportSection[] };

const labels: Record<CustomReportSectionId, string> = { trialBalance: 'Trial Balance', profit: 'Profit & Loss', balanceSheet: 'Balance Sheet', sales: 'Sales', purchases: 'Purchases', receipts: 'Receipts', expenses: 'Expenses', cash: 'Cash', inventory: 'Inventory & COGS', debtors: 'Debtors', creditors: 'Creditors', members: 'Members', tax: 'Tax', notes: 'Notes' };
const statementFields: Partial<Record<CustomReportSectionId, CustomReportField[]>> = { profit: ['revenue', 'expenses', 'netProfit'], balanceSheet: ['assets', 'liabilities', 'equity'], trialBalance: ['accountCode', 'accountName', 'debit', 'credit'] };

function detailFor(section: CustomReportSectionId, d: V2ReportDetail): boolean {
  switch (section) {
    case 'sales': return d.accountType === 'revenue' && d.credit > 0;
    case 'purchases': return (d.accountCode === '1200' || d.accountCode === '5000') && d.debit > 0;
    case 'receipts': return ['1000', '1010', '1020', '1030'].includes(d.accountCode) && d.debit > 0;
    case 'expenses': return d.accountType === 'expense' && d.debit > 0;
    case 'cash': return ['1000', '1010', '1020', '1030'].includes(d.accountCode);
    case 'inventory': return d.accountCode === '1200' || d.accountCode === '5000';
    case 'debtors': return d.accountCode === '1100';
    case 'creditors': return d.accountCode === '2000';
    case 'members': return ['3000', '3100', '3200'].includes(d.accountCode);
    case 'tax': return /tax|vat|gst/i.test(`${d.accountCode} ${d.accountName}`);
    case 'notes': return Boolean(d.memo);
    default: return false;
  }
}
function amountFor(section: CustomReportSectionId, d: V2ReportDetail): number { return ['sales', 'creditors', 'members'].includes(section) ? d.credit - d.debit : d.debit - d.credit; }
function pickRow(section: CustomReportSectionId, d: V2ReportDetail, fields: CustomReportField[]): CustomReportRow {
  const all: CustomReportRow = { date: d.date, memo: d.memo, reference: d.sourceId || d.journalId, accountCode: d.accountCode, accountName: d.accountName, partyId: d.partyId || 'Unassigned', debit: d.debit, credit: d.credit, amount: amountFor(section, d) };
  return Object.fromEntries(fields.filter((field) => all[field] !== undefined).map((field) => [field, all[field]])) as CustomReportRow;
}
function groupKey(groupBy: CustomReportGroup, row: CustomReportRow): string {
  if (groupBy === 'day') return String(row.date || 'No date');
  if (groupBy === 'month') return String(row.date || 'No date').slice(0, 7);
  if (groupBy === 'account') return String(row.accountName || 'Unassigned');
  return String(row.partyId || 'Unassigned');
}

export function buildCustomReport(report: V2Reports, options: CustomReportOptions): CustomReportOutput {
  const sections = options.sections.map((id): CustomReportSection => {
    const permitted = statementFields[id];
    const fields = options.fields.filter((field) => !permitted || permitted.includes(field));
    let rows: CustomReportRow[];
    if (id === 'profit') rows = [{ revenue: report.profitAndLoss.revenue, expenses: report.profitAndLoss.expenses, netProfit: report.profitAndLoss.netProfit }];
    else if (id === 'balanceSheet') rows = [{ assets: report.balanceSheet.assets, liabilities: report.balanceSheet.liabilities, equity: report.balanceSheet.equity }];
    else if (id === 'trialBalance') rows = report.trialBalance.accounts.map((a) => ({ accountCode: a.code, accountName: a.name, debit: a.debit, credit: a.credit }));
    else rows = report.details.filter((detail) => detailFor(id, detail)).map((detail) => pickRow(id, detail, fields));
    rows = rows.map((row) => Object.fromEntries(fields.filter((field) => row[field] !== undefined).map((field) => [field, row[field]])) as CustomReportRow);
    const direction = options.sortDirection === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      if (options.sortBy === 'amount') return direction * (Number(a.amount || 0) - Number(b.amount || 0));
      const key = options.sortBy === 'account' ? 'accountName' : 'date';
      return direction * String(a[key] || '').localeCompare(String(b[key] || ''));
    });
    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    let groups: CustomReportGroupOutput[] | undefined;
    if (options.groupBy !== 'none') {
      const map = new Map<string, CustomReportRow[]>();
      rows.forEach((row) => { const key = groupKey(options.groupBy, row); map.set(key, [...(map.get(key) || []), row]); });
      groups = [...map].map(([key, grouped]) => ({ key, rows: grouped, total: grouped.reduce((sum, row) => sum + Number(row.amount || 0), 0) }));
    }
    return { id, title: labels[id], fields, rows, groups, total };
  });
  return { bookId: report.bookId, from: report.from, to: report.to, sections };
}

/** Deterministic local explanation derived exclusively from generated output. */
export function summarizeCustomReport(output: CustomReportOutput): string {
  return output.sections.flatMap((section) => {
    const row = section.rows[0] || {};
    if (section.id === 'profit') return [`Revenue was ${Number(row.revenue || 0).toFixed(2)}, expenses were ${Number(row.expenses || 0).toFixed(2)}, and net profit was ${Number(row.netProfit || 0).toFixed(2)}.`];
    if (section.id === 'balanceSheet') return [`Assets were ${Number(row.assets || 0).toFixed(2)}, liabilities ${Number(row.liabilities || 0).toFixed(2)}, and equity ${Number(row.equity || 0).toFixed(2)}.`];
    const count = section.rows.length;
    return [`${section.title}: ${count} item${count === 1 ? '' : 's'} totaling ${Number(section.total || 0).toFixed(2)}.`];
  }).join(' ');
}

export function customReportText(output: CustomReportOutput, includeSummary = true): string {
  const lines = ['Ledgr Custom Report', `Period: ${output.from || 'All time'} to ${output.to || 'All time'}`, 'Source: V2 journal'];
  output.sections.forEach((section) => {
    lines.push('', section.title.toUpperCase());
    const groups = section.groups || [{ key: '', rows: section.rows, total: section.total || 0 }];
    groups.forEach((group) => {
      if (group.key) lines.push(`[${group.key}]`);
      group.rows.forEach((row) => lines.push(section.fields.map((field) => `${field}: ${typeof row[field] === 'number' ? Number(row[field]).toFixed(2) : row[field]}`).join(' | ')));
      if (section.groups) lines.push(`Group total: ${group.total.toFixed(2)}`);
    });
    if (!section.rows.length) lines.push('No entries');
  });
  if (includeSummary) lines.push('', 'SUMMARY', summarizeCustomReport(output));
  return lines.join('\n');
}

export function customReportHtml(output: CustomReportOutput, landscape = false): string {
  const escape = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><style>@page{size:${landscape ? 'landscape' : 'portrait'}}body{font-family:sans-serif;padding:24px;color:#17352a}pre{white-space:pre-wrap;font:13px/1.6 sans-serif}</style></head><body><h1>Ledgr Custom Report</h1><pre>${escape(customReportText(output))}</pre></body></html>`;
}
