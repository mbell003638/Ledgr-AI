import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { PayrollDomainService } from '../src/accountingV2/services/payrollDomainService';
import { V2_ACCOUNT_CODES } from '../src/accountingV2/types';

async function setup(bookId = 'payroll_book', enablePayroll = false) {
  const node = makeNodeRunner();
  const boot = await initializeV2Book(node.runner, {
    book: { id: bookId, name: `Book ${bookId}` },
    period: { id: `${bookId}:period:2026`, startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  if (enablePayroll) {
    await node.runner.run("INSERT OR REPLACE INTO settings(key,value) VALUES('main', ?)", [JSON.stringify({ enabledFeatures: ['payroll'] })]);
  }
  const repo = new V2SqlRepository(node.runner);
  const getActiveContext = async (date?: string) => {
    const period = date
      ? await node.runner.first<{ id: string }>(
          "SELECT id FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1",
          [boot.bookId, date, date],
        )
      : await node.runner.first<{ id: string }>(
          "SELECT id FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1",
          [boot.bookId],
        );
    return period ? { bookId: boot.bookId, periodId: period.id } : null;
  };
  return { ...node, repo, payroll: new PayrollDomainService(node.runner, repo, getActiveContext), bookId: boot.bookId };
}

describe('optional payroll domain service', () => {
  it('runPayroll without the feature throws /Turn on payroll/', async () => {
    const { close, payroll } = await setup('book_payroll_off', false);
    try {
      await expect(payroll.runPayroll({ date: '2026-03-15', method: 'cash' })).rejects.toThrow(/Turn on payroll/);
    } finally { close(); }
  });

  it('posts wages, tax payable, and cash, and yearEndSummary 2026 totals match', async () => {
    const { close, runner, payroll, bookId } = await setup('book_payroll_on', true);
    try {
      const employee = await payroll.upsertEmployee({
        name: 'Ada Lovelace',
        role: 'Engineer',
        payRate: 1000,
        taxWithholdPct: 10,
        startDate: '2026-01-01',
      });

      const result = await payroll.runPayroll({ date: '2026-03-15', method: 'cash', notes: 'March payroll' });
      expect(result.source.type).toBe('pay_run');
      expect(result.journal.lines).toEqual([
        { accountId: `${bookId}:account:${V2_ACCOUNT_CODES.WAGES_EXPENSE}`, debit: 1000, credit: 0 },
        { accountId: `${bookId}:account:${V2_ACCOUNT_CODES.CASH}`, debit: 0, credit: 900 },
        { accountId: `${bookId}:account:${V2_ACCOUNT_CODES.PAYROLL_TAX_PAYABLE}`, debit: 0, credit: 100 },
      ]);

      const wages = result.journal.lines.find((line) => line.accountId.endsWith(V2_ACCOUNT_CODES.WAGES_EXPENSE));
      const tax = result.journal.lines.find((line) => line.accountId.endsWith(V2_ACCOUNT_CODES.PAYROLL_TAX_PAYABLE));
      const cash = result.journal.lines.find((line) => line.accountId.endsWith(V2_ACCOUNT_CODES.CASH));
      expect(wages).toMatchObject({ debit: 1000, credit: 0 });
      expect(tax).toMatchObject({ debit: 0, credit: 100 });
      expect(cash).toMatchObject({ debit: 0, credit: 900 });

      expect(result.payslips).toHaveLength(1);
      expect(result.payslips[0]).toMatchObject({
        employeeId: employee.id,
        gross: 1000,
        taxWithheld: 100,
        net: 900,
      });

      const dbLines = await runner.all<{ account_id: string; debit: number; credit: number }>(
        'SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id',
        [result.journal.id],
      );
      expect(dbLines).toEqual([
        { account_id: `${bookId}:account:6200`, debit: 1000, credit: 0 },
        { account_id: `${bookId}:account:1000`, debit: 0, credit: 900 },
        { account_id: `${bookId}:account:2310`, debit: 0, credit: 100 },
      ]);

      const summary = await payroll.yearEndSummary('2026');
      expect(summary.totals).toEqual({ gross: 1000, taxWithheld: 100, net: 900 });
      expect(summary.employees).toEqual([
        { employeeId: employee.id, name: 'Ada Lovelace', gross: 1000, taxWithheld: 100, net: 900 },
      ]);
    } finally { close(); }
  });

  it('throws when there are no employees to pay', async () => {
    const { close, payroll } = await setup('book_payroll_empty', true);
    try {
      await expect(payroll.runPayroll({ date: '2026-03-15', method: 'cash' })).rejects.toThrow(/employee/i);
    } finally { close(); }
  });
});
