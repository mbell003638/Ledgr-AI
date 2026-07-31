import { V2_ACCOUNT_CODES, type V2PaymentMethod, type V2Party, type V2Source } from './types';
import { V2SqlRepository } from './repository';

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cents = (n: number) => Math.round(Number(n) * 100) / 100;
const positive = (n: number, label = 'Amount') => { const value = cents(n); if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`); return value; };

export type ReceiptInput = { bookId: string; periodId: string; partyId: string; date: string; amount: number; method: V2PaymentMethod; reference?: string; allocations?: { invoiceSourceId: string; amount: number }[] };

export class V2DocumentService {
  constructor(readonly repo: V2SqlRepository) {}

  async updateParty(id: string, patch: Partial<Pick<V2Party, 'name'|'phone'|'email'|'roles'>>) {
    const old = await this.repo.db.first<any>('SELECT * FROM v2_parties WHERE id=?', [id]);
    if (!old) throw new Error('Party not found');
    const roles = patch.roles ? JSON.stringify([...new Set(patch.roles)]) : old.roles;
    await this.repo.db.run('UPDATE v2_parties SET name=?, phone=?, email=?, roles=? WHERE id=?', [patch.name ?? old.name, patch.phone ?? old.phone, patch.email ?? old.email, roles, id]);
    return { ...old, name: patch.name ?? old.name, phone: patch.phone ?? old.phone, email: patch.email ?? old.email, roles: JSON.parse(roles) };
  }

  async archiveParty(id: string) {
    const party = await this.repo.db.first<any>('SELECT * FROM v2_parties WHERE id=?', [id]);
    if (!party) throw new Error('Party not found');
    const used = await this.repo.db.first('SELECT id FROM v2_sources WHERE book_id=? AND (json_extract(metadata,\'$.partyId\')=? OR json_extract(metadata,\'$.customerId\')=?) LIMIT 1', [party.book_id, id, id]);
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

  async reverseSource(sourceId: string, expectedType: string, memo: string, deleted = false) {
    return this.repoTx(async () => {
      const source = await this.sourceRow(sourceId, expectedType);
      if (expectedType === 'invoice') {
        const allocated = await this.repo.db.first('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [sourceId]);
        if (allocated) throw new Error('Cannot reverse an invoice with receipt allocations');
      } else if (expectedType === 'receipt') {
        await this.repo.db.run('DELETE FROM v2_invoice_allocations WHERE receipt_source_id=?', [sourceId]);
      }
      const original = await this.journalForSource(sourceId);
      const reversal = await this.insertReversal(source, original, memo);
      await this.repo.db.run("UPDATE v2_sources SET metadata=json_set(COALESCE(metadata,'{}'),'$.reversed',1,'$.deleted',?,'$.reversalSourceId',?) WHERE id=?", [deleted ? 1 : 0, reversal.source.id, sourceId]);
      return reversal;
    });
  }

  async editReceipt(receiptSourceId: string, input: Omit<ReceiptInput, 'bookId'|'partyId'> & { partyId?: string; bookId?: string }) {
    return this.repoTx(async () => {
      const old = await this.receiptRow(receiptSourceId);
      const reversal = await this.insertReversal(old, await this.journalForSource(receiptSourceId), 'Edit receipt');
      const next = await this.postReceiptInCurrentTransaction({ ...input, bookId: old.book_id, partyId: input.partyId || JSON.parse(old.metadata || '{}').partyId });
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
    let allocated = 0; const allocations = input.allocations || [];
    for (const a of allocations) { const value = positive(a.amount, 'Allocation'); const inv = await this.repo.db.first<any>("SELECT book_id,metadata FROM v2_sources WHERE id=? AND type='invoice'", [a.invoiceSourceId]); const meta = inv ? JSON.parse(inv.metadata || '{}') : {}; if (!inv || inv.book_id !== input.bookId || meta.partyId !== input.partyId || value > await this.repo.invoiceOpen(a.invoiceSourceId) + 0.005) throw new Error('Invalid invoice allocation'); allocated = cents(allocated + value); }
    if (allocated > amount + .005) throw new Error('Allocations exceed receipt');
    const source: V2Source = { id: uid('receipt'), bookId: input.bookId, type: 'receipt', date: input.date, reference: input.reference, metadata: { partyId: input.partyId, total: amount, method: input.method, allocated, advance: cents(amount - allocated) } };
    const lines = [{ accountId: `${input.bookId}:account:${this.paymentCode(input.method)}`, partyId: input.partyId, debit: amount, credit: 0 }, ...(allocated ? [{ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: 0, credit: allocated }] : []), ...(amount > allocated ? [{ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CUSTOMER_ADVANCES}`, partyId: input.partyId, debit: 0, credit: cents(amount - allocated) }] : [])];
    const journal = await this.insertSourceJournal(source, input, lines);
    for (const a of allocations) await this.repo.db.run('INSERT INTO v2_invoice_allocations(id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at) VALUES(?,?,?,?,?,?)', [uid('alloc'), input.bookId, a.invoiceSourceId, source.id, cents(a.amount), input.date]);
    return { source, journal, allocated, advance: cents(amount - allocated) };
  }

  private async simplePosting(input: any, type: string, memo: string, debitCode: string, creditAccount: string, partyId?: string) { const amount = positive(input.amount); return this.repoTx(async () => { const source: V2Source = { id: uid(type), bookId: input.bookId, type, date: input.date, metadata: { total: amount, partyId, method: input.method } }; const journal = await this.insertSourceJournal(source, input, [{ accountId: `${input.bookId}:account:${debitCode}`, partyId, debit: amount, credit: 0 }, { accountId: creditAccount.includes(':account:') ? creditAccount : `${input.bookId}:account:${creditAccount}`, partyId, debit: 0, credit: amount }]); return { source, journal }; }); }
  private paymentCode(method: V2PaymentMethod) { if (method === 'cash') return '1010'; if (method === 'bank') return V2_ACCOUNT_CODES.BANK; if (method === 'card') return V2_ACCOUNT_CODES.CARD; if (method === 'mobile') return V2_ACCOUNT_CODES.MOBILE; throw new Error('Unsupported payment method'); }
  private async repoTx<T>(fn: () => Promise<T>) { await this.repo.db.exec('BEGIN'); try { const x = await fn(); await this.repo.db.exec('COMMIT'); return x; } catch (e) { try { await this.repo.db.exec('ROLLBACK'); } catch {} throw e; } }
  private async receiptRow(id: string) { return this.sourceRow(id, 'receipt'); }
  private async sourceRow(id: string, type: string) { const row = await this.repo.db.first<any>('SELECT * FROM v2_sources WHERE id=? AND type=?', [id, type]); if (!row) throw new Error(`${type.replace(/_/g, ' ')} not found`); return row; }
  private async journalForSource(id: string) { const j = await this.repo.db.first<any>('SELECT * FROM v2_journal_entries WHERE source_id=?', [id]); if (!j) throw new Error('Receipt journal not found'); j.lines = await this.repo.db.all<any>('SELECT account_id AS accountId,party_id AS partyId,debit,credit,memo FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [j.id]); return j; }
  private async insertSourceJournal(source: V2Source, input: any, lines: any[], reversalOf?: string) { await this.repo.db.run('INSERT INTO v2_sources(id,book_id,type,date,reference,metadata) VALUES(?,?,?,?,?,?)', [source.id, source.bookId, source.type, source.date, source.reference || null, JSON.stringify(source.metadata || {})]); const id = uid('je'); await this.repo.db.run('INSERT INTO v2_journal_entries(id,book_id,period_id,source_id,date,memo,posted_at,reversal_of) VALUES(?,?,?,?,?,?,?,?)', [id, input.bookId, input.periodId, source.id, source.date, input.memo || '', new Date().toISOString(), reversalOf || null]); for (const l of lines) await this.repo.db.run('INSERT INTO v2_journal_lines(journal_id,account_id,party_id,debit,credit,memo) VALUES(?,?,?,?,?,?)', [id, l.accountId, l.partyId || null, cents(l.debit), cents(l.credit), l.memo || null]); return { id, bookId: input.bookId, periodId: input.periodId, sourceId: source.id, date: source.date, memo: input.memo || '', lines }; }
  private async insertReversal(old: any, journal: any, memo: string) { const source: V2Source = { id: uid('reversal'), bookId: old.book_id, type: `${old.type}_reversal`, date: old.date, metadata: { originalSourceId: old.id, total: JSON.parse(old.metadata || '{}').total } }; const input = { bookId: old.book_id, periodId: journal.period_id, date: old.date, memo }; const lines = journal.lines.map((l: any) => ({ ...l, debit: l.credit, credit: l.debit })); const out = await this.insertSourceJournal(source, input, lines, journal.id); return { source, journal: out }; }
}
