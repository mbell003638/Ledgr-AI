import { partnershipDisplayFromReports, type V2Reports, type V2ReportDetail } from './reports';

export const CUSTOM_REPORT_SECTIONS = ['trialBalance', 'profit', 'balanceSheet', 'sales', 'purchases', 'receipts', 'expenses', 'cash', 'inventory', 'debtors', 'creditors', 'members', 'tax', 'notes'] as const;
export type CustomReportSectionId = typeof CUSTOM_REPORT_SECTIONS[number];
export const CUSTOM_REPORT_FIELDS = ['date', 'memo', 'reference', 'accountCode', 'accountName', 'partyId', 'debit', 'credit', 'amount', 'revenue', 'expenses', 'netProfit', 'assets', 'liabilities', 'equity'] as const;
export type CustomReportField = typeof CUSTOM_REPORT_FIELDS[number];
export type CustomReportGroup = 'none' | 'day' | 'month' | 'account' | 'party';
export type CustomReportDetailLevel = 'consolidated' | 'detailed' | 'both';
export type CustomReportOptions = { sections: CustomReportSectionId[]; fields: CustomReportField[]; groupBy: CustomReportGroup; detailLevel?: CustomReportDetailLevel; sortBy?: 'date' | 'amount' | 'account'; sortDirection?: 'asc' | 'desc'; commissionPct?: number };
export type CustomReportRow = Partial<Record<CustomReportField, string | number>>;
export type CustomReportGroupOutput = { key: string; rows: CustomReportRow[]; total: number };
export type CustomReportBreakdownItem = { label: string; debit: number; credit: number; amount: number };
export type CustomReportBreakdown = { accountCode: string; accountName: string; accountType: string; debit: number; credit: number; total: number; items: CustomReportBreakdownItem[]; difference: number; reconciled: boolean };
export type CustomReportBreakdownDisplayRow = { kind: 'account' | 'detail' | 'subtotal'; label: string; accountCode?: string; debit: number; credit: number; amount: number; reconciled?: boolean };
export type CustomReportSection = { id: CustomReportSectionId; title: string; fields: CustomReportField[]; rows: CustomReportRow[]; groups?: CustomReportGroupOutput[]; breakdown?: CustomReportBreakdown[]; total?: number };
export type CustomReportOutput = { bookId: string; from?: string; to?: string; detailLevel: CustomReportDetailLevel; sections: CustomReportSection[] };

const labels: Record<CustomReportSectionId, string> = { trialBalance: 'Trial Balance', profit: 'Profit & Loss', balanceSheet: 'Balance Sheet', sales: 'Sales', purchases: 'Purchases', receipts: 'Receipts', expenses: 'Expenses', cash: 'Cash', inventory: 'Inventory & COGS', debtors: 'Customers', creditors: 'Suppliers', members: 'Capital Statement', tax: 'Tax', notes: 'Notes' };
const statementFields: Partial<Record<CustomReportSectionId, CustomReportField[]>> = { profit: ['revenue', 'expenses', 'netProfit'], balanceSheet: ['assets', 'liabilities', 'equity'], trialBalance: ['accountCode', 'accountName', 'debit', 'credit'] };
const detailCodesBySection: Partial<Record<CustomReportSectionId, string[]>> = {
  trialBalance: ['1100', '1210', '1400', '1450', '1500', '2000', '2100', '2310', '2500', '3000', '3100', '3200'],
  balanceSheet: ['1100', '1210', '1400', '1450', '1500', '2000', '2100', '2310', '2500', '3000', '3100', '3200'],
  debtors: ['1100', '2100'],
  creditors: ['1210', '2000'],
  members: ['3000', '3100', '3200'],
};

const cents = (value: number) => Math.round(value * 100) / 100;
const normalizeLabel = (value: unknown) => String(value || '').trim().replace(/\s+/g, ' ');

function splitOpeningDetail(detail: V2ReportDetail): { label: string; amount: number }[] | null {
  const metadata: any = detail.sourceMetadata || {};
  const normal = detail.accountType === 'asset' || detail.accountType === 'expense' ? cents(detail.debit - detail.credit) : cents(detail.credit - detail.debit);
  let raw: any[] = [];
  if (detail.accountCode === '1500') raw = Array.isArray(metadata.assetBreakdown) ? metadata.assetBreakdown : [];
  else if (detail.accountCode === '2000') raw = (Array.isArray(metadata.liabilityBreakdown) ? metadata.liabilityBreakdown : []).filter((item: any) => item?.type === 'creditor');
  else if (detail.accountCode === '2500') raw = (Array.isArray(metadata.liabilityBreakdown) ? metadata.liabilityBreakdown : []).filter((item: any) => item?.type !== 'creditor');
  else if (detail.accountCode === '3000') raw = Array.isArray(metadata.partnerCapitals) ? metadata.partnerCapitals : [];
  if (!raw.length) return null;
  // Accounts payable opening rows may already be posted one supplier at a time.
  // Preserve that exact identity instead of re-allocating every row across the
  // entire liability breakdown stored on the shared opening source.
  if (detail.accountCode === '2000') {
    const identity = normalizeLabel(detail.partyName || detail.memo).toLocaleLowerCase();
    const matched = raw.find((item) => normalizeLabel(item?.name).toLocaleLowerCase() === identity);
    if (matched) return [{ label: normalizeLabel(matched.name), amount: normal }];
  }
  const components = raw.map((item) => ({ label: normalizeLabel(item?.name), weight: Math.abs(Number(item?.amount || 0)) })).filter((item) => item.label && item.weight > 0);
  const weightTotal = components.reduce((sum, item) => sum + item.weight, 0);
  if (!weightTotal) return null;
  let allocated = 0;
  return components.map((item, index) => {
    const amount = index === components.length - 1 ? cents(normal - allocated) : cents(normal * item.weight / weightTotal);
    allocated = cents(allocated + amount);
    return { label: item.label, amount };
  });
}

function detailLabel(detail: V2ReportDetail): string {
  const metadata: any = detail.sourceMetadata || {};
  return normalizeLabel(detail.partyName || metadata.memberName || metadata.name || metadata.clientName || metadata.supplierName || detail.memo || detail.partyId) || 'Unassigned activity';
}

function debitCreditForNormal(accountType: string, amount: number) {
  const debitNormal = accountType === 'asset' || accountType === 'expense';
  if (debitNormal) return amount >= 0 ? { debit: amount, credit: 0 } : { debit: 0, credit: Math.abs(amount) };
  return amount >= 0 ? { debit: 0, credit: amount } : { debit: Math.abs(amount), credit: 0 };
}

export function buildCustomReportBreakdown(report: V2Reports, codes: string[]): CustomReportBreakdown[] {
  const selected = new Set(codes);
  return report.trialBalance.accounts.filter((account) => selected.has(account.code)).map((account) => {
    const byLabel = new Map<string, CustomReportBreakdownItem>();
    for (const detail of report.details.filter((item) => item.accountCode === account.code)) {
      const split = detail.sourceType === 'opening_balance' ? splitOpeningDetail(detail) : null;
      const parts = split || [{ label: detailLabel(detail), amount: account.type === 'asset' || account.type === 'expense' ? cents(detail.debit - detail.credit) : cents(detail.credit - detail.debit) }];
      for (const part of parts) {
        const key = part.label.toLocaleLowerCase();
        const dc = split ? debitCreditForNormal(account.type, part.amount) : { debit: detail.debit, credit: detail.credit };
        const current = byLabel.get(key) || { label: part.label, debit: 0, credit: 0, amount: 0 };
        current.debit = cents(current.debit + dc.debit);
        current.credit = cents(current.credit + dc.credit);
        current.amount = cents(account.type === 'asset' || account.type === 'expense' ? current.debit - current.credit : current.credit - current.debit);
        byLabel.set(key, current);
      }
    }
    const items = [...byLabel.values()].filter((item) => item.debit || item.credit).sort((a, b) => a.label.localeCompare(b.label));
    const itemTotal = cents(items.reduce((sum, item) => sum + item.amount, 0));
    const total = cents(account.normalBalance);
    const difference = cents(total - itemTotal);
    return { accountCode: account.code, accountName: account.name, accountType: account.type, debit: account.debit, credit: account.credit, total, items, difference, reconciled: Math.abs(difference) <= 0.005 };
  }).filter((group) => group.debit || group.credit || group.items.length);
}

export function customReportBreakdownRows(group: CustomReportBreakdown, detailLevel: CustomReportDetailLevel): CustomReportBreakdownDisplayRow[] {
  const account = { kind: 'account' as const, label: group.accountName, accountCode: group.accountCode, debit: group.debit, credit: group.credit, amount: group.total };
  if (detailLevel === 'consolidated' || !group.items.length) return [account];
  const details = group.items.map((item) => ({ kind: 'detail' as const, label: item.label, debit: item.debit, credit: item.credit, amount: item.amount }));
  const subtotal = { kind: 'subtotal' as const, label: detailLevel === 'both' ? 'Reconciled subtotal' : `${group.accountName} total`, accountCode: group.accountCode, debit: group.debit, credit: group.credit, amount: group.total, reconciled: group.reconciled };
  return detailLevel === 'both' ? [account, ...details, subtotal] : [...details, subtotal];
}

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
  const all: CustomReportRow = { date: d.date, memo: d.memo, reference: d.sourceId || d.journalId, accountCode: d.accountCode, accountName: d.accountName, partyId: d.partyName || d.partyId || 'Unassigned', debit: d.debit, credit: d.credit, amount: amountFor(section, d) };
  return Object.fromEntries(fields.filter((field) => all[field] !== undefined).map((field) => [field, all[field]])) as CustomReportRow;
}
function groupKey(groupBy: CustomReportGroup, row: CustomReportRow): string {
  if (groupBy === 'day') return String(row.date || 'No date');
  if (groupBy === 'month') return String(row.date || 'No date').slice(0, 7);
  if (groupBy === 'account') return String(row.accountName || 'Unassigned');
  return String(row.partyId || 'Unassigned');
}

export function buildCustomReport(report: V2Reports, options: CustomReportOptions): CustomReportOutput {
  const detailLevel = options.detailLevel || 'consolidated';
  const sections = options.sections.map((id): CustomReportSection => {
    const permitted = statementFields[id];
    const fields = options.fields.filter((field) => !permitted || permitted.includes(field));
    let rows: CustomReportRow[];
    if (id === 'profit') {
      const display = partnershipDisplayFromReports(report, Number(options.commissionPct || 0));
      rows = [{ revenue: display.revenue, expenses: display.operatingExpenses + display.commission, netProfit: display.netProfit }];
    }
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
    const breakdown = detailCodesBySection[id] ? buildCustomReportBreakdown(report, detailCodesBySection[id]!) : undefined;
    return { id, title: labels[id], fields, rows, groups, breakdown, total };
  });
  return { bookId: report.bookId, from: report.from, to: report.to, detailLevel, sections };
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
