import type { SqlRunner } from '../db/schema';
import { V2SqlRepository } from './repository';
import { V2CloseBooksRepository, type CloseBooksResult } from './closeBooksRepository';
import { V2_BOOK_VERSION, accountingBookVersion } from './appBootstrap';
import { postCashSale, postInvoice, postReceipt, postPurchase, postSupplierPayment, postExpense } from './postings';
import { V2BookConfigRepository, type V2BookConfigUpdate } from './bookConfigRepository';
import { V2DocumentService } from './documentService';
import { V2InvestorLedgerService } from './investorLedgerService';
import type { V2PaymentMethod, V2PartyRole } from './types';

type AnyRecord = Record<string, any>;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => methods.has(value) ? value : 'cash';
const amount = (value: any) => Number(value);
const normalized = (value: any) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
export function sanitizePartyName(raw: string): string {
  if (!raw) return '';
  let s = String(raw).trim();
  while (/^v2:(customer|supplier|partner):/i.test(s)) {
    s = s.replace(/^v2:(customer|supplier|partner):/i, '').trim();
  }
  return s;
}

let partyRepairSequence = 0;
const partyDisplayName = (value: any) => sanitizePartyName(value);
const stablePartyId = (role: V2PartyRole, input: AnyRecord) => {
  const explicit = input.partyId || input[role === 'customer' ? 'debtorId' : 'supplierId'];
  if (explicit) return String(explicit);
  return `v2:${role}:${normalized(partyDisplayName(input[role === 'customer' ? 'clientName' : 'supplierName']))}`;
};

export type V2ActiveContext = { bookId: string; periodId: string };
export type V2CloseBooksAppInput = { actualStock: number; openingInventory: number; commissionPct: number; notes?: string };
export type V2CloseBooksAppResult = { source: 'v2'; result: CloseBooksResult };
type PeriodRow = { id: string; start_date: string; end_date: string };
const dayAfter = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const endOfMonth = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

/** The application boundary for normal transaction writes. Legacy collections are not touched here. */
export class V2AppService {
  readonly repo: V2SqlRepository;
  readonly documents: V2DocumentService;
  constructor(readonly db: SqlRunner) { this.repo = new V2SqlRepository(db); this.documents = new V2DocumentService(this.repo); }

  async activeContext(date?: string): Promise<V2ActiveContext | null> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) return null;
    const period = await this.db.first<{ id: string }>("SELECT id FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=COALESCE(?,start_date) AND end_date>=COALESCE(?,end_date) ORDER BY start_date DESC LIMIT 1", [active.value, date || null, date || null]);
    return period ? { bookId: active.value, periodId: period.id } : null;
  }

  private async party(input: AnyRecord, role: V2PartyRole, bookId: string) {
    const id = stablePartyId(role, input);
    const requestedName = partyDisplayName(input[role === 'customer' ? 'clientName' : 'supplierName']);
    const name = requestedName || partyDisplayName(input.partyId || id) || id;
    const existing = await this.db.first('SELECT id FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
    if (!existing) await this.repo.createParty({ id, bookId, name, phone: input.clientPhone || input.phone, email: input.email, roles: [role] });
    else {
      const row = await this.db.first<{ roles: string }>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
      const roles: V2PartyRole[] = row ? JSON.parse(row.roles) : [];
      if (!roles.includes(role)) await this.db.run('UPDATE v2_parties SET roles=? WHERE id=?', [JSON.stringify([...roles, role]), id]);
    }
    return id;
  }

  async ensureParty(name: string, role: V2PartyRole, details: { phone?: string; email?: string } = {}) {
    const context = await this.activeContext();
    if (!context) throw new Error('No active versioned V2 book');
    const id = await this.party({ [role === 'customer' ? 'clientName' : 'supplierName']: partyDisplayName(name), phone: details.phone, email: details.email }, role, context.bookId);
    return this.db.first<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE id=? AND book_id=?', [id, context.bookId]);
  }

  private async repairPartyIdentities(bookId: string) {
    const savepoint = `v2_party_repair_${++partyRepairSequence}`;
    await this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const rows = await this.db.all<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE book_id=?', [bookId]);
      const sources = await this.db.all<any>('SELECT id,metadata FROM v2_sources WHERE book_id=?', [bookId]);
      for (const row of rows) {
        const cleanName = partyDisplayName(row.name);
        let roles: V2PartyRole[] = [];
        try { roles = JSON.parse(row.roles || '[]'); } catch { roles = []; }
        const role = roles.includes('supplier') && !roles.includes('customer') ? 'supplier' : 'customer';
        const canonicalId = `v2:${role}:${normalized(cleanName)}`;
        const corrupt = cleanName !== String(row.name || '').trim() || /^v2:(customer|supplier):v2:/i.test(row.id);
        if (!corrupt || !cleanName) continue;
        if (row.id === canonicalId) {
          await this.db.run('UPDATE v2_parties SET name=? WHERE id=? AND book_id=?', [cleanName, row.id, bookId]);
          continue;
        }
        const canonical = await this.db.first<any>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [canonicalId, bookId]);
        if (!canonical) {
          await this.repo.createParty({ id: canonicalId, bookId, name: cleanName, phone: row.phone, email: row.email, roles: roles.length ? roles : [role] });
        } else {
          let canonicalRoles: V2PartyRole[] = [];
          try { canonicalRoles = JSON.parse(canonical.roles || '[]'); } catch { canonicalRoles = []; }
          await this.db.run('UPDATE v2_parties SET roles=? WHERE id=?', [JSON.stringify([...new Set([...canonicalRoles, ...roles])]), canonicalId]);
        }
        await this.db.run('UPDATE v2_journal_lines SET party_id=? WHERE party_id=?', [canonicalId, row.id]);
        for (const source of sources) {
          let metadata: any = {};
          try { metadata = JSON.parse(source.metadata || '{}'); } catch { continue; }
          let changed = false;
          for (const key of ['partyId', 'customerId']) if (metadata[key] === row.id) { metadata[key] = canonicalId; changed = true; }
          if (changed) {
            source.metadata = JSON.stringify(metadata);
            await this.db.run('UPDATE v2_sources SET metadata=? WHERE id=?', [source.metadata, source.id]);
          }
        }
        await this.db.run('DELETE FROM v2_parties WHERE id=? AND book_id=?', [row.id, bookId]);
      }
      await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      try {
        await this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve the repair failure */ }
      throw error;
    }
  }
  async listParties() {
    const context = await this.activeContext(); if (!context) return [];
    await this.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>('SELECT id,name,phone,email,roles,archived FROM v2_parties WHERE book_id=? AND archived=0 ORDER BY name', [context.bookId]);
    const result = [];
    for (const row of rows) {
      const ar = await this.db.first<{ balance:number }>(`SELECT COALESCE(SUM(l.debit-l.credit),0) balance FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id JOIN v2_accounts a ON a.id=l.account_id WHERE j.book_id=? AND l.party_id=? AND a.code='1100'`, [context.bookId,row.id]);
      const ap = await this.db.first<{ balance:number }>(`SELECT COALESCE(SUM(l.credit-l.debit),0) balance FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id JOIN v2_accounts a ON a.id=l.account_id WHERE j.book_id=? AND l.party_id=? AND a.code='2000'`, [context.bookId,row.id]);
      result.push({ id:row.id,name:row.name,phone:row.phone,email:row.email,roles:JSON.parse(row.roles),receivable:Number(ar?.balance||0),payable:Number(ap?.balance||0),net:Number(ar?.balance||0)-Number(ap?.balance||0) });
    }
    return result;
  }

  /** Resolve a party detail view directly from the authoritative V2 ledger. */
  async getPartyDetail(id: string, role: 'customer' | 'supplier') {
    const context = await this.activeContext(); if (!context) return null;
    await this.repairPartyIdentities(context.bookId);
    const party = await this.db.first<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE id=? AND book_id=? AND archived=0', [id, context.bookId]);
    if (!party) return null;
    let roles: string[] = []; try { roles = JSON.parse(party.roles || '[]'); } catch { roles = []; }
    if (!roles.includes(role)) return null;
    const sourceTypes = role === 'customer' ? ['invoice', 'receipt', 'credit_note', 'debit_note'] : ['cash_purchase', 'credit_purchase', 'supplier_payment'];
    const placeholders = sourceTypes.map(() => '?').join(','); const accountCode = role === 'customer' ? '1100' : '2000';
    const rows = await this.db.all<any>(`SELECT s.id,s.type,s.date,s.reference,s.metadata,
      COALESCE(SUM(CASE WHEN a.code=? THEN l.debit ELSE 0 END),0) AS debit,
      COALESCE(SUM(CASE WHEN a.code=? THEN l.credit ELSE 0 END),0) AS credit
      FROM v2_sources s LEFT JOIN v2_journal_entries j ON j.source_id=s.id
      LEFT JOIN v2_journal_lines l ON l.journal_id=j.id AND l.party_id=? LEFT JOIN v2_accounts a ON a.id=l.account_id
      WHERE s.book_id=? AND json_extract(s.metadata,'$.partyId')=? AND s.type IN (${placeholders})
      GROUP BY s.id,s.type,s.date,s.reference,s.metadata ORDER BY s.date,s.id`, [accountCode, accountCode, id, context.bookId, id, ...sourceTypes]);
    const active = rows.flatMap((row) => {
      let metadata: AnyRecord = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; }
      if (metadata.deleted || metadata.reversed || metadata.isReversal || String(row.type).endsWith('_reversal')) return [];
      return [{ ...row, metadata }];
    });
    const cents = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
    if (role === 'customer') {
      let running = 0;
      const ledger = active.map((row) => {
        const debit = cents(row.debit);
        const credit = cents(row.credit);
        running = cents(running + debit - credit);
        return {
          id: row.id,
          kind: row.type,
          date: row.date,
          ref: row.reference,
          notes: row.metadata.notes || '',
          debit,
          credit,
          balance: running,
          isEdited: !!(row.metadata.isEdited || row.metadata.editedAt),
          editedAt: row.metadata.editedAt || null,
          originalDate: row.metadata.originalDate || null,
        };
      });
      const totalInvoiced = cents(active.filter((row) => row.type === 'invoice').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      const totalPaid = cents(active.filter((row) => row.type === 'receipt').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles,
        payments: active.filter((row) => row.type === 'receipt').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '', isEdited: !!(row.metadata.isEdited || row.metadata.editedAt), editedAt: row.metadata.editedAt || null })),
        totalInvoiced, totalPaid, balance: running, statement: { ledger: ledger.slice().reverse(), balance: running } };
    }
    const bills = active.filter((row) => row.type === 'cash_purchase' || row.type === 'credit_purchase').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), invoiceNo: row.metadata.invoiceNo || row.reference || '', notes: row.metadata.notes || '', paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit', isEdited: !!(row.metadata.isEdited || row.metadata.editedAt), editedAt: row.metadata.editedAt || null }));
    const payments = active.filter((row) => row.type === 'supplier_payment').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '', reference: row.reference || '', isEdited: !!(row.metadata.isEdited || row.metadata.editedAt), editedAt: row.metadata.editedAt || null }));
    const billsTotal = cents(bills.reduce((sum, row) => sum + row.amount, 0)); const paymentsTotal = cents(payments.reduce((sum, row) => sum + row.amount, 0));
    const balance = cents(active.reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0));
    return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles, bills: bills.reverse(), payments: payments.reverse(), billsTotal, paymentsTotal, balance };
  }

  async getPartyStatement(partyId: string) {
    const detail = await this.getPartyDetail(partyId, 'customer');
    if (detail) return { ledger: detail.statement?.ledger || [], balance: detail.balance || 0 };
    const supplierDetail = await this.getPartyDetail(partyId, 'supplier');
    if (supplierDetail) return { ledger: [], balance: supplierDetail.balance || 0 };
    return { ledger: [], balance: 0 };
  }

  async updateParty(id: string, patch: AnyRecord) { return this.documents.updateParty(id, patch); }
  async archiveParty(id: string) { return this.documents.archiveParty(id); }
  async listSalesAndInvoices() {
    const context=await this.activeContext(); if(!context)return [];
    await this.repairPartyIdentities(context.bookId);
    const rows=await this.db.all<any>("SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_sale','invoice') ORDER BY s.date DESC,s.id DESC",[context.bookId]);
    const result=[];
    for(const row of rows){
      const meta=JSON.parse(row.metadata||'{}');
      if(meta.deleted||meta.reversed||meta.isReversal||String(row.type).endsWith('_reversal'))continue;
      const open=row.type==='invoice'?await this.repo.invoiceOpen(row.id):0;
      result.push({id:row.id,type:row.type,date:row.date,reference:row.reference,amount:Number(meta.total||0),partyId:meta.partyId,partyName:row.party_name,clientName:row.party_name,status:row.type==='cash_sale'?'paid':open<=0?'paid':open<Number(meta.total||0)?'partial':'unpaid',openAmount:open,notes:meta.notes,method:meta.method,isEdited:!!(meta.isEdited||meta.editedAt),editedAt:meta.editedAt||null});
    }
    return result;
  }

  async listBills() {
    const context = await this.activeContext(); if (!context) return [];
    await this.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>("SELECT s.id,s.type,s.date,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_purchase','credit_purchase') ORDER BY s.date DESC,s.id DESC", [context.bookId]);
    return rows.flatMap((row) => { const meta = JSON.parse(row.metadata || '{}'); return meta.deleted || meta.reversed || meta.isReversal || String(row.type).endsWith('_reversal') ? [] : [{ id: row.id, sourceType: row.type, date: row.date, amount: Number(meta.total || 0), supplierId: meta.partyId, supplierName: row.party_name, partyName: row.party_name, paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit', method: meta.method, invoiceNo: meta.invoiceNo || '', notes: meta.notes || '', photo: meta.photo || '', isEdited: !!(meta.isEdited || meta.editedAt), editedAt: meta.editedAt || null }]; });
  }

  async createSale(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postCashSale(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method), reference: input.reference, metadata: { notes: input.notes } }); }
  async createInvoice(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'customer', c.bookId); return postInvoice(this.repo, { ...c, date: input.date, partyId, amount: amount(input.total ?? input.amount), reference: input.invoiceNumber || input.reference }); }
  async createReceipt(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'customer', c.bookId); const allocations = (input.allocations || []).map((a: AnyRecord) => ({ invoiceSourceId: a.invoiceSourceId || a.invoiceId, amount: amount(a.amount ?? a.amountApplied) })); return postReceipt(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method), reference: input.reference, allocations }); }
  async createBill(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'supplier', c.bookId); const cash = input.paymentType === 'cash'; return postPurchase(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount ?? input.total), method: cash ? method(input.method) : undefined, metadata: { invoiceNo: input.invoiceNo, notes: input.notes, photo: input.photo } }); }
  async createPayment(input: AnyRecord) {
    const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    if (input.type === 'drawing') {
      const book = await this.db.first<{ style: string }>('SELECT style FROM v2_books WHERE id=?', [c.bookId]);
      if (book?.style === 'retail_partnership') {
        return new V2InvestorLedgerService(this.db).draw({ ...c, date: input.date, amount: amount(input.amount), memberId: String(input.investorId || input.partnerName || ''), notes: input.notes });
      }
      return this.documents.drawing({ ...c, date: input.date, amount: amount(input.amount), method: method(input.method) });
    }
    const partyId = await this.party(input, 'supplier', c.bookId);
    return postSupplierPayment(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method) });
  }
  async createExpense(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postExpense(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method) }); }

  async sourceType(id: string): Promise<string | null> {
    const row = await this.db.first<{ type: string }>('SELECT type FROM v2_sources WHERE id=?', [id]);
    return row?.type || null;
  }

  async ownsSource(id: string, type?: string) {
    const sourceType = await this.sourceType(id);
    return Boolean(sourceType && (!type || sourceType === type));
  }
  async deleteReceipt(id: string) { return this.documents.deleteReceipt(id); }
  async deleteInvoice(id: string) { return this.documents.reverseSource(id, 'invoice', 'Delete invoice', true); }
  async deleteExpense(id: string) { return this.documents.reverseSource(id, 'expense', 'Delete expense', true); }
  async deletePayment(id: string) { const type = await this.sourceType(id); if (type !== 'supplier_payment' && type !== 'drawing') throw new Error('Payment not found'); return this.documents.reverseSource(id, type, type === 'drawing' ? 'Delete member drawing' : 'Delete supplier payment', true); }
  async deleteSale(id: string) {
    const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]);
    if (!row) throw new Error('Sale not found');
    if (['cash_sale', 'credit_sale', 'invoice'].includes(row.type)) {
      return this.documents.reverseSource(id, row.type, 'Delete sale', true);
    }
    return this.documents.reverseSource(id, 'cash_sale', 'Delete cash sale', true);
  }
  async deleteBill(id: string) { const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]); if (!row || !['cash_purchase', 'credit_purchase'].includes(row.type)) throw new Error('Bill not found'); return this.documents.reverseSource(id, row.type, 'Delete bill', true); }
  async updateExpense(id: string, input: AnyRecord) { return this.documents.replaceSource(id, 'expense', 'Edit expense', () => this.createExpense(input)); }
  async updatePayment(id: string, input: AnyRecord) {
    const type = await this.sourceType(id);
    if (type === 'supplier_payment') return this.documents.replaceSource(id, type, 'Edit supplier payment', () => this.createPayment(input));
    if (type !== 'drawing') throw new Error('Payment not found');
    const source = await this.db.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=?', [id]);
    let metadata: AnyRecord = {};
    try { metadata = JSON.parse(source?.metadata || '{}'); } catch { metadata = {}; }
    const replacement = { ...input, type: 'drawing', investorId: input.investorId || metadata.memberId, partnerName: input.partnerName || metadata.memberName };
    return this.documents.replaceSource(id, type, 'Edit member drawing', () => this.createPayment(replacement));
  }
  async updateInvoice(id: string, input: AnyRecord) { return this.documents.replaceSource(id, 'invoice', 'Edit invoice', () => this.createInvoice(input)); }
  async updateSale(id: string, input: AnyRecord) {
    const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]);
    if (row?.type === 'invoice' || row?.type === 'credit_sale' || input.clientName || input.partyId) {
      return this.updateInvoice(id, input);
    }
    const sourceType = row?.type && ['cash_sale', 'credit_sale', 'invoice'].includes(row.type) ? row.type : 'cash_sale';
    return this.documents.replaceSource(id, sourceType, 'Edit sale', () => this.createSale(input));
  }
  async updateBill(id: string, input: AnyRecord) { const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]); if (!row || !['cash_purchase', 'credit_purchase'].includes(row.type)) throw new Error('Bill not found'); return this.documents.replaceSource(id, row.type, 'Edit bill', () => this.createBill(input)); }
  async updateReceipt(id: string, input: AnyRecord) {
    const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return this.documents.editReceipt(id, { ...input, ...c, date: String(input.date), amount: amount(input.amount), method: method(input.method) });
  }
  async markInvoicePaid(id: string, input: AnyRecord = {}) {
    const date = input.date || new Date().toISOString().slice(0, 10);
    const c = await this.activeContext(date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return this.documents.markInvoicePaid(id, { periodId: c.periodId, date, method: method(input.method) });
  }

  async getActiveBookConfig() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) return null;
    return new V2BookConfigRepository(this.db).getBookConfig(active.value);
  }

  async updateActiveBookConfig(update: V2BookConfigUpdate) {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) throw new Error('No active versioned V2 book');
    return new V2BookConfigRepository(this.db).updateBookConfig(active.value, update);
  }

  async closeBooks(input: V2CloseBooksAppInput): Promise<V2CloseBooksAppResult> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) throw new Error('No active versioned V2 book');
    if (!Number.isFinite(input.actualStock) || input.actualStock < 0) throw new Error('Actual stock must be a finite non-negative amount');
    if (!Number.isFinite(input.openingInventory) || input.openingInventory < 0) throw new Error('Opening inventory must be a finite non-negative amount');
    const period = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [active.value]);
    if (!period) throw new Error('No open accounting period to close');
    const closeRepo = new V2CloseBooksRepository(this.db);
    const counts = await closeRepo.listInventoryCounts(active.value, period.id);
    if (!counts.some((count) => count.date === period.start_date)) await closeRepo.recordInventoryCount({ id: `${period.id}:opening-inventory`, bookId: active.value, periodId: period.id, date: period.start_date, value: input.openingInventory });
    if (!counts.some((count) => count.date === period.end_date)) await closeRepo.recordInventoryCount({ id: `${period.id}:closing-inventory`, bookId: active.value, periodId: period.id, date: period.end_date, value: input.actualStock });
    const nextStart = dayAfter(period.end_date);
    let next = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' AND start_date>? ORDER BY start_date LIMIT 1", [active.value, period.end_date]);
    if (!next) {
      next = { id: `${active.value}:period:${nextStart}`, start_date: nextStart, end_date: endOfMonth(nextStart) };
      await this.repo.createPeriod({ id: next.id, bookId: active.value, startDate: next.start_date, endDate: next.end_date, status: 'open' });
    }
    const result = await closeRepo.closeBooks({ id: `${active.value}:close:${period.id}`, bookId: active.value, periodId: period.id, nextPeriodId: next.id, date: period.end_date, commissionPct: input.commissionPct });
    return { source: 'v2', result };
  }
}

export function createAppWriteRouter(v2: V2AppService, legacy: AnyRecord) {
  type WriteName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
  const route = (name: WriteName) => async (payload: AnyRecord) => {
    if (await v2.activeContext(payload.date)) {
      const v2Res = await v2[name](payload);
      const injectedPayload = { ...payload, id: v2Res.source?.id };
      try { await legacy[name](injectedPayload); } catch { /* ignore legacy errors if v2 succeeds */ }
      return v2Res;
    }
    return legacy[name](payload);
  };
  return { createSale: route('createSale'), createInvoice: route('createInvoice'), createReceipt: route('createReceipt'), createBill: route('createBill'), createPayment: route('createPayment'), createExpense: route('createExpense') };
}

export function createAppMutationRouter(v2: V2AppService, legacy: AnyRecord) {
  const update = (name: 'updateReceipt'|'updateInvoice'|'updateExpense'|'updatePayment', type: string) => async (id: string, payload: AnyRecord) => {
    if (await v2.ownsSource(id, type)) {
      const v2Res = await v2[name](id, payload);
      try { await legacy[name](id, payload); } catch { /* ignore legacy error */ }
      return v2Res;
    }
    return legacy[name](id, payload);
  };
  const remove = (name: 'deleteReceipt'|'deleteInvoice'|'deleteExpense'|'deletePayment', type: string) => async (id: string) => {
    if (await v2.ownsSource(id, type)) {
      const v2Res = await v2[name](id);
      try { await legacy[name](id); } catch { /* ignore legacy error */ }
      return v2Res;
    }
    return legacy[name](id);
  };
  return {
    updateReceipt: update('updateReceipt', 'receipt'), deleteReceipt: remove('deleteReceipt', 'receipt'),
    updateSale: async (id: string, payload: AnyRecord) => {
      const isV2 = (await v2.ownsSource(id, 'cash_sale')) || (await v2.ownsSource(id, 'credit_sale')) || (await v2.ownsSource(id, 'invoice'));
      if (isV2) { const res = await v2.updateSale(id, payload); try { await legacy.updateSale(id, payload); } catch {} return res; }
      return legacy.updateSale(id, payload);
    },
    deleteSale: async (id: string) => {
      const isV2 = (await v2.ownsSource(id, 'cash_sale')) || (await v2.ownsSource(id, 'credit_sale')) || (await v2.ownsSource(id, 'invoice'));
      if (isV2) { const res = await v2.deleteSale(id); try { await legacy.deleteSale(id); } catch {} return res; }
      return legacy.deleteSale(id);
    },
    updateBill: async (id: string, payload: AnyRecord) => {
      if (await v2.ownsSource(id, 'cash_purchase') || await v2.ownsSource(id, 'credit_purchase')) { const res = await v2.updateBill(id, payload); try { await legacy.updateBill(id, payload); } catch {} return res; }
      return legacy.updateBill(id, payload);
    },
    deleteBill: async (id: string) => {
      if (await v2.ownsSource(id, 'cash_purchase') || await v2.ownsSource(id, 'credit_purchase')) { const res = await v2.deleteBill(id); try { await legacy.deleteBill(id); } catch {} return res; }
      return legacy.deleteBill(id);
    },
    updateInvoice: update('updateInvoice', 'invoice'), deleteInvoice: remove('deleteInvoice', 'invoice'),
    updateExpense: update('updateExpense', 'expense'), deleteExpense: remove('deleteExpense', 'expense'),
    updatePayment: async (id: string, payload: AnyRecord) => {
      const type = await v2.sourceType(id);
      if (type === 'supplier_payment' || type === 'drawing') { const res = await v2.updatePayment(id, payload); try { await legacy.updatePayment(id, payload); } catch {} return res; }
      return legacy.updatePayment(id, payload);
    },
    deletePayment: async (id: string) => {
      const type = await v2.sourceType(id);
      if (type === 'supplier_payment' || type === 'drawing') { const res = await v2.deletePayment(id); try { await legacy.deletePayment(id); } catch {} return res; }
      return legacy.deletePayment(id);
    },
    markInvoicePaid: async (id: string, payload: AnyRecord = {}) => {
      if (await v2.ownsSource(id, 'invoice')) { const res = await v2.markInvoicePaid(id, payload); try { await legacy.markInvoicePaid(id); } catch {} return res; }
      return legacy.markInvoicePaid(id);
    },
  };
}

export function createCloseBooksRouter(v2: V2AppService, legacy: (actualStock: number, notes: string) => Promise<any>) {
  return async (input: V2CloseBooksAppInput) => {
    const active = await v2.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    const isV2 = Boolean(active?.value && await accountingBookVersion(v2.db, active.value) === V2_BOOK_VERSION);
    return isV2 ? v2.closeBooks(input) : legacy(input.actualStock, input.notes || '');
  };
}
