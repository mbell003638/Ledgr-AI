import type { V2Account, V2AccountType, V2Book, V2BookStyle, V2Collection, V2JournalEntry, V2JournalLine, V2Party, V2PartyRole } from './types';

export const V2_SCHEMA_VERSION = 1;

export function v2TableNames(): V2Collection[] { return [
  'v2_books', 'v2_personas', 'v2_parties', 'v2_accounts', 'v2_periods', 'v2_sources',
  'v2_journal_entries', 'v2_journal_lines', 'v2_invoice_allocations', 'v2_inventory_counts', 'v2_members', 'v2_close_books',
]; }

export type V2MemoryStore = {
  books: V2Book[];
  parties: V2Party[];
  accounts: V2Account[];
  journals: V2JournalEntry[];
  sources: { id: string; bookId: string; type: string; date: string; reference?: string; metadata?: Record<string, unknown> }[];
  allocations: { id: string; bookId: string; invoiceSourceId: string; receiptSourceId: string; amount: number; allocatedAt: string }[];
};

export function emptyV2Store(): V2MemoryStore {
  return { books: [], parties: [], accounts: [], journals: [], sources: [], allocations: [] };
}

export function validLine(line: V2JournalLine): boolean {
  return Number.isFinite(line.debit) && Number.isFinite(line.credit) && line.debit >= 0 && line.credit >= 0 && !(line.debit > 0 && line.credit > 0) && (line.debit > 0 || line.credit > 0);
}

export function journalTotals(lines: V2JournalLine[]) {
  return lines.reduce((x, l) => ({ debit: x.debit + l.debit, credit: x.credit + l.credit }), { debit: 0, credit: 0 });
}

export function isBalanced(lines: V2JournalLine[], tolerance = 0.005): boolean {
  if (!lines.length || lines.some((l) => !validLine(l))) return false;
  const t = journalTotals(lines);
  return Math.abs(t.debit - t.credit) <= tolerance;
}

export function defaultAccounts(bookId: string): V2Account[] {
  const defs: [string, string, V2AccountType][] = [
    ['1000', 'Cash in Hand', 'asset'], ['1010', 'Bank', 'asset'], ['1020', 'Card Clearing', 'asset'], ['1030', 'Mobile Payments', 'asset'],
    ['1100', 'Accounts Receivable', 'asset'], ['1200', 'Inventory', 'asset'], ['2000', 'Accounts Payable', 'liability'],
    ['2100', 'Customer Advances', 'liability'], ['2200', 'Commission Payable', 'liability'], ['3000', 'Member Capital', 'equity'], ['3100', 'Member Drawings', 'equity'], ['3200', 'Current Profit', 'equity'],
    ['4000', 'Sales Revenue', 'revenue'], ['4010', 'Sales Returns', 'revenue'], ['5000', 'Cost of Goods Sold', 'expense'], ['6000', 'Operating Expenses', 'expense'], ['6100', 'Commission Expense', 'expense'],
  ];
  return defs.map(([code, name, type]) => ({ id: `${bookId}:account:${code}`, bookId, code, name, type, active: true }));
}

export function defaultBook(id: string, name: string, style: V2BookStyle = 'standard'): V2Book {
  return { id, name, style, basis: 'accrual', createdAt: new Date().toISOString() };
}

export function normalizePartyRoles(roles: V2PartyRole[] | undefined): V2PartyRole[] {
  return [...new Set((roles || []).filter((r): r is V2PartyRole => r === 'customer' || r === 'supplier'))];
}
