import { buildCustomReport, customReportBreakdownRows, summarizeCustomReport, type CustomReportOptions } from '../src/accountingV2/customReports';
import { buildV2Reports } from '../src/accountingV2/reports';
import { defaultAccounts, defaultBook, emptyV2Store } from '../src/accountingV2/schema';

function report() {
  const store = emptyV2Store();
  store.books.push(defaultBook('b', 'Test'));
  store.accounts.push(...defaultAccounts('b'));
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
  return buildV2Reports(store, { bookId: 'b', from: '2026-02-01', to: '2026-02-28' });
}

function openingBreakdownReport() {
  const store = emptyV2Store();
  store.books.push(defaultBook('b', 'Test'));
  store.accounts.push(...defaultAccounts('b'));
  store.sources.push({
    id: 'opening', bookId: 'b', type: 'opening_balance', date: '2026-07-16', metadata: {
      assetBreakdown: [{ name: 'Shop Deposit', amount: 7500 }, { name: 'House Deposit', amount: 750 }],
      partnerCapitals: [{ name: 'Amit', amount: 4000 }, { name: 'Rahim', amount: 4250 }],
    },
  });
  store.journals.push({ id: 'opening-journal', bookId: 'b', periodId: 'p', date: '2026-07-16', memo: 'Opening balances', sourceId: 'opening', lines: [
    { accountId: 'b:account:1500', debit: 8250, credit: 0 },
    { accountId: 'b:account:3000', debit: 0, credit: 8250 },
  ] });
  return buildV2Reports(store, { bookId: 'b' });
}

describe('V2 custom reports', () => {
  it('includes only selected fields and detailed sections', () => {
    const output = buildCustomReport(report(), {
      sections: ['profit', 'sales'], fields: ['date', 'memo', 'amount', 'revenue', 'netProfit'], groupBy: 'none', sortBy: 'date', sortDirection: 'asc',
    });
    expect(output.sections.map((section) => section.id)).toEqual(['profit', 'sales']);
    expect(output.sections[0].fields).toEqual(['revenue', 'netProfit']);
    expect(output.sections[1].rows).toEqual([{ date: '2026-02-01', memo: 'Cash sale', amount: 125 }]);
    expect(JSON.stringify(output)).not.toContain('accountCode');
  });

  it('groups detailed rows and calculates group totals deterministically', () => {
    const options: CustomReportOptions = {
      sections: ['cash'], fields: ['date', 'memo', 'accountName', 'amount'], groupBy: 'month', sortBy: 'amount', sortDirection: 'desc',
    };
    const output = buildCustomReport(report(), options);
    expect(output.sections[0].groups).toEqual([{ key: '2026-02', rows: [
      { date: '2026-02-01', memo: 'Cash sale', accountName: 'Cash in Hand', amount: 125 },
      { date: '2026-02-02', memo: 'Rent', accountName: 'Cash in Hand', amount: -25 },
    ], total: 100 }]);
  });

  it('creates its summary solely and reproducibly from generated output', () => {
    const output = buildCustomReport(report(), { sections: ['profit', 'sales', 'expenses'], fields: ['amount', 'revenue', 'expenses', 'netProfit'], groupBy: 'none' });
    const first = summarizeCustomReport(output);
    expect(first).toContain('Revenue was 125.00');
    expect(first).toContain('net profit was 100.00');
    expect(first).toContain('Sales: 1 item totaling 125.00');
    expect(first).toBe(summarizeCustomReport(JSON.parse(JSON.stringify(output))));
  });

  it('supports consolidated, detailed, and both views whose detail rows exactly reconcile', () => {
    const reports = openingBreakdownReport();
    for (const detailLevel of ['consolidated', 'detailed', 'both'] as const) {
      const output = buildCustomReport(reports, { sections: ['trialBalance', 'balanceSheet', 'members'], fields: ['accountCode', 'accountName', 'debit', 'credit'], groupBy: 'none', detailLevel });
      expect(output.detailLevel).toBe(detailLevel);
      const breakdown = output.sections[0].breakdown || [];
      const deposits = breakdown.find((group) => group.accountCode === '1500')!;
      expect(deposits.items).toEqual([
        expect.objectContaining({ label: 'House Deposit', amount: 750 }),
        expect.objectContaining({ label: 'Shop Deposit', amount: 7500 }),
      ]);
      expect(deposits.total).toBe(8250);
      expect(deposits.difference).toBe(0);
      expect(deposits.reconciled).toBe(true);
      expect(deposits.items.reduce((sum, item) => sum + item.amount, 0)).toBe(deposits.total);
      const rows = customReportBreakdownRows(deposits, detailLevel);
      expect(rows.map((row) => row.kind)).toEqual(detailLevel === 'consolidated' ? ['account'] : detailLevel === 'detailed' ? ['detail', 'detail', 'subtotal'] : ['account', 'detail', 'detail', 'subtotal']);
    }
  });
});
