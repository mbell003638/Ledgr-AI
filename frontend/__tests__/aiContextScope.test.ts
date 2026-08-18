import { scopeAiSnapshot } from '../src/utils/aiContextScope';

const snapshot = {
  source: 'v2',
  currency: 'USD',
  currencySymbol: '$',
  businessName: 'Test Shop',
  snapshot: { cash: 10, netProfit: 4 },
  yearToDate: { revenue: 20 },
  creditors: [{ name: 'Vendor', owed: 5 }],
  debtors: [{ name: 'Customer', owes: 7 }],
  openInvoices: [{ id: 'i1', client: 'Customer' }],
  parties: [{ id: 'p1', name: 'Customer' }],
  capitalAccounts: [{ id: 'm1', name: 'Owner' }],
  expensesByCategory: { Fuel: 2 },
  recentEntries: Array.from({ length: 150 }, (_, i) => ({ id: `e${i}`, notes: `private ${i}` })),
  snapshotTruncated: false,
};

describe('scopeAiSnapshot', () => {
  it('does not send accounting names or entries for app-help questions', () => {
    const scoped = scopeAiSnapshot(snapshot, 'How do I change settings?');
    expect(scoped.contextMode).toBe('app_help');
    expect(scoped.parties).toBeUndefined();
    expect(scoped.recentEntries).toBeUndefined();
    expect(scoped.openInvoices).toBeUndefined();
  });

  it('sends aggregate-only context for financial summary questions', () => {
    const scoped = scopeAiSnapshot(snapshot, 'What was my profit this month?');
    expect(scoped.contextMode).toBe('financial_summary');
    expect(scoped.snapshot.netProfit).toBe(4);
    expect(scoped.parties).toBeUndefined();
    expect(scoped.recentEntries).toBeUndefined();
  });

  it('includes business-account data only for party questions', () => {
    const scoped = scopeAiSnapshot(snapshot, 'Who owes me the most money?');
    expect(scoped.contextMode).toBe('business_accounts');
    expect(scoped.debtors).toHaveLength(1);
    expect(scoped.recentEntries).toBeUndefined();
  });

  it('caps detailed transaction context at 100 entries', () => {
    const scoped = scopeAiSnapshot(snapshot, 'Delete the last expense entry');
    expect(scoped.contextMode).toBe('transaction');
    expect(scoped.recentEntries).toHaveLength(100);
    expect(scoped.snapshotTruncated).toBe(true);
  });
});
