import type { SqlRunner } from '../db/schema';
import { V2SqlRepository } from './repository';
import { V2CloseBooksRepository, type CloseBooksResult } from './closeBooksRepository';
import { V2_BOOK_VERSION, accountingBookVersion } from './appBootstrap';
import { postCashSale, postInvoice, postReceipt, postPurchase, postSupplierPayment, postExpense } from './postings';
import type { V2PaymentMethod, V2PartyRole } from './types';

type AnyRecord = Record<string, any>;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => methods.has(value) ? value : 'cash';
const amount = (value: any) => Number(value);
const normalized = (value: any) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const stablePartyId = (role: V2PartyRole, input: AnyRecord) => String(input[role === 'customer' ? 'debtorId' : 'supplierId'] || `v2:${role}:${normalized(input[role === 'customer' ? 'clientName' : 'supplierName'])}`);

export type V2ActiveContext = { bookId: string; periodId: string };
export type V2CloseBooksAppInput = { actualStock: number; openingInventory: number; commissionPct: number; notes?: string };
export type V2CloseBooksAppResult = { source: 'v2'; result: CloseBooksResult };
type PeriodRow = { id: string; start_date: string; end_date: string };
const dayAfter = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const endOfMonth = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

/** The application boundary for normal transaction writes. Legacy collections are not touched here. */
export class V2AppService {
  readonly repo: V2SqlRepository;
  constructor(readonly db: SqlRunner) { this.repo = new V2SqlRepository(db); }

  async activeContext(date?: string): Promise<V2ActiveContext | null> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) return null;
    const period = await this.db.first<{ id: string }>("SELECT id FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=COALESCE(?,start_date) AND end_date>=COALESCE(?,end_date) ORDER BY start_date DESC LIMIT 1", [active.value, date || null, date || null]);
    return period ? { bookId: active.value, periodId: period.id } : null;
  }

  private async party(input: AnyRecord, role: V2PartyRole, bookId: string) {
    const id = stablePartyId(role, input);
    const name = String(input[role === 'customer' ? 'clientName' : 'supplierName'] || id).trim() || id;
    const existing = await this.db.first('SELECT id FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
    if (!existing) await this.repo.createParty({ id, bookId, name, phone: input.clientPhone || input.phone, email: input.email, roles: [role] });
    else {
      const row = await this.db.first<{ roles: string }>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
      const roles: V2PartyRole[] = row ? JSON.parse(row.roles) : [];
      if (!roles.includes(role)) await this.db.run('UPDATE v2_parties SET roles=? WHERE id=?', [JSON.stringify([...roles, role]), id]);
    }
    return id;
  }

  async listParties() {
    const context = await this.activeContext(); if (!context) return [];
    const rows = await this.db.all<any>('SELECT id,name,phone,email,roles,archived FROM v2_parties WHERE book_id=? AND archived=0 ORDER BY name', [context.bookId]);
    const result = [];
    for (const row of rows) {
      const ar = await this.db.first<{ balance:number }>(`SELECT COALESCE(SUM(l.debit-l.credit),0) balance FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id JOIN v2_accounts a ON a.id=l.account_id WHERE j.book_id=? AND l.party_id=? AND a.code='1100'`, [context.bookId,row.id]);
      const ap = await this.db.first<{ balance:number }>(`SELECT COALESCE(SUM(l.credit-l.debit),0) balance FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id JOIN v2_accounts a ON a.id=l.account_id WHERE j.book_id=? AND l.party_id=? AND a.code='2000'`, [context.bookId,row.id]);
      result.push({ id:row.id,name:row.name,phone:row.phone,email:row.email,roles:JSON.parse(row.roles),receivable:Number(ar?.balance||0),payable:Number(ap?.balance||0),net:Number(ar?.balance||0)-Number(ap?.balance||0) });
    }
    return result;
  }

  async listSalesAndInvoices() {
    const context=await this.activeContext(); if(!context)return [];
    const rows=await this.db.all<any>("SELECT id,type,date,reference,metadata FROM v2_sources WHERE book_id=? AND type IN ('cash_sale','invoice') ORDER BY date DESC,id DESC",[context.bookId]);
    const result=[];
    for(const row of rows){const meta=JSON.parse(row.metadata||'{}');const open=row.type==='invoice'?await this.repo.invoiceOpen(row.id):0;result.push({id:row.id,type:row.type,date:row.date,reference:row.reference,amount:Number(meta.total||0),partyId:meta.partyId,status:row.type==='cash_sale'?'paid':open<=0?'paid':open<Number(meta.total||0)?'partial':'unpaid',openAmount:open});}
    return result;
  }

  async createSale(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postCashSale(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method), reference: input.reference }); }
  async createInvoice(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'customer', c.bookId); return postInvoice(this.repo, { ...c, date: input.date, partyId, amount: amount(input.total ?? input.amount), reference: input.invoiceNumber || input.reference }); }
  async createReceipt(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'customer', c.bookId); const allocations = (input.allocations || []).map((a: AnyRecord) => ({ invoiceSourceId: a.invoiceSourceId || a.invoiceId, amount: amount(a.amount ?? a.amountApplied) })); return postReceipt(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method), reference: input.reference, allocations }); }
  async createBill(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'supplier', c.bookId); const cash = input.paymentType === 'cash' || input.method; return postPurchase(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount ?? input.total), method: cash ? method(input.method) : undefined }); }
  async createPayment(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const partyId = await this.party(input, 'supplier', c.bookId); return postSupplierPayment(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method) }); }
  async createExpense(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postExpense(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method) }); }

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
  const route = (name: WriteName) => async (payload: AnyRecord) => (await v2.activeContext(payload.date)) ? v2[name](payload) : legacy[name](payload);
  return { createSale: route('createSale'), createInvoice: route('createInvoice'), createReceipt: route('createReceipt'), createBill: route('createBill'), createPayment: route('createPayment'), createExpense: route('createExpense') };
}

export function createCloseBooksRouter(v2: V2AppService, legacy: (actualStock: number, notes: string) => Promise<any>) {
  return async (input: V2CloseBooksAppInput) => {
    const active = await v2.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    const isV2 = Boolean(active?.value && await accountingBookVersion(v2.db, active.value) === V2_BOOK_VERSION);
    return isV2 ? v2.closeBooks(input) : legacy(input.actualStock, input.notes || '');
  };
}
