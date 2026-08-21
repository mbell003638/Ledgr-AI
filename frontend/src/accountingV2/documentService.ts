import { V2_ACCOUNT_CODES, type V2PaymentMethod, type V2Party, type V2Source } from './types';
import { V2SqlRepository } from './repository';
import { ProductDomainService } from './services/productDomainService';
import { round2 } from '../money';
import { accountingRuntimeId as uid, withDeterministicReplacementSourceId } from './runtimeIds';
import { validatePostingInvariants, type JournalLineInput } from './invariants';
import { localTodayIso } from '../utils/dateValidation';

const cents = round2;
const positive = (n: number, label = 'Amount') => { const value = cents(n); if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`); return value; };
const today = () => localTodayIso();
/** Balance + validity guard delegating to canonical validatePostingInvariants. */
function assertBalanced(lines: JournalLineInput[]) {
  validatePostingInvariants(lines);
}
let savepointSequence = 0;

type PeriodStatusRow = { id: string; start_date: string; end_date: string; status: string };

export type ReceiptInput = { bookId: string; periodId: string; partyId: string; date: string; amount: number; method: V2PaymentMethod; reference?: string; allocations?: { invoiceSourceId: string; amount: number }[] };

export class V2DocumentService {
  constructor(readonly repo: V2SqlRepository) {}

  async updateParty(id: string, patch: Partial<Pick<V2Party, 'name'|'phone'|'email'|'roles'>>) {
    const old = await this.repo.db.first<any>('SELECT * FROM v2_parties WHERE id=?', [id]);
    if (!old) throw new Error('Business account not found');
    const roles = patch.roles ? JSON.stringify([...new Set(patch.roles)]) : old.roles;
    await this.repo.db.run('UPDATE v2_parties SET name=?, phone=?, email=?, roles=? WHERE id=?', [patch.name ?? old.name, patch.phone ?? old.phone, patch.email ?? old.email, roles, id]);
    return { ...old, name: patch.name ?? old.name, phone: patch.phone ?? old.phone, email: patch.email ?? old.email, roles: JSON.parse(roles) };
  }

  async archiveParty(id: string) {
    const party = await this.repo.db.first<any>('SELECT * FROM v2_parties WHERE id=?', [id]);
    if (!party) throw new Error('Business account not found');
    const used = await this.repo.db.first(
      "SELECT id FROM v2_sources WHERE book_id=? AND (json_extract(metadata,'$.partyId')=? OR json_extract(metadata,'$.customerId')=?) AND COALESCE(json_extract(metadata,'$.reversed'),0) != 1 AND COALESCE(json_extract(metadata,'$.deleted'),0) != 1 LIMIT 1",
      [party.book_id, id, id],
    );
    if (used) throw new Error('Cannot archive party with accounting sources');
    await this.repo.db.run('UPDATE v2_parties SET archived=1 WHERE id=?', [id]);
    return { ...party, archived: true };
  }

  async markInvoicePaid(invoiceSourceId: string, input: Pick<ReceiptInput, 'periodId'|'date'|'method'>) {
    const invoice = await this.repo.db.first<any>("SELECT * FROM v2_sources WHERE id=? AND type='invoice'", [invoiceSourceId]);
    if (!invoice) throw new Error('Invoice not found');
    const meta = JSON.parse(invoice.metadata || '{}');
    const open = await this.repo.invoiceOpen(invoiceSourceId);
    if (open <= 0) throw new Error('Invoice already settled');
    return this.recordReceipt({ bookId: invoice.book_id, periodId: input.periodId, partyId: meta.partyId, date: input.date, amount: open, method: input.method, allocations: [{ invoiceSourceId, amount: open }] });
  }

  async recordReceipt(input: ReceiptInput) {
    return this.repoTx(() => this.postReceiptInCurrentTransaction(input));
  }

  async deleteReceipt(receiptSourceId: string) {
    return this.reverseSource(receiptSourceId, 'receipt', 'Delete receipt', true);
  }

  async reverseSource(sourceId: string, expectedType: string, memo: string, deleted = false, opts: { allowAllocations?: boolean } = {}) {
    return this.repoTx(async () => {
      const source = await this.sourceRow(sourceId, expectedType);
      if (expectedType === 'invoice') {
        // [Finding E / ACC-01c] Drop auto-applied advance allocations generated during invoice creation.
        // Pure advances only credited 2100 without crediting 1100. Direct receipts (which credited 1100)
        // are preserved even if they also credited 2100 for an excess balance.
        await this.repo.db.run(`
          DELETE FROM v2_invoice_allocations
          WHERE invoice_source_id = ?
            AND receipt_source_id IN (
              SELECT s.id FROM v2_sources s
              JOIN v2_journal_entries j ON j.source_id = s.id
              JOIN v2_journal_lines l ON l.journal_id = j.id
              JOIN v2_accounts a ON a.id = l.account_id
              WHERE a.code = '2100'
            )
            AND receipt_source_id NOT IN (
              SELECT s.id FROM v2_sources s
              JOIN v2_journal_entries j ON j.source_id = s.id
              JOIN v2_journal_lines l ON l.journal_id = j.id
              JOIN v2_accounts a ON a.id = l.account_id
              WHERE a.code = '1100'
            )
        `, [sourceId]);

        if (!opts.allowAllocations) {
          const allocated = await this.repo.db.first('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [sourceId]);
          if (allocated) throw new Error('Cannot reverse an invoice with receipt allocations');
        }
      } else if (expectedType === 'receipt') {
        await this.repo.db.run('DELETE FROM v2_invoice_allocations WHERE receipt_source_id=?', [sourceId]);
      }
      const originals = await this.journalsForSource(sourceId);
      let reversal = await this.insertReversal(source, originals[0], memo);
      for (const extra of originals.slice(1)) {
        reversal = await this.insertReversal(source, extra, memo);
      }
      await new ProductDomainService(this.repo.db, this.repo, async () => null).reverseMovesForSource(
        source.book_id,
        source.id,
        { sourceId: reversal.source.id, date: reversal.journal.date },
      );
      await this.repo.db.run("UPDATE v2_sources SET metadata=json_set(COALESCE(metadata,'{}'),'$.reversed',1,'$.deleted',?,'$.reversalSourceId',?) WHERE id=?", [deleted ? 1 : 0, reversal.source.id, sourceId]);
      return reversal;
    });
  }

  /** Reverse and replace one source as a single all-or-nothing edit. */
  async replaceSource<T>(sourceId: string, expectedType: string, memo: string, createReplacement: () => Promise<T>): Promise<T> {
    return this.repoTx(async () => {
      await this.reverseSource(sourceId, expectedType, memo);
      return withDeterministicReplacementSourceId(createReplacement);
    });
  }

  /**
   * [Finding E] Edit an invoice that already has receipt allocations. The new
   * total must be >= the amount already allocated (received against it); otherwise
   * the caller gets an actionable error. The old invoice journal is reversed, a
   * replacement invoice is posted for the new total, and the existing allocation
   * rows are re-pointed to the replacement so the payments stay applied (the
   * invoice's open balance becomes newTotal − allocated).
   */
  async replaceInvoicePreservingAllocations<T extends { source: { id: string } }>(
    sourceId: string,
    memo: string,
    newTotal: number,
    createReplacement: () => Promise<T>,
  ): Promise<T> {
    return this.repoTx(async () => {
      // Only count allocations from direct manual receipts (not advance applications).
      const directReceiptAllocs = await this.repo.db.all<{ id: string; amount: number }>(`
        SELECT a.id, a.amount FROM v2_invoice_allocations a
        JOIN v2_sources s ON s.id = a.receipt_source_id
        JOIN v2_journal_entries j ON j.source_id = s.id
        JOIN v2_journal_lines l ON l.journal_id = j.id
        JOIN v2_accounts acc ON acc.id = l.account_id
        WHERE a.invoice_source_id = ? AND acc.code = '1100'
      `, [sourceId]);
      const allocated = cents(directReceiptAllocs.reduce((sum, r) => sum + Number(r.amount || 0), 0));
      const total = cents(newTotal);
      if (allocated > 0.005 && total < allocated - 0.005) {
        throw new Error(`$${allocated.toFixed(2)} already received against this invoice — delete/adjust the receipt first or set the total to $${allocated.toFixed(2)} or more.`);
      }
      await this.reverseSource(sourceId, 'invoice', memo, false, { allowAllocations: true });
      const replacement = await withDeterministicReplacementSourceId(createReplacement);
      // Re-point the preserved direct receipt allocations onto the replacement invoice.
      if (directReceiptAllocs.length) {
        for (const alloc of directReceiptAllocs) {
          await this.repo.db.run('UPDATE v2_invoice_allocations SET invoice_source_id=? WHERE id=?', [replacement.source.id, alloc.id]);
        }
      }
      // Re-read current open balance and update replacement status metadata
      const open = await this.repo.invoiceOpen(replacement.source.id);
      const meta = await this.repo.db.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=?', [replacement.source.id]);
      let metadata: any = {}; try { metadata = JSON.parse(meta?.metadata || '{}'); } catch { metadata = {}; }
      metadata.status = open <= 0.005 ? 'paid' : open < total - 0.005 ? 'partial' : 'unpaid';
      await this.repo.db.run('UPDATE v2_sources SET metadata=? WHERE id=?', [JSON.stringify(metadata), replacement.source.id]);
      return replacement;
    });
  }

  async editReceipt(receiptSourceId: string, input: Omit<ReceiptInput, 'bookId'|'partyId'> & { partyId?: string; bookId?: string }) {
    return this.repoTx(async () => {
      const old = await this.receiptRow(receiptSourceId);
      await this.repo.db.run('DELETE FROM v2_invoice_allocations WHERE receipt_source_id=?', [receiptSourceId]);
      const journals = await this.journalsForSource(receiptSourceId);
      let reversal = await this.insertReversal(old, journals[0], 'Edit receipt');
      for (const extra of journals.slice(1)) reversal = await this.insertReversal(old, extra, 'Edit receipt');
      const next = await withDeterministicReplacementSourceId(() => this.postReceiptInCurrentTransaction({ ...input, bookId: old.book_id, partyId: input.partyId || JSON.parse(old.metadata || '{}').partyId }));
      await this.repo.db.run('UPDATE v2_sources SET metadata=json_set(COALESCE(metadata,\'{}\'),\'$.reversed\',1,\'$.reversalSourceId\',?) WHERE id=?', [reversal.source.id, receiptSourceId]);
      return { reversal, replacement: next };
    });
  }

  async drawing(input: { bookId: string; periodId: string; partyId?: string; date: string; amount: number; method: V2PaymentMethod }) {
    return this.simplePosting(input, 'drawing', 'Member drawing', V2_ACCOUNT_CODES.DRAWINGS, this.paymentCode(input.method), input.partyId);
  }

  async createExpense(input: { bookId: string; periodId: string; date: string; amount: number; settlementAccountId?: string; method?: V2PaymentMethod; payable?: boolean }) {
    const credit = input.payable ? `${input.bookId}:account:${V2_ACCOUNT_CODES.AP}` : input.settlementAccountId || `${input.bookId}:account:${this.paymentCode(input.method || 'cash')}`;
    return this.simplePosting(input, input.payable ? 'payable_expense' : 'expense', input.payable ? 'Payable expense' : 'Expense', V2_ACCOUNT_CODES.EXPENSES, credit);
  }

  async listCashEntries(bookId: string) {
    const rows = await this.repo.db.all<any>(`
      SELECT e.id, e.date, l.debit, l.credit, e.memo as notes, l.party_id, s.type
      FROM v2_journal_entries e
      JOIN v2_journal_lines l ON e.id = l.journal_id
      LEFT JOIN v2_sources s ON e.source_id = s.id
      WHERE e.book_id = ? AND l.account_id IN (?,?)
      ORDER BY e.date DESC, e.id DESC
    `, [bookId, `${bookId}:account:${V2_ACCOUNT_CODES.CASH}`, `${bookId}:account:${V2_ACCOUNT_CODES.BANK}`]);
    
    return rows.map(row => {
      const isOut = row.credit > 0;
      const amount = isOut ? row.credit : row.debit;
      return { id: row.id, amount, direction: isOut ? 'out' : 'in', date: row.date, notes: row.notes, created_at: row.date };
    });
  }

  private async postReceiptInCurrentTransaction(input: ReceiptInput) {
    const amount = positive(input.amount); const party = await this.repo.db.first<any>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [input.partyId, input.bookId]);
    if (!party || !JSON.parse(party.roles).includes('customer')) throw new Error('Customer party not found');
    let allocated = 0;
    const allocations = input.allocations || [];
    const pendingByInvoice: Record<string, number> = {};
    for (const a of allocations) {
      const value = positive(a.amount, 'Allocation');
      const inv = await this.repo.db.first<any>("SELECT book_id,metadata FROM v2_sources WHERE id=? AND type='invoice'", [a.invoiceSourceId]);
      const meta = inv ? JSON.parse(inv.metadata || '{}') : {};
      pendingByInvoice[a.invoiceSourceId] = cents((pendingByInvoice[a.invoiceSourceId] || 0) + value);
      if (!inv || inv.book_id !== input.bookId || meta.partyId !== input.partyId
        || pendingByInvoice[a.invoiceSourceId] > await this.repo.invoiceOpen(a.invoiceSourceId) + 0.005) {
        throw new Error('Invalid invoice allocation');
      }
      allocated = cents(allocated + value);
    }
    if (allocated > amount + .005) throw new Error('Allocations exceed receipt');
    const source: V2Source = { id: uid('receipt'), bookId: input.bookId, type: 'receipt', date: input.date, reference: input.reference, metadata: { partyId: input.partyId, total: amount, method: input.method, allocated, advance: cents(amount - allocated) } };
    const lines = [{ accountId: `${input.bookId}:account:${this.paymentCode(input.method)}`, partyId: input.partyId, debit: amount, credit: 0 }, ...(allocated ? [{ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: 0, credit: allocated }] : []), ...(amount > allocated ? [{ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CUSTOMER_ADVANCES}`, partyId: input.partyId, debit: 0, credit: cents(amount - allocated) }] : [])];
    const journal = await this.insertSourceJournal(source, input, lines);
    for (const a of allocations) await this.repo.db.run('INSERT INTO v2_invoice_allocations(id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at) VALUES(?,?,?,?,?,?)', [uid('alloc'), input.bookId, a.invoiceSourceId, source.id, cents(a.amount), input.date]);
    return { source, journal, allocated, advance: cents(amount - allocated) };
  }

  private async simplePosting(input: any, type: string, memo: string, debitCode: string, creditAccount: string, partyId?: string) { const amount = positive(input.amount); return this.repoTx(async () => { const source: V2Source = { id: uid(type), bookId: input.bookId, type, date: input.date, metadata: { total: amount, partyId, method: input.method } }; const journal = await this.insertSourceJournal(source, input, [{ accountId: `${input.bookId}:account:${debitCode}`, partyId, debit: amount, credit: 0 }, { accountId: creditAccount.includes(':account:') ? creditAccount : `${input.bookId}:account:${creditAccount}`, partyId, debit: 0, credit: amount }]); return { source, journal }; }); }
  private paymentCode(method: V2PaymentMethod) { if (method === 'cash') return V2_ACCOUNT_CODES.CASH; if (method === 'bank') return V2_ACCOUNT_CODES.BANK; if (method === 'card') return V2_ACCOUNT_CODES.CARD; if (method === 'mobile') return V2_ACCOUNT_CODES.MOBILE; throw new Error('Unsupported payment method'); }
  private async repoTx<T>(fn: () => Promise<T>) {
    const savepoint = `v2_document_${++savepointSequence}`;
    await this.repo.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const x = await fn();
      await this.repo.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return x;
    } catch (e) {
      try {
        await this.repo.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.repo.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve original error */ }
      throw e;
    }
  }
  private async receiptRow(id: string) { return this.sourceRow(id, 'receipt'); }
  private async sourceRow(id: string, type: string) {
    const row = await this.repo.db.first<any>('SELECT * FROM v2_sources WHERE id=? AND type=?', [id, type]);
    if (!row) throw new Error(`${type.replace(/_/g, ' ')} not found`);
    let metadata: any = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { /* malformed metadata is treated as empty */ }
    if (metadata.reversed || metadata.deleted) throw new Error('Transaction has already been reversed');
    return row;
  }
  private async journalsForSource(id: string) {
    const rows = await this.repo.db.all<any>('SELECT * FROM v2_journal_entries WHERE source_id=? ORDER BY posted_at,id', [id]);
    if (!rows.length) throw new Error('Receipt journal not found');
    for (const journal of rows) {
      journal.lines = await this.repo.db.all<any>('SELECT account_id AS accountId,party_id AS partyId,debit,credit,memo,location_id AS locationId FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [journal.id]);
    }
    return rows;
  }

  private async periodRow(bookId: string, periodId: string): Promise<PeriodStatusRow | null> {
    return this.repo.db.first<PeriodStatusRow>('SELECT id,start_date,end_date,status FROM v2_periods WHERE id=? AND book_id=?', [periodId, bookId]);
  }

  private async currentOpenPeriod(bookId: string, near: string): Promise<PeriodStatusRow> {
    const containing = await this.repo.db.first<PeriodStatusRow>(
      "SELECT id,start_date,end_date,status FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1",
      [bookId, near, near],
    );
    if (containing) return containing;
    const latest = await this.repo.db.first<PeriodStatusRow>(
      "SELECT id,start_date,end_date,status FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date DESC LIMIT 1",
      [bookId],
    );
    if (!latest) throw new Error('No open accounting period to post into');
    return latest;
  }

  /**
   * Resolve where a journal may legally be written and flag whether it was moved.
   * A direct write is allowed only into an OPEN period, dated within its bounds.
   * Corrections to a source whose journal sits in a CLOSED period are never written
   * into the closed period; they are redirected into the current open period, dated
   * today (clamped to that period), so closed-period totals stay frozen (see [H2]/[H3]).
   */
  private async resolvePostingTarget(bookId: string, periodId: string, date: string): Promise<{ periodId: string; date: string; redirectedFrom?: string }> {
    const period = await this.periodRow(bookId, periodId);
    if (period && period.status === 'open' && date >= period.start_date && date <= period.end_date) {
      return { periodId, date };
    }
    // Requested period is closed, missing, or the date is out of bounds → find an open period.
    const open = await this.currentOpenPeriod(bookId, today());
    const clamped = today() < open.start_date ? open.start_date : today() > open.end_date ? open.end_date : today();
    return { periodId: open.id, date: clamped, redirectedFrom: periodId };
  }

  private async insertSourceJournal(source: V2Source, input: any, lines: any[], reversalOf?: string) {
    assertBalanced(lines);
    const target = await this.resolvePostingTarget(source.bookId, input.periodId, source.date);
    const memo = input.memo || '';
    const sourceLoc = source.locationId || (source.metadata as { locationId?: string } | undefined)?.locationId || null;
    await this.repo.db.run('INSERT INTO v2_sources(id,book_id,type,date,reference,metadata,location_id) VALUES(?,?,?,?,?,?,?)', [source.id, source.bookId, source.type, target.date, source.reference || null, JSON.stringify(source.metadata || {}), sourceLoc]);
    const id = uid('je');
    await this.repo.db.run('INSERT INTO v2_journal_entries(id,book_id,period_id,source_id,date,memo,posted_at,reversal_of) VALUES(?,?,?,?,?,?,?,?)', [id, source.bookId, target.periodId, source.id, target.date, memo, new Date().toISOString(), reversalOf || null]);
    for (const l of lines) {
      await this.repo.db.run(
        'INSERT INTO v2_journal_lines(journal_id,account_id,party_id,debit,credit,memo,location_id) VALUES(?,?,?,?,?,?,?)',
        [id, l.accountId, l.partyId || null, cents(l.debit), cents(l.credit), l.memo || null, l.locationId || sourceLoc || null],
      );
    }
    return { id, bookId: source.bookId, periodId: target.periodId, sourceId: source.id, date: target.date, memo, lines };
  }

  private async insertReversal(old: any, journal: any, memo: string) {
    // If the original journal lives in a closed period, the correcting entry lands in the
    // current open period dated today; annotate the memo so the audit trail is explicit.
    const originalPeriod = await this.periodRow(old.book_id, journal.period_id);
    const closed = !originalPeriod || originalPeriod.status !== 'open';
    const reference = old.reference || old.id;
    const finalMemo = closed ? `${memo} — reversal of ${reference} dated ${old.date} (period closed)` : memo;
    let priorMeta: any = {};
    try { priorMeta = JSON.parse(old.metadata || '{}'); } catch { priorMeta = {}; }
    const source: V2Source = {
      id: uid('reversal'),
      bookId: old.book_id,
      type: `${old.type}_reversal`,
      date: old.date,
      locationId: old.location_id || priorMeta.locationId || undefined,
      metadata: {
        originalSourceId: old.id,
        originalDate: old.date,
        total: priorMeta.total,
        ...(priorMeta.locationId ? { locationId: priorMeta.locationId } : {}),
        ...(old.location_id ? { locationId: old.location_id } : {}),
        ...(closed ? { closedPeriodReversal: true } : {}),
      },
    };
    const input = { bookId: old.book_id, periodId: journal.period_id, date: old.date, memo: finalMemo };
    const lines = journal.lines.map((l: any) => ({ ...l, debit: l.credit, credit: l.debit }));
    const out = await this.insertSourceJournal(source, input, lines, journal.id);
    return { source, journal: out };
  }
}
