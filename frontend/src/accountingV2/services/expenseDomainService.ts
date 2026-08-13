import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2DocumentService } from '../documentService';
import { V2InvestorLedgerService } from '../investorLedgerService';
import { postExpense, postPurchase, postSupplierPayment } from '../postings';
import { V2_ACCOUNT_CODES, type V2PaymentMethod } from '../types';
import { round2 } from '../../money';
import type { PartyDomainService } from './partyDomainService';
import { ProductDomainService } from './productDomainService';

type AnyRecord = Record<string, any>;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => value === 'upi' ? 'mobile' : methods.has(value) ? value : 'cash';
const amount = (value: any) => Number(value);
const cents = round2;

export class ExpenseDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    readonly documents: V2DocumentService,
    readonly parties: PartyDomainService,
    private readonly getActiveContext: (date?: string) => Promise<{ bookId: string; periodId: string } | null>,
    private readonly editInput: (input: AnyRecord) => Promise<AnyRecord>,
    private readonly sourceType: (id: string) => Promise<string | null>,
  ) {}

  async createExpense(input: AnyRecord) {
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return postExpense(this.repo, {
      ...c,
      date: input.date,
      amount: amount(input.amount),
      method: method(input.method),
      metadata: { category: input.category, notes: input.notes },
    });
  }

  async updateExpense(id: string, input: AnyRecord) {
    const next = await this.editInput(input);
    return this.documents.replaceSource(id, 'expense', 'Edit expense', () => this.createExpense(next));
  }

  async deleteExpense(id: string) {
    return this.documents.reverseSource(id, 'expense', 'Delete expense', true);
  }

  async listBills() {
    const context = await this.getActiveContext();
    if (!context) return [];
    await this.parties.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>(
      "SELECT s.id,s.type,s.date,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_purchase','credit_purchase') ORDER BY s.date DESC,s.id DESC",
      [context.bookId],
    );
    return rows.flatMap((row) => {
      const meta = JSON.parse(row.metadata || '{}');
      return meta.deleted || meta.reversed
        ? []
        : [{
            id: row.id,
            sourceType: row.type,
            date: row.date,
            amount: Number(meta.total || 0),
            supplierId: meta.partyId,
            supplierName: row.party_name,
            partyName: row.party_name,
            paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit',
            method: meta.method,
            invoiceNo: meta.invoiceNo || '',
            notes: meta.notes || '',
            photo: meta.photo || '',
          }];
    });
  }

  async createBill(input: AnyRecord) {
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const cash = input.paymentType === 'cash';
    const productLines = Array.isArray(input.productLines) ? input.productLines : [];
    return this.repo.runInTransaction(async () => {
      const partyId = await this.parties.party(input, 'supplier', c.bookId);
      const result = await postPurchase(this.repo, {
        ...c,
        date: input.date,
        partyId,
        amount: amount(input.amount ?? input.total),
        method: cash ? method(input.method) : undefined,
        metadata: {
          category: input.category,
          isExpense: input.isExpense,
          invoiceNo: input.invoiceNo,
          notes: input.notes,
          photo: input.photo,
          ...(productLines.length ? { productLines } : {}),
        },
      });
      const isExpense = input.isExpense === true || input.billType === 'expense';
      if (!isExpense && productLines.length) {
        await new ProductDomainService(this.db, this.repo, this.getActiveContext)
          .applyPurchaseLines(c.bookId, c.periodId, input.date, result.source.id, productLines);
      }
      return result;
    });
  }

  async updateBill(id: string, input: AnyRecord) {
    const row = await this.db.first<any>('SELECT type,metadata FROM v2_sources WHERE id=?', [id]);
    if (!row || !['cash_purchase', 'credit_purchase'].includes(row.type)) throw new Error('Bill not found');
    const next = await this.editInput(input);
    let priorMeta: AnyRecord = {};
    try { priorMeta = JSON.parse(row.metadata || '{}'); } catch { priorMeta = {}; }
    const payload = Array.isArray(next.productLines) ? next : { ...next, productLines: priorMeta.productLines };
    return this.documents.replaceSource(id, row.type, 'Edit bill', () => this.createBill(payload));
  }

  async deleteBill(id: string) {
    const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]);
    if (!row || !['cash_purchase', 'credit_purchase'].includes(row.type)) throw new Error('Bill not found');
    return this.documents.reverseSource(id, row.type, 'Delete bill', true);
  }

  async createPayment(input: AnyRecord) {
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    if (input.type === 'commission_payment') {
      const value = amount(input.amount);
      const payableId = `${c.bookId}:account:${V2_ACCOUNT_CODES.COMMISSION_PAYABLE}`;
      const outstanding = cents(-await this.repo.accountBalance(c.bookId, payableId));
      if (value > outstanding + 0.005) throw new Error('Commission payment exceeds the commission payable balance');
      const paymentMethod = method(input.method);
      const paymentCode = paymentMethod === 'bank' ? V2_ACCOUNT_CODES.BANK
        : paymentMethod === 'card' ? V2_ACCOUNT_CODES.CARD
        : paymentMethod === 'mobile' ? V2_ACCOUNT_CODES.MOBILE
        : V2_ACCOUNT_CODES.CASH;
      const source: any = {
        id: 'commission_payment_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        bookId: c.bookId,
        type: 'commission_payment',
        date: input.date,
        metadata: { total: value, method: paymentMethod, notes: input.notes || '' },
      };
      const journal = await this.repo.postSourceJournal(source, {
        bookId: c.bookId,
        periodId: c.periodId,
        date: input.date,
        memo: input.notes?.trim() || 'Manager commission payment',
        lines: [
          { accountId: payableId, debit: value, credit: 0 },
          { accountId: `${c.bookId}:account:${paymentCode}`, debit: 0, credit: value },
        ],
      });
      return { source, journal };
    }
    if (input.type === 'drawing') {
      const book = await this.db.first<{ style: string }>('SELECT style FROM v2_books WHERE id=?', [c.bookId]);
      if (book?.style === 'retail_partnership') {
        return new V2InvestorLedgerService(this.db).draw({
          ...c,
          date: input.date,
          amount: amount(input.amount),
          memberId: String(input.investorId || input.partnerName || ''),
          notes: input.notes,
        });
      }
      return this.documents.drawing({ ...c, date: input.date, amount: amount(input.amount), method: method(input.method) });
    }
    return this.repo.runInTransaction(async () => {
      const partyId = await this.parties.party(input, 'supplier', c.bookId);
      return postSupplierPayment(this.repo, {
        ...c,
        date: input.date,
        partyId,
        amount: amount(input.amount),
        method: method(input.method),
        metadata: { notes: input.notes },
      });
    });
  }

  async updatePayment(id: string, input: AnyRecord) {
    const type = await this.sourceType(id);
    const next = await this.editInput(input);
    if (type === 'supplier_payment') return this.documents.replaceSource(id, type, 'Edit supplier payment', () => this.createPayment(next));
    if (type === 'commission_payment') return this.documents.replaceSource(id, type, 'Edit commission payment', () => this.createPayment({ ...next, type }));
    if (type !== 'drawing') throw new Error('Payment not found');
    const source = await this.db.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=?', [id]);
    let metadata: AnyRecord = {};
    try { metadata = JSON.parse(source?.metadata || '{}'); } catch { metadata = {}; }
    const replacement = { ...next, type: 'drawing', investorId: next.investorId || metadata.memberId, partnerName: next.partnerName || metadata.memberName };
    return this.documents.replaceSource(id, type, 'Edit member drawing', () => this.createPayment(replacement));
  }

  async deletePayment(id: string) {
    const type = await this.sourceType(id);
    if (type !== 'supplier_payment' && type !== 'drawing' && type !== 'commission_payment') throw new Error('Payment not found');
    return this.documents.reverseSource(id, type, type === 'drawing' ? 'Delete member drawing' : type === 'commission_payment' ? 'Delete commission payment' : 'Delete supplier payment', true);
  }
}
