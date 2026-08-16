import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { isOptionalModuleEnabled, requireOptionalModule } from '../optionalModules';
import { V2_ACCOUNT_CODES, type V2JournalEntry, type V2Source } from '../types';
import { round2 } from '../../money';

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cents = round2;

type EmployeeRow = {
  id: string;
  book_id: string;
  name: string;
  role: string | null;
  pay_rate: number;
  tax_withhold_pct: number;
  start_date: string | null;
  archived: number;
};

type PayRunRow = {
  id: string;
  book_id: string;
  period_id: string;
  date: string;
  notes: string | null;
  source_id: string | null;
};

type PayslipRow = {
  id: string;
  pay_run_id: string;
  employee_id: string;
  employee_name?: string | null;
  gross: number;
  tax_withheld: number;
  net: number;
  notes: string | null;
};

export type PayrollEmployee = {
  id: string;
  bookId: string;
  name: string;
  role: string | null;
  payRate: number;
  taxWithholdPct: number;
  startDate: string | null;
  archived: boolean;
};

export type PayrollEmployeeInput = {
  id?: string;
  name: string;
  role?: string;
  payRate: number;
  taxWithholdPct: number;
  startDate?: string;
};

export type PayrollRunInput = {
  date: string;
  method: 'cash' | 'bank';
  employeeIds?: string[];
  notes?: string;
};

export type PayrollPayRun = {
  id: string;
  bookId: string;
  periodId: string;
  date: string;
  notes: string;
  sourceId: string | null;
};

export type PayrollPayslip = {
  id: string;
  payRunId: string;
  employeeId: string;
  employeeName?: string;
  gross: number;
  taxWithheld: number;
  net: number;
  notes: string;
};

export type PayrollYearEndEmployee = {
  employeeId: string;
  name: string;
  gross: number;
  taxWithheld: number;
  net: number;
};

export type PayrollYearEndSummary = {
  year: string;
  employees: PayrollYearEndEmployee[];
  totals: { gross: number; taxWithheld: number; net: number };
};

export class PayrollDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    private readonly getActiveContext: (date?: string) => Promise<{ bookId: string; periodId: string } | null>,
  ) {}

  async listEmployees(): Promise<PayrollEmployee[]> {
    const context = await this.getActiveContext();
    if (!context) return [];
    const rows = await this.db.all<EmployeeRow>(
      'SELECT id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived FROM v2_employees WHERE book_id=? ORDER BY archived, name, id',
      [context.bookId],
    );
    return rows.map(mapEmployee);
  }

  async upsertEmployee(input: PayrollEmployeeInput): Promise<PayrollEmployee> {
    const context = await this.getActiveContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    await this.requirePayroll(context.bookId);
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Employee name is required');
    const payRate = cents(input.payRate);
    if (!Number.isFinite(payRate) || payRate < 0) throw new Error('Pay rate must be a non-negative amount');
    const taxWithholdPct = Number(input.taxWithholdPct);
    if (!Number.isFinite(taxWithholdPct) || taxWithholdPct < 0 || taxWithholdPct > 100) {
      throw new Error('Tax withhold percent must be between 0 and 100');
    }
    const role = String(input.role || '').trim() || null;
    const startDate = String(input.startDate || '').trim() || null;
    const existingId = input.id ? String(input.id) : '';
    if (existingId) {
      const existing = await this.db.first<EmployeeRow>(
        'SELECT id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived FROM v2_employees WHERE id=? AND book_id=?',
        [existingId, context.bookId],
      );
      if (existing) {
        await this.db.run(
          'UPDATE v2_employees SET name=?, role=?, pay_rate=?, tax_withhold_pct=?, start_date=? WHERE id=? AND book_id=?',
          [name, role, payRate, taxWithholdPct, startDate, existingId, context.bookId],
        );
        return mapEmployee({ ...existing, name, role, pay_rate: payRate, tax_withhold_pct: taxWithholdPct, start_date: startDate });
      }
    }
    const id = existingId || uid('emp');
    await this.db.run(
      'INSERT INTO v2_employees(id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived) VALUES(?,?,?,?,?,?,?,0)',
      [id, context.bookId, name, role, payRate, taxWithholdPct, startDate],
    );
    return {
      id,
      bookId: context.bookId,
      name,
      role,
      payRate,
      taxWithholdPct,
      startDate,
      archived: false,
    };
  }

  async archiveEmployee(id: string): Promise<PayrollEmployee> {
    const context = await this.getActiveContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    await this.requirePayroll(context.bookId);
    const existing = await this.db.first<EmployeeRow>(
      'SELECT id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived FROM v2_employees WHERE id=? AND book_id=?',
      [id, context.bookId],
    );
    if (!existing) throw new Error('Employee not found');
    await this.db.run('UPDATE v2_employees SET archived=1 WHERE id=? AND book_id=?', [id, context.bookId]);
    return mapEmployee({ ...existing, archived: 1 });
  }

  async runPayroll(input: PayrollRunInput): Promise<{
    payRun: PayrollPayRun;
    payslips: PayrollPayslip[];
    source: V2Source;
    journal: V2JournalEntry;
  }> {
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    await this.requirePayroll(context.bookId);
    if (input.method !== 'cash' && input.method !== 'bank') throw new Error('Payroll method must be cash or bank');

    const employees = await this.loadEmployeesForRun(context.bookId, input.date, input.employeeIds);
    if (!employees.length) throw new Error('No employees to pay');

    const slips = employees.map((employee) => {
      const gross = cents(employee.pay_rate);
      const tax = cents(gross * Number(employee.tax_withhold_pct) / 100);
      const net = cents(gross - tax);
      return { employee, gross, tax, net };
    }).filter((slip) => slip.gross !== 0);
    if (!slips.length) throw new Error('No employees to pay');
    const totalGross = cents(slips.reduce((sum, slip) => sum + slip.gross, 0));
    const totalTax = cents(slips.reduce((sum, slip) => sum + slip.tax, 0));
    const totalNet = cents(slips.reduce((sum, slip) => sum + slip.net, 0));

    await this.repo.ensureDefaultAccounts(context.bookId);
    const cashCode = input.method === 'bank' ? V2_ACCOUNT_CODES.BANK : V2_ACCOUNT_CODES.CASH;
    const lines = [
      totalGross ? { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.WAGES_EXPENSE}`, debit: totalGross, credit: 0 } : null,
      totalNet ? { accountId: `${context.bookId}:account:${cashCode}`, debit: 0, credit: totalNet } : null,
      totalTax ? { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.PAYROLL_TAX_PAYABLE}`, debit: 0, credit: totalTax } : null,
    ].filter((line): line is { accountId: string; debit: number; credit: number } => !!line);

    const sourceId = uid('pay_run');
    const payRunId = uid('pr');
    const notes = String(input.notes || '').trim();
    const source: V2Source = {
      id: sourceId,
      bookId: context.bookId,
      type: 'pay_run',
      date: input.date,
      metadata: {
        method: input.method,
        notes,
        totalGross,
        totalTax,
        totalNet,
        employeeIds: slips.map((slip) => slip.employee.id),
      },
    };

    return this.repo.runInTransaction(async () => {
      const journal = await this.repo.postSourceJournal(source, {
        bookId: context.bookId,
        periodId: context.periodId,
        date: input.date,
        memo: notes || 'Payroll',
        lines,
      });
      await this.db.run(
        'INSERT INTO v2_pay_runs(id,book_id,period_id,date,notes,source_id) VALUES(?,?,?,?,?,?)',
        [payRunId, context.bookId, context.periodId, input.date, notes || null, sourceId],
      );
      const payslips: PayrollPayslip[] = [];
      for (const slip of slips) {
        const payslipId = uid('ps');
        await this.db.run(
          'INSERT INTO v2_payslips(id,pay_run_id,employee_id,gross,tax_withheld,net,notes) VALUES(?,?,?,?,?,?,?)',
          [payslipId, payRunId, slip.employee.id, slip.gross, slip.tax, slip.net, null],
        );
        payslips.push({
          id: payslipId,
          payRunId,
          employeeId: slip.employee.id,
          employeeName: slip.employee.name,
          gross: slip.gross,
          taxWithheld: slip.tax,
          net: slip.net,
          notes: '',
        });
      }
      return {
        payRun: {
          id: payRunId,
          bookId: context.bookId,
          periodId: context.periodId,
          date: input.date,
          notes,
          sourceId,
        },
        payslips,
        source,
        journal,
      };
    });
  }

  async listPayRuns(): Promise<PayrollPayRun[]> {
    const context = await this.getActiveContext();
    if (!context) return [];
    const rows = await this.db.all<PayRunRow>(
      'SELECT id,book_id,period_id,date,notes,source_id FROM v2_pay_runs WHERE book_id=? ORDER BY date DESC, id DESC',
      [context.bookId],
    );
    return rows.map(mapPayRun);
  }

  async listPayslips(payRunId: string): Promise<PayrollPayslip[]> {
    const context = await this.getActiveContext();
    if (!context) return [];
    const payRun = await this.db.first<PayRunRow>(
      'SELECT id,book_id,period_id,date,notes,source_id FROM v2_pay_runs WHERE id=? AND book_id=?',
      [payRunId, context.bookId],
    );
    if (!payRun) return [];
    const rows = await this.db.all<PayslipRow>(
      `SELECT p.id, p.pay_run_id, p.employee_id, e.name AS employee_name, p.gross, p.tax_withheld, p.net, p.notes
       FROM v2_payslips p
       LEFT JOIN v2_employees e ON e.id = p.employee_id
       WHERE p.pay_run_id=?
       ORDER BY e.name, p.id`,
      [payRunId],
    );
    return rows.map(mapPayslip);
  }

  /** Internal year-end totals by employee. Not a government filing. */
  async yearEndSummary(year: string): Promise<PayrollYearEndSummary> {
    const prefix = String(year || '').trim();
    if (!/^\d{4}$/.test(prefix)) throw new Error('Year must be a four-digit year');
    const context = await this.getActiveContext();
    if (!context) return { year: prefix, employees: [], totals: { gross: 0, taxWithheld: 0, net: 0 } };
    const rows = await this.db.all<{ employee_id: string; name: string; gross: number; tax_withheld: number; net: number }>(
      `SELECT e.id AS employee_id, e.name,
              COALESCE(SUM(p.gross),0) AS gross,
              COALESCE(SUM(p.tax_withheld),0) AS tax_withheld,
              COALESCE(SUM(p.net),0) AS net
       FROM v2_payslips p
       JOIN v2_pay_runs r ON r.id = p.pay_run_id
       JOIN v2_employees e ON e.id = p.employee_id
       LEFT JOIN v2_sources s ON s.id = r.source_id
       WHERE r.book_id=? AND r.date>=? AND r.date<=?
         AND COALESCE(json_extract(s.metadata,'$.reversed'),0)=0
         AND COALESCE(json_extract(s.metadata,'$.deleted'),0)=0
       GROUP BY e.id, e.name
       ORDER BY e.name, e.id`,
      [context.bookId, `${prefix}-01-01`, `${prefix}-12-31`],
    );
    const employees = rows.map((row) => ({
      employeeId: row.employee_id,
      name: row.name,
      gross: cents(row.gross),
      taxWithheld: cents(row.tax_withheld),
      net: cents(row.net),
    }));
    return {
      year: prefix,
      employees,
      totals: {
        gross: cents(employees.reduce((sum, row) => sum + row.gross, 0)),
        taxWithheld: cents(employees.reduce((sum, row) => sum + row.taxWithheld, 0)),
        net: cents(employees.reduce((sum, row) => sum + row.net, 0)),
      },
    };
  }

  private async requirePayroll(bookId: string) {
    requireOptionalModule(await isOptionalModuleEnabled(this.db, 'payroll', bookId), 'payroll');
  }

  private async loadEmployeesForRun(bookId: string, payDate: string, employeeIds?: string[]) {
    const ids = (employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean);
    const started = '(start_date IS NULL OR start_date=\'\' OR start_date<=?)';
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      return this.db.all<EmployeeRow>(
        `SELECT id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived
         FROM v2_employees WHERE book_id=? AND archived=0 AND ${started} AND id IN (${placeholders})
         ORDER BY name, id`,
        [bookId, payDate, ...ids],
      );
    }
    return this.db.all<EmployeeRow>(
      `SELECT id,book_id,name,role,pay_rate,tax_withhold_pct,start_date,archived FROM v2_employees WHERE book_id=? AND archived=0 AND ${started} ORDER BY name, id`,
      [bookId, payDate],
    );
  }
}

function mapEmployee(row: EmployeeRow): PayrollEmployee {
  return {
    id: row.id,
    bookId: row.book_id,
    name: row.name,
    role: row.role,
    payRate: Number(row.pay_rate),
    taxWithholdPct: Number(row.tax_withhold_pct),
    startDate: row.start_date,
    archived: Boolean(row.archived),
  };
}

function mapPayRun(row: PayRunRow): PayrollPayRun {
  return {
    id: row.id,
    bookId: row.book_id,
    periodId: row.period_id,
    date: row.date,
    notes: row.notes || '',
    sourceId: row.source_id,
  };
}

function mapPayslip(row: PayslipRow): PayrollPayslip {
  return {
    id: row.id,
    payRunId: row.pay_run_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name || undefined,
    gross: Number(row.gross),
    taxWithheld: Number(row.tax_withheld),
    net: Number(row.net),
    notes: row.notes || '',
  };
}
