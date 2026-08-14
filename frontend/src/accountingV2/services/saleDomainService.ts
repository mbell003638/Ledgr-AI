import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2DocumentService } from '../documentService';
import { postCashSale, postReceipt, postCreditNote, postDebitNote } from '../postings';
import { calculateInvoiceTotals } from '../../utils/invoiceTotals';
import { V2_ACCOUNT_CODES, type V2PaymentMethod } from '../types';
import { round2 } from '../../money';
import type { PartyDomainService } from './partyDomainService';
import type { InvoiceDomainService } from './invoiceDomainService';
import { ProductDomainService } from './productDomainService';
import { resolveWriteLocationId } from './locationDomainService';

type AnyRecord = Record<string, any>;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => value === 'upi' ? 'mobile' : methods.has(value) ? value : 'cash';
const paymentMethodOrUndefined = (value: any): V2PaymentMethod | undefined =>
  value === 'upi' ? 'mobile' : methods.has(value) ? value : undefined;
const amount = (value: any) => Number(value);
const cents = round2;

export class SaleDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    readonly documents: V2DocumentService,
    readonly parties: PartyDomainService,
    readonly invoices: InvoiceDomainService,
    private readonly getActiveContext: (date?: string) => Promise<{ bookId: string; periodId: string } | null>,
    private readonly editInput: (input: AnyRecord) => Promise<AnyRecord>,
    private readonly sourceType: (id: string) => Promise<string | null>,
  ) {}

  async createSale(input: AnyRecord) {
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const totals = lines.length ? calculateInvoiceTotals(lines, input.discount || 0, input.taxRate || 0) : null;
    const net = totals?.total ?? amount(input.total ?? input.amount);
    const productLines = Array.isArray(input.productLines) ? input.productLines : [];
    const locationId = await resolveWriteLocationId(this.db, c.bookId, input.locationId);
    return this.repo.runInTransaction(async () => {
      const result = await postCashSale(this.repo, {
        ...c,
        date: input.date,
        amount: net,
        method: method(input.method),
        reference: input.reference,
        locationId: locationId || undefined,
        metadata: {
          notes: input.notes,
          lines,
          discount: totals?.discount ?? Number(input.discount || 0),
          subtotal: totals?.subtotal ?? (input.subtotal != null ? Number(input.subtotal) : (input.tax != null ? Number(net) - Number(input.tax) : net)),
          tax: totals?.tax ?? Number(input.tax || 0),
          taxRate: Number(input.taxRate || 0),
          ...(productLines.length ? { productLines } : {}),
        },
      });
      if (productLines.length) {
        await new ProductDomainService(this.db, this.repo, this.getActiveContext)
          .applySaleLines(c.bookId, c.periodId, input.date, result.source.id, productLines, locationId || undefined);
      }
      return result;
    });
  }

  async updateSale(id: string, input: AnyRecord) {
    const row = await this.db.first<any>('SELECT type,metadata FROM v2_sources WHERE id=?', [id]);
    if (row?.type === 'invoice' || row?.type === 'credit_sale' || input.clientName || input.partyId) {
      return this.invoices.updateInvoice(id, input);
    }
    const sourceType = row?.type && ['cash_sale', 'credit_sale', 'invoice'].includes(row.type) ? row.type : 'cash_sale';
    const next = await this.editInput(input);
    let priorMeta: AnyRecord = {};
    try { priorMeta = JSON.parse(row?.metadata || '{}'); } catch { priorMeta = {}; }
    const payload = Array.isArray(next.productLines) ? next : { ...next, productLines: priorMeta.productLines };
    return this.documents.replaceSource(id, sourceType, 'Edit sale', () => this.createSale(payload));
  }

  async deleteSale(id: string) {
    const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]);
    if (!row) throw new Error('Sale not found');
    if (['cash_sale', 'credit_sale', 'invoice'].includes(row.type)) {
      return this.documents.reverseSource(id, row.type, 'Delete sale', true);
    }
    return this.documents.reverseSource(id, 'cash_sale', 'Delete cash sale', true);
  }

  async createReceipt(input: AnyRecord) {
    const isUnnamedCashSale = input.mode === 'cash_sale' || (!input.partyId && !input.debtorId && !input.clientName && (!input.allocations || input.allocations.length === 0));
    if (isUnnamedCashSale) {
      return this.createSale(input);
    }
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const allocations = (input.allocations || []).map((a: AnyRecord) => ({
      invoiceSourceId: a.invoiceSourceId || a.invoiceId,
      amount: amount(a.amount ?? a.amountApplied),
    }));
    const locationId = await resolveWriteLocationId(this.db, c.bookId, input.locationId);
    return this.repo.runInTransaction(async () => {
      const partyId = await this.parties.party(input, 'customer', c.bookId);
      return postReceipt(this.repo, {
        ...c,
        date: input.date,
        partyId,
        amount: amount(input.amount),
        method: method(input.method),
        reference: input.reference,
        allocations,
        locationId: locationId || undefined,
        metadata: {
          mode: input.mode,
          notes: input.notes,
          taxLabel: input.taxLabel,
          taxRate: input.taxRate,
        },
      });
    });
  }

  async updateReceipt(id: string, input: AnyRecord) {
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return this.documents.editReceipt(id, {
      ...input,
      ...c,
      date: String(input.date),
      amount: amount(input.amount),
      method: method(input.method),
    });
  }

  async deleteReceipt(id: string) {
    return this.documents.deleteReceipt(id);
  }

  private async createNoteV2(input: AnyRecord, kind: 'credit_note' | 'debit_note') {
    const role: 'customer' | 'supplier' = input.role === 'supplier' ? 'supplier' : 'customer';
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const locationId = await resolveWriteLocationId(this.db, c.bookId, input.locationId);
    return this.repo.runInTransaction(async () => {
      const partyId = await this.parties.party(input, role, c.bookId);
      const post = kind === 'credit_note' ? postCreditNote : postDebitNote;
      return post(this.repo, {
        ...c,
        date: input.date,
        partyId,
        locationId: locationId || undefined,
        invoiceSourceId: input.invoiceId || input.invoiceSourceId || null,
        amount: amount(input.amount),
        role,
        reference: input.reference,
        reason: input.reason,
        notes: input.notes,
        method: paymentMethodOrUndefined(input.method),
      });
    });
  }

  async createCreditNote(input: AnyRecord) {
    return this.createNoteV2(input, 'credit_note');
  }

  async createDebitNote(input: AnyRecord) {
    return this.createNoteV2(input, 'debit_note');
  }

  async updateNote(id: string, input: AnyRecord) {
    const row = await this.db.first<{ type: string; date: string; reference: string | null; metadata: string }>(
      "SELECT type,date,reference,metadata FROM v2_sources WHERE id=? AND type IN ('credit_note','debit_note')",
      [id],
    );
    if (!row) throw new Error('Debit / credit note not found');
    let prior: AnyRecord = {};
    try { prior = JSON.parse(row.metadata || '{}'); } catch { prior = {}; }
    const originalPartyId = String(prior.partyId || '');
    const originalRole: 'customer' | 'supplier' = prior.role === 'supplier' ? 'supplier' : 'customer';
    if (!originalPartyId) throw new Error('Debit / credit note has no party');
    const next = await this.editInput({
      date: input.date ?? row.date,
      amount: input.amount ?? prior.total,
      reference: input.reference ?? row.reference ?? '',
      reason: input.reason ?? prior.reason ?? '',
      notes: input.notes ?? prior.notes ?? '',
    });
    const create = row.type === 'credit_note' ? this.createCreditNote.bind(this) : this.createDebitNote.bind(this);
    return this.documents.replaceSource(id, row.type, 'Edit debit / credit note', () => create({
      ...next,
      role: originalRole,
      partyId: originalPartyId,
      debtorId: originalRole === 'customer' ? originalPartyId : undefined,
      supplierId: originalRole === 'supplier' ? originalPartyId : undefined,
      invoiceSourceId: prior.invoiceSourceId || null,
    }));
  }

  async deleteNote(id: string) {
    const type = await this.sourceType(id);
    if (type !== 'credit_note' && type !== 'debit_note') throw new Error('Debit / credit note not found');
    return this.documents.reverseSource(id, type, 'Reverse debit / credit note', true);
  }

  async listCashMovements() {
    const context = await this.getActiveContext();
    if (!context) return [];
    const rows = await this.db.all<any>(`
      SELECT e.id, e.date, e.memo AS notes, e.posted_at, e.reversal_of, e.source_id,
             l.debit, l.credit, s.type AS source_type, s.metadata AS source_metadata
      FROM v2_journal_entries e
      JOIN v2_journal_lines l ON e.id = l.journal_id
      LEFT JOIN v2_sources s ON e.source_id = s.id
      WHERE e.book_id = ? AND l.account_id IN (?,?,?,?)
      ORDER BY e.date DESC, e.id DESC
    `, [
      context.bookId,
      `${context.bookId}:account:${V2_ACCOUNT_CODES.CASH}`,
      `${context.bookId}:account:${V2_ACCOUNT_CODES.BANK}`,
      `${context.bookId}:account:${V2_ACCOUNT_CODES.CARD}`,
      `${context.bookId}:account:${V2_ACCOUNT_CODES.MOBILE}`,
    ]);
    return rows.map((row) => {
      let meta: AnyRecord = {};
      try { meta = JSON.parse(row.source_metadata || '{}'); } catch { /* empty */ }
      const isOut = Number(row.credit) > 0;
      return {
        id: row.id,
        amount: isOut ? Number(row.credit) : Number(row.debit),
        direction: isOut ? 'out' : 'in',
        date: row.date,
        notes: row.notes,
        created_at: row.posted_at,
        postedAt: row.posted_at,
        sourceId: row.source_id || null,
        sourceType: row.source_type || null,
        sourceNotes: meta.notes ? String(meta.notes) : '',
        memberId: meta.memberId ? String(meta.memberId) : null,
        reversalOf: row.reversal_of || null,
        sourceReversed: !!meta.reversed,
        sourceDeleted: !!meta.deleted,
      };
    });
  }

  async recordManualCash(input: { date: string; amount: number; direction: 'in' | 'out'; notes?: string; locationId?: string }) {
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Cash amount must be positive');
    const locationId = await resolveWriteLocationId(this.db, context.bookId, input.locationId);
    await this.repo.ensureDefaultAccounts(context.bookId);
    const isIn = input.direction === 'in';
    const source: any = {
      id: 'manual_cash_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      bookId: context.bookId,
      type: isIn ? 'manual_cash_income' : 'manual_cash_expense',
      date: input.date,
      locationId: locationId || undefined,
      metadata: { total: value, direction: input.direction, notes: input.notes || '', ...(locationId ? { locationId } : {}) },
    };
    const cashId = `${context.bookId}:account:${V2_ACCOUNT_CODES.CASH}`;
    const counterpartId = `${context.bookId}:account:${isIn ? V2_ACCOUNT_CODES.SALES : V2_ACCOUNT_CODES.EXPENSES}`;
    const lines = isIn
      ? [{ accountId: cashId, debit: value, credit: 0 }, { accountId: counterpartId, debit: 0, credit: value }]
      : [{ accountId: counterpartId, debit: value, credit: 0 }, { accountId: cashId, debit: 0, credit: value }];
    const journal = await this.repo.postSourceJournal(source, {
      bookId: context.bookId,
      periodId: context.periodId,
      date: input.date,
      memo: input.notes?.trim() || (isIn ? 'General cash income' : 'General cash expense'),
      lines,
    });
    return { source, journal };
  }

  async updateManualCash(sourceId: string, input: { date: string; amount: number; direction: 'in' | 'out'; notes?: string }) {
    const source = await this.db.first<{ type: string }>('SELECT type FROM v2_sources WHERE id=?', [sourceId]);
    if (!source || !['manual_cash_income', 'manual_cash_expense'].includes(source.type)) throw new Error('Manual cash entry not found');
    return this.documents.replaceSource(sourceId, source.type, 'Edit manual cash entry', () => this.recordManualCash(input));
  }

  async deleteManualCash(sourceId: string) {
    const source = await this.db.first<{ type: string }>('SELECT type FROM v2_sources WHERE id=?', [sourceId]);
    if (!source || !['manual_cash_income', 'manual_cash_expense'].includes(source.type)) throw new Error('Manual cash entry not found');
    return this.documents.reverseSource(sourceId, source.type, 'Delete manual cash entry', true);
  }
}
