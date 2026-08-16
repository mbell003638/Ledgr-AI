import type { SqlRunner } from '../../db/schema';
import { round2 } from '../../money';
import { V2SqlRepository } from '../repository';
import { V2_ACCOUNT_CODES } from '../types';
import type { V2ActiveContext } from '../appService';

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const money = (value: unknown) => round2(Number.isFinite(Number(value)) ? Number(value) : 0);
const required = (value: unknown, label: string) => { const normalized = String(value || '').trim(); if (!normalized) throw new Error(`${label} is required`); return normalized; };

type ProjectInput = { name: string; partyId?: string; budget?: number; currency?: string; metadata?: Record<string, unknown> };
type TimeInput = { projectId: string; date: string; hours: number; rate: number; description?: string };
type CostInput = { projectId: string; date: string; amount: number; description?: string; accountCode?: string; method?: 'cash' | 'bank' };
type ContractInput = { brand: string; campaign: string; agreedAmount: number; partyId?: string; currency?: string; dueDate?: string; metadata?: Record<string, unknown> };
type PayoutInput = { contractId: string; date: string; amount: number; currency?: string; method?: 'cash' | 'bank'; notes?: string };

export class ProjectCreatorDomainService {
  constructor(private readonly db: SqlRunner, private readonly repo: V2SqlRepository, private readonly context: (date?: string) => Promise<V2ActiveContext | null>) {}

  async createProject(input: ProjectInput) {
    const context = await this.context();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const name = required(input.name, 'Project name');
    const id = uid('project');
    await this.db.run('INSERT INTO v2_projects(id,book_id,party_id,name,status,budget,currency,created_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)', [id, context.bookId, input.partyId || null, name, 'active', money(input.budget), input.currency || 'USD', new Date().toISOString(), JSON.stringify(input.metadata || {})]);
    return { id, bookId: context.bookId, name, budget: money(input.budget), currency: input.currency || 'USD', status: 'active' };
  }

  async addTime(input: TimeInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const project = await this.db.first<{ id: string }>('SELECT id FROM v2_projects WHERE id=? AND book_id=?', [input.projectId, context.bookId]);
    if (!project) throw new Error('Project not found');
    const hours = money(input.hours); const rate = money(input.rate);
    if (hours <= 0 || rate < 0) throw new Error('Hours must be greater than zero and rate cannot be negative');
    const id = uid('project_time'); const amount = money(hours * rate);
    await this.db.run('INSERT INTO v2_project_entries(id,project_id,book_id,date,kind,hours,rate,amount,description,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, input.projectId, context.bookId, input.date, 'time', hours, rate, amount, input.description || null, '{}']);
    return { id, projectId: input.projectId, kind: 'time', hours, rate, amount };
  }

  async recordCost(input: CostInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const project = await this.db.first<{ id: string }>('SELECT id FROM v2_projects WHERE id=? AND book_id=?', [input.projectId, context.bookId]);
    if (!project) throw new Error('Project not found');
    const value = money(input.amount); if (value <= 0) throw new Error('Project cost must be greater than zero');
    const sourceId = uid('project_cost'); const expenseCode = input.accountCode || V2_ACCOUNT_CODES.EXPENSES; const settlementCode = input.method === 'bank' ? V2_ACCOUNT_CODES.BANK : V2_ACCOUNT_CODES.CASH;
    const expense = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [context.bookId, expenseCode]);
    const settlement = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [context.bookId, settlementCode]);
    if (!expense || !settlement) throw new Error('Project cost accounts are missing from this book');
    return this.repo.runInTransaction(async () => {
      const metadata = { projectId: input.projectId, amount: value, description: input.description || null, accountCode: expenseCode, method: input.method || 'cash' };
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: 'project_cost', date: input.date, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: input.description || 'Project cost', lines: [{ accountId: expense.id, debit: value, credit: 0, memo: 'Project cost' }, { accountId: settlement.id, debit: 0, credit: value, memo: 'Project cost settlement' }] });
      const entryId = uid('project_entry');
      await this.db.run('INSERT INTO v2_project_entries(id,project_id,book_id,date,kind,hours,rate,amount,description,source_id,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [entryId, input.projectId, context.bookId, input.date, 'cost', 0, 0, value, input.description || null, sourceId, JSON.stringify(metadata)]);
      return { id: entryId, sourceId, journal, projectId: input.projectId, amount: value };
    });
  }

  async createContract(input: ContractInput) {
    const context = await this.context();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const brand = required(input.brand, 'Brand'); const campaign = required(input.campaign, 'Campaign'); const agreedAmount = money(input.agreedAmount);
    if (agreedAmount <= 0) throw new Error('Agreed contract amount must be greater than zero');
    const id = uid('creator_contract');
    await this.db.run('INSERT INTO v2_creator_contracts(id,book_id,party_id,brand,campaign,agreed_amount,currency,due_date,status,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, context.bookId, input.partyId || null, brand, campaign, agreedAmount, input.currency || 'USD', input.dueDate || null, 'active', JSON.stringify(input.metadata || {})]);
    return { id, brand, campaign, agreedAmount, currency: input.currency || 'USD', status: 'active' };
  }

  async recordPayout(input: PayoutInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const contract = await this.db.first<{ id: string; brand: string; agreed_amount: number; currency: string }>('SELECT id,brand,agreed_amount,currency FROM v2_creator_contracts WHERE id=? AND book_id=?', [input.contractId, context.bookId]);
    if (!contract) throw new Error('Creator contract not found');
    const value = money(input.amount); if (value <= 0) throw new Error('Creator payout must be greater than zero');
    const sourceId = uid('creator_payout'); const settlementCode = input.method === 'cash' ? V2_ACCOUNT_CODES.CASH : V2_ACCOUNT_CODES.BANK;
    const settlement = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [context.bookId, settlementCode]);
    const sales = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [context.bookId, V2_ACCOUNT_CODES.SALES]);
    if (!settlement || !sales) throw new Error('Creator payout accounts are missing from this book');
    return this.repo.runInTransaction(async () => {
      const metadata = { contractId: input.contractId, brand: contract.brand, amount: value, method: input.method || 'bank', notes: input.notes || null };
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: 'creator_payout', date: input.date, reference: contract.brand, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: `Creator payout ${contract.brand}`, lines: [{ accountId: settlement.id, debit: value, credit: 0, memo: 'Creator/platform payout received' }, { accountId: sales.id, debit: 0, credit: value, memo: 'Creator revenue' }] });
      const id = uid('creator_payout_row');
      await this.db.run('INSERT INTO v2_creator_payouts(id,contract_id,book_id,date,amount,currency,method,source_id,metadata) VALUES(?,?,?,?,?,?,?,?,?)', [id, input.contractId, context.bookId, input.date, value, input.currency || contract.currency, input.method || 'bank', sourceId, JSON.stringify(metadata)]);
      const paid = await this.db.first<{ total: number }>('SELECT COALESCE(SUM(amount),0) AS total FROM v2_creator_payouts WHERE contract_id=?', [input.contractId]);
      if (Number(paid?.total || 0) >= Number(contract.agreed_amount)) await this.db.run("UPDATE v2_creator_contracts SET status='paid' WHERE id=?", [input.contractId]);
      return { id, sourceId, journal, amount: value, contractId: input.contractId };
    });
  }

  async listProjects() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'"); if (!active?.value) return [];
    return this.db.all(`SELECT p.*, COALESCE(SUM(CASE WHEN e.kind='time' THEN e.amount ELSE 0 END),0) AS time_value, COALESCE(SUM(CASE WHEN e.kind='cost' THEN e.amount ELSE 0 END),0) AS costs FROM v2_projects p LEFT JOIN v2_project_entries e ON e.project_id=p.id WHERE p.book_id=? GROUP BY p.id ORDER BY p.created_at DESC`, [active.value]);
  }
  async listContracts() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'"); if (!active?.value) return [];
    return this.db.all(`SELECT c.*, COALESCE(SUM(p.amount),0) AS paid FROM v2_creator_contracts c LEFT JOIN v2_creator_payouts p ON p.contract_id=c.id WHERE c.book_id=? GROUP BY c.id ORDER BY c.due_date IS NULL,c.due_date`, [active.value]);
  }
}
