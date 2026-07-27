import type { SqlRunner } from '../db/schema';
import type { V2Member } from './types';

const cents = (value: number) => Math.round(value * 100) / 100;

export type InventoryCount = { id: string; bookId: string; periodId: string; date: string; value: number };
export type MemberProfitShare = {
  memberId: string; name: string; profitSharePct: number; openingCapital: number;
  profitShare: number; drawings: number; closingCapital: number;
};
export type CloseBooksSnapshot = {
  sales: number; openingInventory: number; purchases: number; closingInventory: number; cogs: number;
  grossProfit: number; commission: number; expenses: number; drawings: number; netProfit: number;
  cash: number; bank: number; accountsReceivable: number; accountsPayable: number; customerAdvances: number;
  inventory: number; liabilities: number; memberCapital: number; memberProfitShares: MemberProfitShare[];
};
export type CloseBooksResult = { id: string; bookId: string; periodId: string; closedAt: string; snapshot: CloseBooksSnapshot; journalId: string | null };
export type CloseBooksInput = { id: string; bookId: string; periodId: string; nextPeriodId: string; date: string; commissionPct: number };

type PeriodRow = { id: string; book_id: string; start_date: string; end_date: string; status: string };
type InventoryRow = { id: string; book_id: string; period_id: string; date: string; value: number };
type MemberRow = { id: string; book_id: string; name: string; current_capital: number; profit_share_pct: number };
type CloseRow = { id: string; book_id: string; period_id: string; closed_at: string; snapshot: string; journal_id: string | null };
type AccountTotalRow = { code: string; type: string; debit: number; credit: number };

export class V2CloseBooksRepository {
  constructor(readonly db: SqlRunner) {}

  async recordInventoryCount(count: InventoryCount): Promise<InventoryCount> {
    this.assertMoney(count.value, 'Inventory value');
    const period = await this.period(count.bookId, count.periodId);
    if (period.status !== 'open') throw new Error('Period is closed');
    if (count.date < period.start_date || count.date > period.end_date) throw new Error('Inventory count date is outside the period');
    await this.db.run('INSERT INTO v2_inventory_counts(id,book_id,period_id,date,value) VALUES(?,?,?,?,?)', [count.id, count.bookId, count.periodId, count.date, cents(count.value)]);
    return { ...count, value: cents(count.value) };
  }

  async listInventoryCounts(bookId: string, periodId: string): Promise<InventoryCount[]> {
    const rows = await this.db.all<InventoryRow>('SELECT id,book_id,period_id,date,value FROM v2_inventory_counts WHERE book_id=? AND period_id=? ORDER BY date,id', [bookId, periodId]);
    return rows.map((row) => ({ id: row.id, bookId: row.book_id, periodId: row.period_id, date: row.date, value: cents(Number(row.value)) }));
  }

  async addMember(member: V2Member): Promise<V2Member> {
    if (!member.name.trim()) throw new Error('Member name is required');
    this.assertMoney(member.openingContribution, 'Opening contribution');
    if (!Number.isFinite(member.profitSharePct) || member.profitSharePct < 0 || member.profitSharePct > 100) throw new Error('Profit share must be between 0 and 100');
    if (!(await this.db.first('SELECT id FROM v2_books WHERE id=?', [member.bookId]))) throw new Error('Book not found');
    const capital = cents(member.openingContribution);
    await this.db.run('INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES(?,?,?,?,?,?)', [member.id, member.bookId, member.name.trim(), capital, capital, member.profitSharePct]);
    return { ...member, name: member.name.trim(), openingContribution: capital };
  }

  async closeBooks(input: CloseBooksInput): Promise<CloseBooksResult> {
    const existing = await this.findClose(input.bookId, input.periodId);
    if (existing) return existing;
    if (!Number.isFinite(input.commissionPct) || input.commissionPct < 0 || input.commissionPct > 100) throw new Error('Commission percentage must be between 0 and 100');

    return this.tx(async () => {
      const alreadyClosed = await this.findClose(input.bookId, input.periodId);
      if (alreadyClosed) return alreadyClosed;
      const period = await this.period(input.bookId, input.periodId);
      if (period.status !== 'open') throw new Error('Period is closed without a close-books snapshot');
      if (input.date < period.start_date || input.date > period.end_date) throw new Error('Close date is outside the period');
      const nextPeriod = await this.period(input.bookId, input.nextPeriodId);
      if (nextPeriod.status !== 'open') throw new Error('Next period must be open');
      if (nextPeriod.start_date <= period.end_date) throw new Error('Next period must follow the period being closed');

      const counts = await this.listInventoryCounts(input.bookId, input.periodId);
      const openingCount = counts.find((count) => count.date === period.start_date);
      const closingCount = [...counts].reverse().find((count) => count.date === input.date);
      if (!openingCount || !closingCount) throw new Error('Inventory counts are required on the period start and close dates');
      const openingInventory = openingCount.value;
      const closingInventory = closingCount.value;
      const members = await this.db.all<MemberRow>('SELECT id,book_id,name,current_capital,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY id', [input.bookId]);
      const sharePctTotal = members.reduce((sum, member) => sum + Number(member.profit_share_pct), 0);
      if (members.length && Math.abs(sharePctTotal - 100) > 0.005) throw new Error('Member profit shares must total 100%');

      const periodTotals = await this.accountTotals(input.bookId, 'j.period_id=?', [input.periodId]);
      const balances = await this.accountTotals(input.bookId, 'j.date<=?', [input.date]);
      const movement = (code: string) => this.net(periodTotals, code);
      const balance = (code: string) => this.net(balances, code);
      const sales = cents(-movement('4000') + movement('4010'));
      const purchases = cents(Math.max(0, movement('1200')));
      const expenses = cents(Math.max(0, movement('6000')));
      const drawings = cents(Math.max(0, movement('3100')));
      const cogs = cents(openingInventory + purchases - closingInventory);
      const grossProfit = cents(sales - cogs);
      const commission = grossProfit > 0 ? cents(grossProfit * input.commissionPct / 100) : 0;
      const netProfit = cents(grossProfit - commission - expenses);
      const memberProfitShares = this.allocateProfit(members, netProfit, drawings);
      const accountsPayable = cents(-balance('2000'));
      const customerAdvances = cents(-balance('2100'));
      const liabilities = cents(balances.filter((row) => row.type === 'liability').reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0));
      const memberCapital = cents(memberProfitShares.reduce((sum, member) => sum + member.closingCapital, 0));
      const snapshot: CloseBooksSnapshot = {
        sales, openingInventory, purchases, closingInventory, cogs, grossProfit, commission, expenses, drawings, netProfit,
        cash: balance('1000'), bank: balance('1010'), accountsReceivable: balance('1100'), accountsPayable,
        customerAdvances, inventory: closingInventory, liabilities, memberCapital, memberProfitShares,
      };
      const closedAt = new Date().toISOString();
      const journalId = netProfit === 0 ? null : `${input.id}:journal`;
      if (journalId) await this.insertCloseJournal(journalId, input, netProfit, closedAt);
      await this.db.run('INSERT INTO v2_close_books(id,book_id,period_id,closed_at,snapshot,journal_id) VALUES(?,?,?,?,?,?)', [input.id, input.bookId, input.periodId, closedAt, JSON.stringify(snapshot), journalId]);
      await this.db.run('UPDATE v2_periods SET status=?,close_snapshot=? WHERE id=? AND book_id=?', ['closed', JSON.stringify(snapshot), input.periodId, input.bookId]);
      for (const member of memberProfitShares) await this.db.run('UPDATE v2_members SET current_capital=? WHERE id=? AND book_id=?', [member.closingCapital, member.memberId, input.bookId]);
      await this.db.run('INSERT INTO v2_inventory_counts(id,book_id,period_id,date,value) VALUES(?,?,?,?,?)', [`${input.id}:inventory-carry`, input.bookId, input.nextPeriodId, nextPeriod.start_date, closingInventory]);
      return { id: input.id, bookId: input.bookId, periodId: input.periodId, closedAt, snapshot, journalId };
    });
  }

  private net(rows: AccountTotalRow[], code: string): number {
    const row = rows.find((total) => total.code === code);
    return cents(Number(row?.debit || 0) - Number(row?.credit || 0));
  }

  private async accountTotals(bookId: string, condition: string, params: unknown[]): Promise<AccountTotalRow[]> {
    return this.db.all<AccountTotalRow>(`SELECT a.code,a.type,COALESCE(SUM(l.debit),0) AS debit,COALESCE(SUM(l.credit),0) AS credit
      FROM v2_accounts a JOIN v2_journal_lines l ON l.account_id=a.id JOIN v2_journal_entries j ON j.id=l.journal_id
      WHERE j.book_id=? AND ${condition} GROUP BY a.code,a.type`, [bookId, ...params]);
  }

  private async insertCloseJournal(journalId: string, input: CloseBooksInput, netProfit: number, postedAt: string) {
    const accounts = await this.db.all<{ id: string; code: string }>('SELECT id,code FROM v2_accounts WHERE book_id=? AND code IN (?,?)', [input.bookId, '3000', '3200']);
    const capital = accounts.find((account) => account.code === '3000');
    const currentProfit = accounts.find((account) => account.code === '3200');
    if (!capital || !currentProfit) throw new Error('Capital accounts missing');
    await this.db.run('INSERT INTO v2_journal_entries(id,book_id,period_id,source_id,date,memo,posted_at,reversal_of) VALUES(?,?,?,?,?,?,?,?)', [journalId, input.bookId, input.periodId, null, input.date, 'Period close', postedAt, null]);
    const amount = Math.abs(netProfit);
    const lines = netProfit > 0
      ? [{ accountId: currentProfit.id, debit: amount, credit: 0 }, { accountId: capital.id, debit: 0, credit: amount }]
      : [{ accountId: capital.id, debit: amount, credit: 0 }, { accountId: currentProfit.id, debit: 0, credit: amount }];
    for (const line of lines) await this.db.run('INSERT INTO v2_journal_lines(journal_id,account_id,party_id,debit,credit,memo) VALUES(?,?,?,?,?,?)', [journalId, line.accountId, null, line.debit, line.credit, 'Period close']);
  }

  private allocateProfit(members: MemberRow[], netProfit: number, drawings: number): MemberProfitShare[] {
    let allocated = 0; let drawingsAllocated = 0;
    return members.map((member, index) => {
      const profitShare = index === members.length - 1 ? cents(netProfit - allocated) : cents(netProfit * Number(member.profit_share_pct) / 100);
      allocated = cents(allocated + profitShare);
      const memberDrawings = index === members.length - 1 ? cents(drawings - drawingsAllocated) : cents(drawings * Number(member.profit_share_pct) / 100);
      drawingsAllocated = cents(drawingsAllocated + memberDrawings);
      const openingCapital = cents(Number(member.current_capital));
      return { memberId: member.id, name: member.name, profitSharePct: Number(member.profit_share_pct), openingCapital,
        profitShare, drawings: memberDrawings, closingCapital: cents(openingCapital + profitShare - memberDrawings) };
    });
  }

  private async period(bookId: string, periodId: string): Promise<PeriodRow> {
    const row = await this.db.first<PeriodRow>('SELECT id,book_id,start_date,end_date,status FROM v2_periods WHERE id=? AND book_id=?', [periodId, bookId]);
    if (!row) throw new Error('Period does not belong to book');
    return row;
  }

  private async findClose(bookId: string, periodId: string): Promise<CloseBooksResult | null> {
    const row = await this.db.first<CloseRow>('SELECT id,book_id,period_id,closed_at,snapshot,journal_id FROM v2_close_books WHERE book_id=? AND period_id=?', [bookId, periodId]);
    return row ? { id: row.id, bookId: row.book_id, periodId: row.period_id, closedAt: row.closed_at, snapshot: JSON.parse(row.snapshot) as CloseBooksSnapshot, journalId: row.journal_id } : null;
  }

  private assertMoney(value: number, label: string) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative amount`);
  }

  private async tx<T>(work: () => Promise<T>): Promise<T> {
    await this.db.exec('BEGIN');
    try { const result = await work(); await this.db.exec('COMMIT'); return result; }
    catch (error) { try { await this.db.exec('ROLLBACK'); } catch { /* preserve original failure */ } throw error; }
  }
}
