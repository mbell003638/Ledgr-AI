import type { SqlRunner } from '../db/schema';
import { V2_ACCOUNT_CODES, type V2Member } from './types';
import { round2 } from '../money';
import { computePeriodicCogs } from './cogs';

const cents = round2;

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

      // Periodic COGS via the SINGLE shared selection path (cogs.ts) so the close, the live
      // report, the dashboard and the investor ledger all agree — including for a mid-period
      // count (latest in-period count is the closing; opening per the shared rule). This
      // replaces the old requirement that counts be dated EXACTLY on the start and close dates,
      // which made a mid-period count show COGS in the live report but throw at close.
      const cogsResult = await computePeriodicCogs(this.db, input.bookId, { start: period.start_date, end: input.date });
      const { openingInventory, closingInventory, cogs } = cogsResult;
      // The close can only proceed with a known closing inventory. When the book has inventory
      // activity in the period (a recorded count or inventory purchases) but no distinct closing
      // count is derivable, periodic COGS is undefined — surface a clear, actionable error rather
      // than silently closing with COGS 0. A book with no inventory activity at all closes fine.
      const periodCounts = await this.listInventoryCounts(input.bookId, input.periodId);
      const tracksInventory = periodCounts.length > 0 || cogsResult.purchases > 0;
      if (tracksInventory && !cogsResult.hasClosingCount) {
        throw new Error('An inventory count within the period is required to close (closing stock is unknown)');
      }
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
      const grossProfit = cents(sales - cogs);
      const commission = grossProfit > 0 ? cents(grossProfit * input.commissionPct / 100) : 0;
      const netProfit = cents(grossProfit - commission - expenses);
      const memberMovements = await this.memberMovements(input.bookId, input.periodId);
      const memberProfitShares = this.allocateProfit(members, netProfit, drawings, memberMovements);
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
      // 1. Recognize periodic COGS in the ledger: Dr 5000 / Cr 1200 (skip if zero).
      await this.postAdjustmentJournal(`${input.id}:cogs`, input, closedAt, 'Cost of goods sold (periodic)', cogs, V2_ACCOUNT_CODES.COGS, V2_ACCOUNT_CODES.INVENTORY);
      // 2. Recognize partnership commission as an expense/payable so the GL P&L equals net profit.
      await this.postAdjustmentJournal(`${input.id}:commission`, input, closedAt, 'Commission expense', commission, V2_ACCOUNT_CODES.COMMISSION_EXPENSE, V2_ACCOUNT_CODES.COMMISSION_PAYABLE);
      // 3. Closing entries: zero every income/expense account into Retained Earnings (3300),
      //    then (partnership) allocate Retained Earnings to member capital (3000).
      const journalId = await this.postClosingEntries(input, closedAt, memberProfitShares);
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

  private async accountId(bookId: string, code: string): Promise<string> {
    const row = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [bookId, code]);
    if (!row) throw new Error(`Account ${code} missing`);
    return row.id;
  }

  private async writeJournal(journalId: string, input: CloseBooksInput, postedAt: string, memo: string, lines: { accountId: string; debit: number; credit: number }[]) {
    await this.db.run('INSERT INTO v2_journal_entries(id,book_id,period_id,source_id,date,memo,posted_at,reversal_of) VALUES(?,?,?,?,?,?,?,?)', [journalId, input.bookId, input.periodId, null, input.date, memo, postedAt, null]);
    for (const line of lines) await this.db.run('INSERT INTO v2_journal_lines(journal_id,account_id,party_id,debit,credit,memo) VALUES(?,?,?,?,?,?)', [journalId, line.accountId, null, cents(line.debit), cents(line.credit), memo]);
  }

  /** Post a single Dr debitCode / Cr creditCode adjustment for `amount`; no-op when zero. */
  private async postAdjustmentJournal(journalId: string, input: CloseBooksInput, postedAt: string, memo: string, amount: number, debitCode: string, creditCode: string) {
    const value = cents(amount);
    if (value <= 0) return;
    await this.writeJournal(journalId, input, postedAt, memo, [
      { accountId: await this.accountId(input.bookId, debitCode), debit: value, credit: 0 },
      { accountId: await this.accountId(input.bookId, creditCode), debit: 0, credit: value },
    ]);
  }

  /**
   * Zero every income/expense account's period balance into Retained Earnings (3300),
   * then, for partnerships, allocate the retained earnings to each member's capital (3000).
   * Returns the id of the 'Period close' journal, or null when there is nothing to close.
   */
  private async postClosingEntries(input: CloseBooksInput, postedAt: string, memberProfitShares: MemberProfitShare[]): Promise<string | null> {
    // Period balances for income/expense accounts, re-read so freshly posted COGS/commission are included.
    const rows = await this.db.all<{ id: string; type: string; debit: number; credit: number }>(
      `SELECT a.id,a.type,COALESCE(SUM(l.debit),0) AS debit,COALESCE(SUM(l.credit),0) AS credit
       FROM v2_accounts a JOIN v2_journal_lines l ON l.account_id=a.id JOIN v2_journal_entries j ON j.id=l.journal_id
       WHERE j.book_id=? AND j.period_id=? AND a.type IN ('revenue','expense') GROUP BY a.id,a.type`,
      [input.bookId, input.periodId],
    );
    const retainedEarnings = await this.accountId(input.bookId, V2_ACCOUNT_CODES.RETAINED_EARNINGS);
    const lines: { accountId: string; debit: number; credit: number }[] = [];
    let retainedDelta = 0; // credit-positive: net profit accumulated into 3300
    for (const row of rows) {
      const net = cents(Number(row.debit) - Number(row.credit)); // debit-positive account balance
      if (net === 0) continue;
      if (net > 0) {
        // Debit-normal (expense) balance: credit the account to clear it, debit RE.
        lines.push({ accountId: row.id, debit: 0, credit: net });
        retainedDelta = cents(retainedDelta - net);
      } else {
        // Credit-normal (revenue) balance: debit the account to clear it, credit RE.
        lines.push({ accountId: row.id, debit: -net, credit: 0 });
        retainedDelta = cents(retainedDelta - net);
      }
    }
    if (retainedDelta > 0) lines.push({ accountId: retainedEarnings, debit: 0, credit: retainedDelta });
    else if (retainedDelta < 0) lines.push({ accountId: retainedEarnings, debit: -retainedDelta, credit: 0 });

    // Partnership allocation: move retained earnings into member capital shares.
    const totalProfitShare = cents(memberProfitShares.reduce((sum, member) => sum + member.profitShare, 0));
    if (memberProfitShares.length && totalProfitShare !== 0) {
      const capital = await this.accountId(input.bookId, V2_ACCOUNT_CODES.CAPITAL);
      for (const member of memberProfitShares) {
        if (member.profitShare === 0) continue;
        if (member.profitShare > 0) {
          lines.push({ accountId: retainedEarnings, debit: member.profitShare, credit: 0 });
          lines.push({ accountId: capital, debit: 0, credit: member.profitShare });
        } else {
          lines.push({ accountId: retainedEarnings, debit: 0, credit: -member.profitShare });
          lines.push({ accountId: capital, debit: -member.profitShare, credit: 0 });
        }
      }
    }

    if (!lines.length) return null;
    const journalId = `${input.id}:journal`;
    await this.writeJournal(journalId, input, postedAt, 'Period close', lines);
    return journalId;
  }

  private allocateProfit(
    members: MemberRow[],
    netProfit: number,
    drawings: number,
    movements: Map<string, { injections: number; drawings: number }> = new Map(),
  ): MemberProfitShare[] {
    let allocated = 0; let fallbackDrawingsAllocated = 0;
    const attributedDrawings = cents([...movements.values()].reduce((sum, item) => sum + item.drawings, 0));
    const unattributedDrawings = cents(Math.max(0, drawings - attributedDrawings));
    return members.map((member, index) => {
      const profitShare = index === members.length - 1 ? cents(netProfit - allocated) : cents(netProfit * Number(member.profit_share_pct) / 100);
      allocated = cents(allocated + profitShare);
      const fallback = index === members.length - 1 ? cents(unattributedDrawings - fallbackDrawingsAllocated) : cents(unattributedDrawings * Number(member.profit_share_pct) / 100);
      fallbackDrawingsAllocated = cents(fallbackDrawingsAllocated + fallback);
      const movement = movements.get(member.id) || { injections: 0, drawings: 0 };
      const memberDrawings = cents(movement.drawings + fallback);
      const openingCapital = cents(Number(member.current_capital));
      return { memberId: member.id, name: member.name, profitSharePct: Number(member.profit_share_pct), openingCapital,
        profitShare, drawings: memberDrawings, closingCapital: cents(openingCapital + movement.injections + profitShare - memberDrawings) };
    });
  }

  private async memberMovements(bookId: string, periodId: string) {
    const rows = await this.db.all<{ type: string; metadata: string }>(
      `SELECT s.type,s.metadata FROM v2_sources s JOIN v2_journal_entries j ON j.source_id=s.id
       WHERE s.book_id=? AND j.period_id=? AND s.type IN ('capital_injection','drawing')`,
      [bookId, periodId],
    );
    const result = new Map<string, { injections: number; drawings: number }>();
    for (const row of rows) {
      let metadata: any = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
      if (metadata.reversed || metadata.deleted) continue;
      const memberId = String(metadata.memberId || '');
      const amount = cents(Number(metadata.total || 0));
      if (!memberId || amount <= 0) continue;
      const current = result.get(memberId) || { injections: 0, drawings: 0 };
      if (row.type === 'capital_injection') current.injections = cents(current.injections + amount);
      else current.drawings = cents(current.drawings + amount);
      result.set(memberId, current);
    }
    return result;
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
