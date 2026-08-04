export type V2BookStyle = 'standard' | 'simple_cash' | 'retail_partnership' | 'custom';
export type V2Basis = 'cash' | 'accrual';
export type V2PartyRole = 'customer' | 'supplier';
export type V2AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type V2PaymentMethod = 'cash' | 'bank' | 'card' | 'mobile' | 'other';

export type V2Book = { id: string; name: string; style: V2BookStyle; basis: V2Basis; createdAt: string };
export type V2Party = { id: string; bookId: string; name: string; phone?: string; email?: string; roles: V2PartyRole[]; archived?: boolean };
export type V2Account = { id: string; bookId: string; code: string; name: string; type: V2AccountType; paymentMethod?: V2PaymentMethod; active: boolean };
export type V2JournalLine = { accountId: string; partyId?: string; debit: number; credit: number; memo?: string };
export type V2JournalEntry = { id: string; bookId: string; periodId: string; sourceId?: string; date: string; memo: string; lines: V2JournalLine[]; reversalOf?: string };
export type V2Source = { id: string; bookId: string; type: string; date: string; reference?: string; metadata?: Record<string, unknown> };
export type V2Period = { id: string; bookId: string; startDate: string; endDate: string; status: 'open' | 'closed'; closeSnapshot?: Record<string, unknown> };
export type V2Member = { id: string; bookId: string; name: string; openingContribution: number; profitSharePct: number };
export type V2Allocation = { id: string; bookId: string; invoiceSourceId: string; receiptSourceId: string; amount: number; allocatedAt: string };

export const V2_COLLECTIONS = [
  'v2_books', 'v2_personas', 'v2_parties', 'v2_accounts', 'v2_periods',
  'v2_sources', 'v2_journal_entries', 'v2_journal_lines', 'v2_invoice_allocations',
  'v2_inventory_counts', 'v2_members', 'v2_close_books',
] as const;
export type V2Collection = typeof V2_COLLECTIONS[number];

export const V2_ACCOUNT_CODES = {
  CASH: '1000', BANK: '1010', CARD: '1020', MOBILE: '1030', AR: '1100', INVENTORY: '1200', SUPPLIER_ADVANCES: '1210', OTHER_ASSETS: '1500',
  AP: '2000', CUSTOMER_ADVANCES: '2100', COMMISSION_PAYABLE: '2200', OTHER_LIABILITIES: '2500', CAPITAL: '3000', DRAWINGS: '3100', CURRENT_PROFIT: '3200', RETAINED_EARNINGS: '3300', OWNER_CONTRIBUTIONS: '3400',
  SALES: '4000', SALES_RETURNS: '4010', COGS: '5000', EXPENSES: '6000', COMMISSION_EXPENSE: '6100',
} as const;
