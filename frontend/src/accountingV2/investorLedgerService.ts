import type { SqlRunner } from '../db/schema';
import { V2SqlRepository } from './repository';
import { V2_ACCOUNT_CODES } from './types';
import { V2BookConfigRepository } from './bookConfigRepository';

const cents = (value: number) => Math.round(Number(value) * 100) / 100;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export type InvestorTransactionType = 'opening_capital' | 'capital_injection' | 'drawing' | 'profit_allocation';
export type InvestorLedgerTransaction = {
  id: string;
  date: string;
  type: InvestorTransactionType;
  notes: string;
  amount: number;
};
export type InvestorLedgerDetail = {
  id: string;
  name: string;
  profitSharePct: number;
  periodStart: string;
  periodEnd: string;
  openingCapital: number;
  currentCapitalBalance: number;
  totalInjected: number;
  totalDrawings: number;
  profitShare: number;
  transactions: InvestorLedgerTransaction[];
};

type MemberRow = { id: string; name: string; opening_contribution: number; current_capital: number; profit_share_pct: number };
type PeriodRow = { id: string; start_date: string; end_date: string };

/** Partnership-only member ledger backed by balanced V2 journals. */
export class V2InvestorLedgerService {
  private readonly repo: V2SqlRepository;
  constructor(readonly db: SqlRunner) { this.repo = new V2SqlRepository(db); }

  async detail(bookId: string, memberId: string): Promise<InvestorLedgerDetail> {
    await this.requirePartnership(bookId);
    const member = await this.member(bookId, memberId);
    const period = await this.openPeriod(bookId);
    const sources = await this.db.all<{ id: string; date: string; type: string; metadata: string }>(
      `SELECT id,date,type,metadata FROM v2_sources
       WHERE book_id=? AND date>=? AND date<=? AND type IN ('capital_injection','drawing')
       ORDER BY date DESC,id DESC`,
      [bookId, period.start_date, period.end_date],
    );
    const movements = sources.flatMap((row): InvestorLedgerTransaction[] => {
      const metadata = this.metadata(row.metadata);
      if (metadata.reversed || metadata.deleted || !this.matchesMember(metadata, member)) return [];
      return [{
        id: row.id,
        date: row.date,
        type: row.type as 'capital_injection' | 'drawing',
        notes: String(metadata.notes || (row.type === 'drawing' ? 'Funds drawn' : 'Capital deposited')),
        amount: cents(Number(metadata.total || 0)),
      }];
    });
    const totalInjected = cents(movements.filter((item) => item.type === 'capital_injection').reduce((sum, item) => sum + item.amount, 0));
    const totalDrawings = cents(movements.filter((item) => item.type === 'drawing').reduce((sum, item) => sum + item.amount, 0));
    const profitShare = await this.currentProfitShare(bookId, period.id, member.profit_share_pct);
    const openingCapital = cents(Number(member.current_capital));
    const closedAllocations = await this.closedAllocations(bookId, member);
    const transactions: InvestorLedgerTransaction[] = [
      ...movements,
      ...closedAllocations,
      ...(openingCapital ? [{ id: `${member.id}:opening`, date: period.start_date, type: 'opening_capital' as const, notes: 'Opening capital carried into period', amount: openingCapital }] : []),
    ].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    return {
      id: member.id,
      name: member.name,
      profitSharePct: Number(member.profit_share_pct),
      periodStart: period.start_date,
      periodEnd: period.end_date,
      openingCapital,
      currentCapitalBalance: cents(openingCapital + totalInjected + profitShare - totalDrawings),
      totalInjected,
      totalDrawings,
      profitShare,
      transactions,
    };
  }

  async deposit(input: { bookId: string; memberId: string; date: string; amount: number; notes?: string }) {
    await this.requirePartnership(input.bookId);
    const member = await this.member(input.bookId, input.memberId);
    const period = await this.periodForDate(input.bookId, input.date);
    const amount = this.positive(input.amount);
    const source = {
      id: uid('capital_injection'), bookId: input.bookId, type: 'capital_injection', date: input.date,
      metadata: { memberId: member.id, memberName: member.name, total: amount, notes: input.notes || '', method: 'cash' },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: input.bookId, periodId: period.id, date: input.date, memo: `Capital deposit — ${member.name}`,
      lines: [
        { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CASH}`, debit: amount, credit: 0, memo: input.notes },
        { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CAPITAL}`, debit: 0, credit: amount, memo: member.name },
      ],
    });
    return { source, journal };
  }

  async draw(input: { bookId: string; memberId: string; date: string; amount: number; notes?: string }) {
    await this.requirePartnership(input.bookId);
    const member = await this.member(input.bookId, input.memberId);
    const period = await this.periodForDate(input.bookId, input.date);
    const amount = this.positive(input.amount);
    const source = {
      id: uid('drawing'), bookId: input.bookId, type: 'drawing', date: input.date,
      metadata: { memberId: member.id, memberName: member.name, total: amount, notes: input.notes || '', method: 'cash' },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: input.bookId, periodId: period.id, date: input.date, memo: `Member drawing — ${member.name}`,
      lines: [
        { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.DRAWINGS}`, debit: amount, credit: 0, memo: member.name },
        { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CASH}`, debit: 0, credit: amount, memo: input.notes },
      ],
    });
    return { source, journal };
  }

  private async requirePartnership(bookId: string) {
    const book = await this.db.first<{ style: string }>('SELECT style FROM v2_books WHERE id=?', [bookId]);
    if (!book) throw new Error('Book not found');
    if (book.style !== 'retail_partnership') throw new Error('Investor ledgers are available only in Partnership Mode');
  }

  private async member(bookId: string, id: string) {
    const decoded = decodeURIComponent(id);
    const row = await this.db.first<MemberRow>(
      'SELECT id,name,opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=? AND (id=? OR lower(name)=lower(?))',
      [bookId, decoded, decoded],
    );
    if (!row) throw new Error('Investor not found');
    return row;
  }

  private async openPeriod(bookId: string) {
    const period = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [bookId]);
    if (!period) throw new Error('No open accounting period');
    return period;
  }

  private async periodForDate(bookId: string, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must use YYYY-MM-DD');
    const period = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1", [bookId, date, date]);
    if (!period) throw new Error('Posting date is outside the open accounting period');
    return period;
  }

  private async currentProfitShare(bookId: string, periodId: string, percentage: number) {
    const rows = await this.db.all<{ code: string; type: string; debit: number; credit: number }>(
      `SELECT a.code,a.type,COALESCE(SUM(l.debit),0) debit,COALESCE(SUM(l.credit),0) credit
       FROM v2_accounts a JOIN v2_journal_lines l ON l.account_id=a.id
       JOIN v2_journal_entries j ON j.id=l.journal_id
       WHERE j.book_id=? AND j.period_id=? GROUP BY a.code,a.type`, [bookId, periodId],
    );
    const movement = (code: string) => {
      const row = rows.find((item) => item.code === code);
      return Number(row?.debit || 0) - Number(row?.credit || 0);
    };
    const sales = -movement(V2_ACCOUNT_CODES.SALES) + movement(V2_ACCOUNT_CODES.SALES_RETURNS);
    const purchases = Math.max(0, movement(V2_ACCOUNT_CODES.INVENTORY));
    const expenses = Math.max(0, movement(V2_ACCOUNT_CODES.EXPENSES));
    const grossProfit = sales - purchases;
    let commissionPct = 0;
    try { commissionPct = (await new V2BookConfigRepository(this.db).getBookConfig(bookId)).retailPartnership.commissionPct; } catch { /* config is optional in low-level books */ }
    const commission = grossProfit > 0 ? grossProfit * commissionPct / 100 : 0;
    const netProfit = grossProfit - commission - expenses;
    return cents(netProfit * Number(percentage) / 100);
  }

  private async closedAllocations(bookId: string, member: MemberRow): Promise<InvestorLedgerTransaction[]> {
    const rows = await this.db.all<{ id: string; snapshot: string; end_date: string }>(
      `SELECT c.id,c.snapshot,p.end_date FROM v2_close_books c JOIN v2_periods p ON p.id=c.period_id
       WHERE c.book_id=? ORDER BY p.end_date DESC`, [bookId],
    );
    return rows.flatMap((row) => {
      const snapshot = this.metadata(row.snapshot);
      const shares = Array.isArray(snapshot.memberProfitShares) ? snapshot.memberProfitShares : [];
      const share = shares.find((item: any) => item.memberId === member.id || String(item.name || '').toLowerCase() === member.name.toLowerCase());
      if (!share || !Number(share.profitShare)) return [];
      return [{ id: `${row.id}:${member.id}:profit`, date: row.end_date, type: 'profit_allocation' as const, notes: 'Period-close profit allocation', amount: cents(Number(share.profitShare)) }];
    });
  }

  private metadata(raw: string): Record<string, any> {
    try { const parsed = JSON.parse(raw || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { return {}; }
  }

  private matchesMember(metadata: Record<string, any>, member: MemberRow) {
    return metadata.memberId === member.id || String(metadata.memberName || metadata.partnerName || '').trim().toLowerCase() === member.name.trim().toLowerCase();
  }

  private positive(value: number) {
    const amount = cents(value);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than zero');
    return amount;
  }
}
