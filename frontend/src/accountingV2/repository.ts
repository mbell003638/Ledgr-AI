import type { V2Account, V2Book, V2JournalEntry, V2Party, V2Source } from './types';
import { defaultAccounts } from './schema';
import type { SqlRunner } from '../db/schema';

export type V2DateRange = { from?: string; to?: string };
export type V2ReconciliationError = {
  code: 'JOURNAL_UNBALANCED' | 'TRIAL_BALANCE_OUT_OF_BALANCE' | 'BALANCE_SHEET_OUT_OF_BALANCE';
  message: string;
  difference: number;
  journalId?: string;
};

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cents = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
let savepointSequence = 0;

export class V2SqlRepository {
  constructor(readonly db: SqlRunner) {}

  async createBook(book: V2Book, accounts: V2Account[]) {
    return this.tx(async () => {
      await this.db.run('INSERT INTO v2_books(id,name,style,basis,created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, style=excluded.style, basis=excluded.basis', [book.id, book.name, book.style, book.basis, book.createdAt]);
      for (const a of accounts) await this.db.run('INSERT INTO v2_accounts(id,book_id,code,name,type,payment_method,active) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', [a.id, a.bookId, a.code, a.name, a.type, a.paymentMethod || null, a.active ? 1 : 0]);
      return book;
    });
  }

  async ensureDefaultAccounts(bookId: string): Promise<V2Account[]> {
    if (!(await this.db.first('SELECT id FROM v2_books WHERE id = ?', [bookId]))) throw new Error('Book not found');
      return this.tx(async () => {
        for (const account of defaultAccounts(bookId)) {
        const existing = await this.db.first('SELECT id FROM v2_accounts WHERE book_id = ? AND code = ?', [bookId, account.code]);
        if (!existing) await this.db.run('INSERT INTO v2_accounts(id,book_id,code,name,type,payment_method,active) VALUES(?,?,?,?,?,?,?)', [account.id, bookId, account.code, account.name, account.type, account.paymentMethod || null, 1]);
      }
      const rows = await this.db.all<{ id: string; book_id: string; code: string; name: string; type: V2Account['type']; payment_method: V2Account['paymentMethod'] | null; active: number }>('SELECT id,book_id,code,name,type,payment_method,active FROM v2_accounts WHERE book_id = ? ORDER BY code', [bookId]);
      return rows.map((row) => ({ id: row.id, bookId: row.book_id, code: row.code, name: row.name, type: row.type, paymentMethod: row.payment_method || undefined, active: Boolean(row.active) }));
    });
  }

  async createParty(party: V2Party) {
    await this.db.run('INSERT INTO v2_parties(id,book_id,name,phone,email,roles,archived) VALUES(?,?,?,?,?,?,?)', [party.id, party.bookId, party.name, party.phone || null, party.email || null, JSON.stringify(party.roles), party.archived ? 1 : 0]);
    return party;
  }

  async createPeriod(period: { id: string; bookId: string; startDate: string; endDate: string; status: 'open'|'closed'; closeSnapshot?: Record<string, unknown> }) {
    const book = await this.db.first('SELECT id FROM v2_books WHERE id = ?', [period.bookId]);
    if (!book) throw new Error('Book not found');
    await this.db.run('INSERT INTO v2_periods(id,book_id,start_date,end_date,status,close_snapshot) VALUES(?,?,?,?,?,?)', [period.id, period.bookId, period.startDate, period.endDate, period.status, period.closeSnapshot ? JSON.stringify(period.closeSnapshot) : null]);
    return period;
  }

  async postSourceJournal(source: V2Source, input: Omit<V2JournalEntry, 'id'|'sourceId'> & { id?: string }): Promise<V2JournalEntry> {
    if (source.bookId !== input.bookId) throw new Error('Source does not belong to book');
    if (source.date !== input.date) throw new Error('Source date must match journal date');
    return this.tx(async () => {
      const id = input.id || uid('je');
      await this.validateJournal({ ...input, sourceId: source.id }, source.id);
      await this.db.run('INSERT INTO v2_sources(id,book_id,type,date,reference,metadata) VALUES(?,?,?,?,?,?)', [source.id, source.bookId, source.type, source.date, source.reference || null, JSON.stringify(source.metadata || {})]);
      return this.insertJournal(id, { ...input, sourceId: source.id });
    });
  }

  async postSourceJournalWithAllocations(source: V2Source, input: Omit<V2JournalEntry, 'id'|'sourceId'> & { id?: string }, allocations: { id: string; bookId: string; invoiceSourceId: string; receiptSourceId: string; amount: number; allocatedAt: string }[]): Promise<V2JournalEntry> {
    if (source.bookId !== input.bookId || source.date !== input.date) throw new Error('Source and journal must belong to the same book and date');
    return this.tx(async () => {
      const id = input.id || uid('je');
      await this.validateJournal({ ...input, sourceId: source.id }, source.id);
      await this.db.run('INSERT INTO v2_sources(id,book_id,type,date,reference,metadata) VALUES(?,?,?,?,?,?)', [source.id, source.bookId, source.type, source.date, source.reference || null, JSON.stringify(source.metadata || {})]);
      const journal = await this.insertJournal(id, { ...input, sourceId: source.id });
      for (const a of allocations) await this.db.run('INSERT INTO v2_invoice_allocations(id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at) VALUES(?,?,?,?,?,?)', [a.id, a.bookId, a.invoiceSourceId, a.receiptSourceId, a.amount, a.allocatedAt]);
      return journal;
    });
  }

  async postJournal(input: Omit<V2JournalEntry, 'id'> & { id?: string }) {
    this.assertBalanced(input.lines);
    const id = input.id || uid('je');
    return this.tx(async () => {
      await this.validateJournal(input);
      return this.insertJournal(id, input);
    });
  }

  private assertBalanced(lines: V2JournalEntry['lines']) {
    const rounded = lines.map((l) => ({ ...l, debit: cents(l.debit), credit: cents(l.credit) }));
    const debit = rounded.reduce((s, l) => s + l.debit, 0);
    const credit = rounded.reduce((s, l) => s + l.credit, 0);
    if (!rounded.length || rounded.some((l) => !Number.isFinite(l.debit) || !Number.isFinite(l.credit) || l.debit < 0 || l.credit < 0 || (l.debit > 0 && l.credit > 0) || (l.debit === 0 && l.credit === 0)) || Math.abs(debit - credit) > 0.005) throw new Error('Journal entry must balance after cent rounding and contain valid debit/credit lines');
  }

  private async validateJournal(input: Omit<V2JournalEntry, 'id'>, pendingSourceId?: string) {
    this.assertBalanced(input.lines);
    if (!(await this.db.first('SELECT id FROM v2_books WHERE id = ?', [input.bookId]))) throw new Error('Book not found');
    const period = await this.db.first<{ status: string; start_date: string; end_date: string }>('SELECT status,start_date,end_date FROM v2_periods WHERE id = ? AND book_id = ?', [input.periodId, input.bookId]);
    if (!period) throw new Error('Period does not belong to book');
    if (period.status !== 'open') throw new Error('Period is closed');
    if (input.date < period.start_date || input.date > period.end_date) throw new Error('Posting date is outside the accounting period');
    if (input.sourceId && input.sourceId !== pendingSourceId) {
      const existingSource = await this.db.first('SELECT id FROM v2_sources WHERE id = ? AND book_id = ?', [input.sourceId, input.bookId]);
      if (!existingSource) throw new Error('Source does not belong to book');
    }
    if (input.reversalOf) {
      const original = await this.db.first<{ book_id: string }>('SELECT book_id FROM v2_journal_entries WHERE id = ?', [input.reversalOf]);
      if (!original || original.book_id !== input.bookId) throw new Error('Reversal journal does not belong to book');
      if (await this.db.first('SELECT id FROM v2_journal_entries WHERE reversal_of = ?', [input.reversalOf])) throw new Error('Journal entry already reversed');
    }
    for (const line of input.lines) {
      if (!(await this.db.first('SELECT id FROM v2_accounts WHERE id = ? AND book_id = ?', [line.accountId, input.bookId]))) throw new Error(`Account does not belong to book: ${line.accountId}`);
      if (line.partyId && !(await this.db.first('SELECT id FROM v2_parties WHERE id = ? AND book_id = ?', [line.partyId, input.bookId]))) throw new Error(`Party does not belong to book: ${line.partyId}`);
    }
  }

  private async insertJournal(id: string, input: Omit<V2JournalEntry, 'id'>): Promise<V2JournalEntry> {
    await this.db.run('INSERT INTO v2_journal_entries(id,book_id,period_id,source_id,date,memo,posted_at,reversal_of) VALUES(?,?,?,?,?,?,?,?)', [id, input.bookId, input.periodId, input.sourceId || null, input.date, input.memo, new Date().toISOString(), input.reversalOf || null]);
    for (const line of input.lines) await this.db.run('INSERT INTO v2_journal_lines(journal_id,account_id,party_id,debit,credit,memo) VALUES(?,?,?,?,?,?)', [id, line.accountId, line.partyId || null, cents(line.debit), cents(line.credit), line.memo || null]);
    return { ...input, id, lines: input.lines.map((l) => ({ ...l, debit: cents(l.debit), credit: cents(l.credit) })) };
  }

  async reverseJournal(journalId: string, reason: string): Promise<V2JournalEntry> {
    const original = await this.db.first<{ id: string; book_id: string; period_id: string; source_id: string | null; date: string }>('SELECT id,book_id,period_id,source_id,date FROM v2_journal_entries WHERE id = ?', [journalId]);
    if (!original) throw new Error('Journal entry not found');
    const existingReversal = await this.db.first<{ id: string; book_id: string; period_id: string; source_id: string | null; date: string; memo: string }>('SELECT id,book_id,period_id,source_id,date,memo FROM v2_journal_entries WHERE reversal_of = ?', [journalId]);
    if (existingReversal) {
      const existingLines = await this.db.all<{ account_id: string; party_id: string | null; debit: number; credit: number; memo: string | null }>('SELECT account_id,party_id,debit,credit,memo FROM v2_journal_lines WHERE journal_id = ? ORDER BY id', [existingReversal.id]);
      return { id: existingReversal.id, bookId: existingReversal.book_id, periodId: existingReversal.period_id, sourceId: existingReversal.source_id || undefined, date: existingReversal.date, memo: existingReversal.memo, reversalOf: journalId, lines: existingLines.map(l => ({ accountId: l.account_id, partyId: l.party_id || undefined, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo || undefined })) };
    }
    const lines = await this.db.all<{ account_id: string; party_id: string | null; debit: number; credit: number; memo: string | null }>('SELECT account_id,party_id,debit,credit,memo FROM v2_journal_lines WHERE journal_id = ? ORDER BY id', [journalId]);
    return this.postJournal({
      bookId: original.book_id, periodId: original.period_id, sourceId: original.source_id || undefined,
      date: original.date, memo: reason, reversalOf: journalId,
      lines: lines.map((line) => ({ accountId: line.account_id, partyId: line.party_id || undefined, debit: cents(line.credit), credit: cents(line.debit), memo: line.memo || undefined })),
    });
  }

  async invoiceOpen(invoiceSourceId: string): Promise<number> {
    const invoice = await this.db.first<{ metadata: string }>("SELECT metadata FROM v2_sources WHERE id=? AND type='invoice'", [invoiceSourceId]);
    if (!invoice) throw new Error('Invoice not found');
    const total = Number(JSON.parse(invoice.metadata || '{}').total || 0);
    const row = await this.db.first<{ paid: number }>('SELECT COALESCE(SUM(amount),0) AS paid FROM v2_invoice_allocations WHERE invoice_source_id=?', [invoiceSourceId]);
    return cents(total - Number(row?.paid || 0));
  }

  async accountBalance(bookId: string, accountId: string, range: V2DateRange = {}): Promise<number> {
    this.assertRange(range);
    if (!(await this.db.first('SELECT id FROM v2_books WHERE id = ?', [bookId]))) throw new Error('Book not found');
    if (!(await this.db.first('SELECT id FROM v2_accounts WHERE id = ? AND book_id = ?', [accountId, bookId]))) throw new Error('Account does not belong to book');
    const { sql, params } = this.rangeClause(range, 'j.date');
    const row = await this.db.first<{ balance: number }>(`SELECT COALESCE(SUM(l.debit-l.credit),0) AS balance FROM v2_journal_entries j JOIN v2_journal_lines l ON l.journal_id=j.id WHERE j.book_id=? AND l.account_id=?${sql}`, [bookId, accountId, ...params]);
    return cents(Number(row?.balance));
  }

  async reconcileBook(bookId: string, range: V2DateRange = {}) {
    this.assertRange(range);
    if (!(await this.db.first('SELECT id FROM v2_books WHERE id = ?', [bookId]))) throw new Error('Book not found');
    const { sql, params } = this.rangeClause(range, 'j.date');
    const journals = await this.db.all<{ id: string; debit: number; credit: number }>(`SELECT j.id,COALESCE(SUM(l.debit),0) AS debit,COALESCE(SUM(l.credit),0) AS credit FROM v2_journal_entries j JOIN v2_journal_lines l ON l.journal_id=j.id WHERE j.book_id=?${sql} GROUP BY j.id`, [bookId, ...params]);
    const debit = cents(journals.reduce((sum, row) => sum + Number(row.debit), 0));
    const credit = cents(journals.reduce((sum, row) => sum + Number(row.credit), 0));
    const difference = cents(debit - credit);
    const accounts = await this.db.all<{ type: V2Account['type']; debit: number; credit: number }>(`SELECT a.type,COALESCE(SUM(l.debit),0) AS debit,COALESCE(SUM(l.credit),0) AS credit FROM v2_accounts a JOIN v2_journal_lines l ON l.account_id=a.id JOIN v2_journal_entries j ON j.id=l.journal_id WHERE a.book_id=?${sql} GROUP BY a.type`, [bookId, ...params]);
    const byType = (type: V2Account['type']) => accounts.filter((row) => row.type === type).reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0);
    const assets = byType('asset');
    const liabilities = -byType('liability');
    const equity = -byType('equity');
    const netProfit = -byType('revenue') - byType('expense');
    const balanceSheetDifference = cents(assets - liabilities - equity - netProfit);
    const errors: V2ReconciliationError[] = journals
      .map((row) => ({ row, difference: cents(Number(row.debit) - Number(row.credit)) }))
      .filter(({ difference: journalDifference }) => Math.abs(journalDifference) > 0.005)
      .map(({ row, difference: journalDifference }) => ({ code: 'JOURNAL_UNBALANCED', message: 'Journal debits do not equal credits', journalId: row.id, difference: journalDifference }));
    if (Math.abs(difference) > 0.005) errors.push({ code: 'TRIAL_BALANCE_OUT_OF_BALANCE', message: 'Total debits do not equal total credits', difference });
    if (Math.abs(balanceSheetDifference) > 0.005) errors.push({ code: 'BALANCE_SHEET_OUT_OF_BALANCE', message: 'Assets do not equal liabilities, equity, and current earnings', difference: balanceSheetDifference });
    return { debit, credit, difference, balanceSheetDifference, balanced: errors.length === 0, errors };
  }

  private assertRange(range: V2DateRange) {
    if (range.from && range.to && range.from > range.to) throw new Error('Invalid date range: from must not be after to');
  }

  private rangeClause(range: V2DateRange, column: string) {
    const clauses: string[] = []; const params: string[] = [];
    if (range.from) { clauses.push(`${column} >= ?`); params.push(range.from); }
    if (range.to) { clauses.push(`${column} <= ?`); params.push(range.to); }
    return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
  }

  private async tx<T>(fn: () => Promise<T>): Promise<T> {
    const savepoint = `v2_repo_${++savepointSequence}`;
    await this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn();
      await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (e) {
      try {
        await this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve original error */ }
      throw e;
    }
  }
}
