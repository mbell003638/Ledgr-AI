import { buildCustomReport, summarizeCustomReport, type CustomReportOptions } from '../src/accountingV2/customReports';
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
});
