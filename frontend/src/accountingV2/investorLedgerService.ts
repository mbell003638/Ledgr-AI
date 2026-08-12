import type { SqlRunner } from '../db/schema';
import { V2SqlRepository } from './repository';
import { V2_ACCOUNT_CODES } from './types';
import { round2 } from '../money';
import { buildPersistentV2Reports } from './persistentReports';
import { partnershipProfitFromReports } from './reports';
import { V2BookConfigRepository } from './bookConfigRepository';
import { V2DocumentService } from './documentService';

const cents = round2;
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
  private readonly documents: V2DocumentService;
  constructor(readonly db: SqlRunner) {
    this.repo = new V2SqlRepository(db);
    this.documents = new V2DocumentService(this.repo);
  }

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
    const profitShare = await this.currentProfitShare(bookId, period, member.profit_share_pct);
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

  /** Correct a capital deposit without erasing its accounting history. */
  async updateDeposit(sourceId: string, input: { bookId: string; memberId: string; date: string; amount: number; notes?: string }) {
    await this.requireOwnedMovement(sourceId, input.bookId, input.memberId, 'capital_injection');
    return this.documents.replaceSource(sourceId, 'capital_injection', 'Edit capital deposit', () => this.deposit(input));
  }

  /** Reverse a capital deposit and retain the original journal for audit. */
  async deleteDeposit(sourceId: string, bookId: string, memberId: string) {
    await this.requireOwnedMovement(sourceId, bookId, memberId, 'capital_injection');
    return this.documents.reverseSource(sourceId, 'capital_injection', 'Delete capital deposit', true);
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
    if (book.style !== 'retail_partnership') throw new Error('Capital Statements are available only when Equity Split is enabled');
  }

  private async requireOwnedMovement(sourceId: string, bookId: string, memberId: string, type: 'capital_injection' | 'drawing') {
    await this.requirePartnership(bookId);
    const member = await this.member(bookId, memberId);
    const row = await this.db.first<{ metadata: string }>(
      'SELECT metadata FROM v2_sources WHERE id=? AND book_id=? AND type=?',
      [sourceId, bookId, type],
    );
    if (!row) throw new Error(type === 'capital_injection' ? 'Added capital entry not found' : 'Capital withdrawal not found');
    const metadata = this.metadata(row.metadata);
    if (metadata.reversed || metadata.deleted || !this.matchesMember(metadata, member)) {
      throw new Error(type === 'capital_injection' ? 'Added capital entry not found for this capital account' : 'Capital withdrawal not found for this capital account');
    }
  }

  private async member(bookId: string, id: string) {
    const decoded = decodeURIComponent(id);
    const row = await this.db.first<MemberRow>(
      'SELECT id,name,opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=? AND (id=? OR lower(name)=lower(?))',
      [bookId, decoded, decoded],
    );
    if (!row) throw new Error('Capital account not found');
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

  /**
   * The member's in-period profit share, derived from the SAME journal-authoritative,
   * COGS-adjusted net profit the dashboard and reports use — not the old COGS-blind
   * `sales − purchases` shortcut. This keeps every profit surface in agreement.
   */
  private async currentProfitShare(bookId: string, period: PeriodRow, percentage: number) {
    const reports = await buildPersistentV2Reports(this.db, { bookId, from: period.start_date, to: period.end_date });
    let commissionPct = 0;
    try { commissionPct = (await new V2BookConfigRepository(this.db).getBookConfig(bookId)).retailPartnership.commissionPct; } catch { /* config is optional in low-level books */ }
    const { netProfit } = partnershipProfitFromReports(reports.profitAndLoss, commissionPct);
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
