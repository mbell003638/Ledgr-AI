import type { SqlRunner } from '../db/schema';
import { V2SqlRepository } from './repository';
import { V2CloseBooksRepository, type CloseBooksResult } from './closeBooksRepository';
import { V2_BOOK_VERSION, accountingBookVersion } from './appBootstrap';
import { postCashSale, postInvoice, postReceipt, postPurchase, postSupplierPayment, postExpense, postCreditNote, postDebitNote } from './postings';
import { V2BookConfigRepository, type V2BookConfigUpdate } from './bookConfigRepository';
import { V2DocumentService } from './documentService';
import { V2InvestorLedgerService } from './investorLedgerService';
import { buildPersistentV2Reports } from './persistentReports';
import { V2_ACCOUNT_CODES, type V2PaymentMethod, type V2PartyRole } from './types';
import { round2 } from '../money';

type AnyRecord = Record<string, any>;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => methods.has(value) ? value : 'cash';
const amount = (value: any) => Number(value);
const cents = round2;
const normalized = (value: any) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
let partyRepairSequence = 0;
const partyDisplayName = (value: any) => {
  let name = String(value || '').trim();
  while (/^v2:(customer|supplier):/i.test(name)) name = name.replace(/^v2:(customer|supplier):/i, '').trim();
  return name;
};
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

  /**
   * [Finding C] Resolve the date a CORRECTION (edit replacement) may post to.
   * The reversal half of an edit already redirects a closed-period entry into the
   * current open period (documentService.resolvePostingTarget). The replacement
   * half re-runs createSale/createInvoice which resolve activeContext(input.date);
   * with the ORIGINAL closed date that yields no open period and the edit dead-ends.
   * This returns a date guaranteed to land in an OPEN period: the original date
   * when it already falls in an open period, otherwise today clamped into the
   * current open period (so closed totals stay frozen and the correction lands in
   * the open period). Returns null only when there is genuinely no open period.
   */
  private async editReplacementDate(originalDate?: string): Promise<string | null> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) return null;
    const bookId = active.value;
    if (originalDate) {
      const inOpen = await this.db.first<{ id: string }>("SELECT id FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=? AND end_date>=? LIMIT 1", [bookId, originalDate, originalDate]);
      if (inOpen) return originalDate;
    }
    const open = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date DESC LIMIT 1", [bookId]);
    if (!open) return null;
    const now = new Date().toISOString().slice(0, 10);
    return now < open.start_date ? open.start_date : now > open.end_date ? open.end_date : now;
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
    const sourceTypes = role === 'customer' ? ['invoice', 'receipt', 'credit_note', 'debit_note'] : ['cash_purchase', 'credit_purchase', 'supplier_payment', 'credit_note', 'debit_note', 'opening_balance'];
    const placeholders = sourceTypes.map(() => '?').join(','); const accountCode = role === 'customer' ? '1100' : '2000';
    const rows = await this.db.all<any>(`SELECT s.id,s.type,s.date,s.reference,s.metadata,
      COALESCE(SUM(CASE WHEN a.code=? THEN l.debit ELSE 0 END),0) AS debit,
      COALESCE(SUM(CASE WHEN a.code=? THEN l.credit ELSE 0 END),0) AS credit
      FROM v2_sources s LEFT JOIN v2_journal_entries j ON j.source_id=s.id
      LEFT JOIN v2_journal_lines l ON l.journal_id=j.id AND l.party_id=? LEFT JOIN v2_accounts a ON a.id=l.account_id
      WHERE s.book_id=? AND (json_extract(s.metadata,'$.partyId')=? OR EXISTS (
        SELECT 1 FROM v2_journal_entries je2 JOIN v2_journal_lines jl2 ON jl2.journal_id=je2.id
        WHERE je2.source_id=s.id AND jl2.party_id=?
      )) AND s.type IN (${placeholders})
      GROUP BY s.id,s.type,s.date,s.reference,s.metadata ORDER BY s.date,s.id`, [accountCode, accountCode, id, context.bookId, id, id, ...sourceTypes]);
    const active = rows.flatMap((row) => { let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; } return metadata.deleted || metadata.reversed ? [] : [{ ...row, metadata }]; });
    if (role === 'customer') {
      let running = 0;
      const ledger = active.map((row) => { const debit = cents(row.debit); const credit = cents(row.credit); running = cents(running + debit - credit); return { id: row.id, kind: row.type, date: row.date, ref: row.reference, notes: row.metadata.notes || '', debit, credit, balance: running }; });
      const totalInvoiced = cents(active.filter((row) => row.type === 'invoice').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      const totalPaid = cents(active.filter((row) => row.type === 'receipt').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles,
        payments: active.filter((row) => row.type === 'receipt').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '' })),
        totalInvoiced, totalPaid, balance: running, statement: { ledger: ledger.slice().reverse(), balance: running } };
    }
    const bills = active.filter((row) => row.type === 'cash_purchase' || row.type === 'credit_purchase').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), invoiceNo: row.metadata.invoiceNo || row.reference || '', notes: row.metadata.notes || '', paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit' }));
    // [Finding A] Supplier credit/debit notes appear in the statement timeline
    // alongside payments (they, like a payment, adjust what we owe the supplier).
    const notes = active.filter((row) => row.type === 'credit_note' || row.type === 'debit_note').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '', reference: row.reference || '', kind: row.type === 'credit_note' ? 'credit_note' : 'debit_note' }));
    const payments = [...active.filter((row) => row.type === 'supplier_payment').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '', reference: row.reference || '' })), ...notes];
    const billsTotal = cents(bills.reduce((sum, row) => sum + row.amount, 0)); const paymentsTotal = cents(payments.reduce((sum, row) => sum + row.amount, 0));
    const balance = cents(active.reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0));
    return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles, bills: bills.reverse(), payments: payments.reverse(), billsTotal, paymentsTotal, balance };
  }

  async updateParty(id: string, patch: AnyRecord) { return this.documents.updateParty(id, patch); }
  async archiveParty(id: string) { return this.documents.archiveParty(id); }
  async listSalesAndInvoices() {
    const context=await this.activeContext(); if(!context)return [];
    await this.repairPartyIdentities(context.bookId);
    const rows=await this.db.all<any>("SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_sale','invoice') ORDER BY s.date DESC,s.id DESC",[context.bookId]);
    const result=[];
    for(const row of rows){const meta=JSON.parse(row.metadata||'{}');if(meta.deleted||meta.reversed)continue;const open=row.type==='invoice'?await this.repo.invoiceOpen(row.id):0;result.push({id:row.id,type:row.type,date:row.date,reference:row.reference,amount:Number(meta.total||0),partyId:meta.partyId,partyName:row.party_name,clientName:row.party_name,status:row.type==='cash_sale'?'paid':open<=0?'paid':open<Number(meta.total||0)?'partial':'unpaid',openAmount:open,notes:meta.notes,method:meta.method});}
    return result;
  }

  /**
   * READ-ONLY: journal-derived cash/bank movements enriched with reversal
   * linkage (reversal_of, posted_at, source metadata flags) so presentation
   * layers can collapse reverse+repost noise. No posting logic here.
   */
  async listCashMovements() {
    const context = await this.activeContext(); if (!context) return [];
    const rows = await this.db.all<any>(`
      SELECT e.id, e.date, e.memo AS notes, e.posted_at, e.reversal_of, e.source_id,
             l.debit, l.credit, s.type AS source_type, s.metadata AS source_metadata
      FROM v2_journal_entries e
      JOIN v2_journal_lines l ON e.id = l.journal_id
      LEFT JOIN v2_sources s ON e.source_id = s.id
      WHERE e.book_id = ? AND l.account_id IN (?,?)
      ORDER BY e.date DESC, e.id DESC
    `, [context.bookId, `${context.bookId}:account:${V2_ACCOUNT_CODES.CASH}`, `${context.bookId}:account:${V2_ACCOUNT_CODES.BANK}`]);
    return rows.map((row) => {
      let meta: AnyRecord = {}; try { meta = JSON.parse(row.source_metadata || '{}'); } catch { /* malformed metadata is treated as empty */ }
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
        reversalOf: row.reversal_of || null,
        sourceReversed: !!meta.reversed,
        sourceDeleted: !!meta.deleted,
      };
    });
  }

  /** Post a general Cash Book row into the authoritative ledger. */
  async recordManualCash(input: { date: string; amount: number; direction: 'in' | 'out'; notes?: string }) {
    const context = await this.activeContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.amount);
    if (!Number.isFinite(value) || value <= 0) throw new Error('Cash amount must be positive');
    await this.repo.ensureDefaultAccounts(context.bookId);
    const isIn = input.direction === 'in';
    const source: any = {
      id: 'manual_cash_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      bookId: context.bookId,
      type: isIn ? 'manual_cash_income' : 'manual_cash_expense',
      date: input.date,
      metadata: { total: value, direction: input.direction, notes: input.notes || '' },
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

  async listBills() {
    const context = await this.activeContext(); if (!context) return [];
    await this.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>("SELECT s.id,s.type,s.date,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_purchase','credit_purchase') ORDER BY s.date DESC,s.id DESC", [context.bookId]);
    return rows.flatMap((row) => { const meta = JSON.parse(row.metadata || '{}'); return meta.deleted || meta.reversed ? [] : [{ id: row.id, sourceType: row.type, date: row.date, amount: Number(meta.total || 0), supplierId: meta.partyId, supplierName: row.party_name, partyName: row.party_name, paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit', method: meta.method, invoiceNo: meta.invoiceNo || '', notes: meta.notes || '', photo: meta.photo || '' }]; });
  }

  async createSale(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postCashSale(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method), reference: input.reference, metadata: { notes: input.notes } }); }
  async createInvoice(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return this.repo.runInTransaction(async () => { const partyId = await this.party(input, 'customer', c.bookId); return postInvoice(this.repo, { ...c, date: input.date, partyId, amount: amount(input.total ?? input.amount), reference: input.invoiceNumber || input.reference }); }); }
  async createReceipt(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const allocations = (input.allocations || []).map((a: AnyRecord) => ({ invoiceSourceId: a.invoiceSourceId || a.invoiceId, amount: amount(a.amount ?? a.amountApplied) })); return this.repo.runInTransaction(async () => { const partyId = await this.party(input, 'customer', c.bookId); return postReceipt(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method), reference: input.reference, allocations }); }); }
  async createBill(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const cash = input.paymentType === 'cash'; return this.repo.runInTransaction(async () => { const partyId = await this.party(input, 'supplier', c.bookId); return postPurchase(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount ?? input.total), method: cash ? method(input.method) : undefined, metadata: { invoiceNo: input.invoiceNo, notes: input.notes, photo: input.photo } }); }); }
  async createPayment(input: AnyRecord) {
    const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
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
        bookId: c.bookId, periodId: c.periodId, date: input.date,
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
        return new V2InvestorLedgerService(this.db).draw({ ...c, date: input.date, amount: amount(input.amount), memberId: String(input.investorId || input.partnerName || ''), notes: input.notes });
      }
      return this.documents.drawing({ ...c, date: input.date, amount: amount(input.amount), method: method(input.method) });
    }
    return this.repo.runInTransaction(async () => {
      const partyId = await this.party(input, 'supplier', c.bookId);
      return postSupplierPayment(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method) });
    });
  }
  async createExpense(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postExpense(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method) }); }
  /**
   * [Finding A] Post a credit/debit note through the V2 ledger so it hits the
   * journal + party balance (dashboard / party detail / statements), instead of
   * writing a legacy-only record the V2 reads never see. Role-aware: customer
   * notes move AR, supplier notes move AP. The party is upserted (find-or-create)
   * exactly like invoices/bills so a note can be raised against a party that was
   * only referenced by name/id.
   */
  private async createNoteV2(input: AnyRecord, kind: 'credit_note'|'debit_note') {
    const role: 'customer'|'supplier' = input.role === 'supplier' ? 'supplier' : 'customer';
    const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return this.repo.runInTransaction(async () => {
      // this.party() upserts the party + role and honours an explicit debtorId/
      // supplierId/partyId (see stablePartyId), so the note attaches to the SAME
      // party the invoice/bill created.
      const partyId = await this.party(input, role, c.bookId);
      const post = kind === 'credit_note' ? postCreditNote : postDebitNote;
      return post(this.repo, { ...c, date: input.date, partyId, invoiceSourceId: input.invoiceId || input.invoiceSourceId || null, amount: amount(input.amount), role });
    });
  }
  async createCreditNote(input: AnyRecord) { return this.createNoteV2(input, 'credit_note'); }
  async createDebitNote(input: AnyRecord) { return this.createNoteV2(input, 'debit_note'); }
  /** Post opening cash/inventory against capital. Self-correcting: see applyOpeningBalances. */
  async postOpeningBalances(input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) {
    return this.applyOpeningBalances(input);
  }

  /** Replace the opening-balance journal for the book, preserving the reversal audit trail. */
  async updateOpeningBalances(input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) {
    return this.applyOpeningBalances(input);
  }

  async getOpeningBalances() {
    const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!activeBook?.value) return null;
    const row = await this.db.first<{ metadata: string }>("SELECT metadata FROM v2_sources WHERE book_id=? AND type='opening_balance' AND (json_extract(metadata,'$.reversed') IS NULL OR json_extract(metadata,'$.reversed') != 1) AND (json_extract(metadata,'$.deleted') IS NULL OR json_extract(metadata,'$.deleted') != 1) ORDER BY date DESC, id DESC LIMIT 1", [activeBook.value]);
    if (!row) return null;
    try { return JSON.parse(row.metadata || '{}'); } catch { return null; }
  }

  /**
   * The single self-correcting opening-balance engine. It must succeed in every
   * legitimate state without ever asking the user to reverse anything:
   *  - nothing live posted yet            → initial post
   *  - identical amounts + date           → graceful no-op ({ alreadyPosted: true })
   *  - changed amounts and/or date        → reverse the live opening set and repost
   *    at the requested date, atomically (non-destructive correction; the audit
   *    trail keeps both the reversal and the new posting)
   *  - date before the earliest open period → the period start follows the opening
   *    date (the UI labels this field "Period Start Date"), unless an earlier
   *    period already covers that date
   *  - date inside a CLOSED period        → rejected with a message naming the
   *    closed period and the earliest usable date (closed totals stay frozen,
   *    consistent with the document-service correction redirect [H2]/[H3])
   */
  private async applyOpeningBalances(input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) {
    const cash = cents(input.cash); const inventory = cents(input.inventory);
    if (!Number.isFinite(cash) || cash < 0 || !Number.isFinite(inventory) || inventory < 0) throw new Error('Opening balances must be non-negative');
    const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!activeBook?.value || await accountingBookVersion(this.db, activeBook.value) !== V2_BOOK_VERSION) throw new Error('No active versioned V2 book with an open accounting period');
    const bookId = activeBook.value;
    return this.repo.runInTransaction(async () => {
      const openPeriods = await this.db.all<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date", [bookId]);
      if (!openPeriods.length) throw new Error('No open accounting period is available. Create or reopen a period before setting opening balances.');
      const date = input.date || openPeriods[0].start_date;
      let target = [...openPeriods].reverse().find((period) => period.start_date <= date && period.end_date >= date);
      if (!target) {
        const closed = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status!='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1", [bookId, date, date]);
        if (closed) throw new Error(`Opening balances can't be dated ${date}: that date falls in the closed period ${closed.start_date} to ${closed.end_date}. Choose a date on or after ${openPeriods[0].start_date}.`);
        const earliest = openPeriods[0];
        if (date < earliest.start_date) {
          const blocking = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND id!=? AND end_date>=? AND start_date<? ORDER BY start_date DESC LIMIT 1', [bookId, earliest.id, date, earliest.start_date]);
          if (blocking) throw new Error(`Opening balances can't be dated ${date}: the period ${blocking.start_date} to ${blocking.end_date} already covers it. Choose a date on or after ${earliest.start_date}.`);
          await this.db.run('UPDATE v2_periods SET start_date=? WHERE id=?', [date, earliest.id]);
          target = { ...earliest, start_date: date };
        } else {
          const latest = openPeriods[openPeriods.length - 1];
          throw new Error(`Opening balances can't be dated ${date}: the open period ends ${latest.end_date}. Choose a date on or before ${latest.end_date}.`);
        }
      }
      // Live (non-reversed, non-deleted) opening sources, book-wide — never
      // period-scoped, so a date change still finds the previously posted set.
      const rows = await this.db.all<{ id: string; metadata: string }>("SELECT s.id,s.metadata FROM v2_sources s LEFT JOIN v2_journal_entries j ON j.source_id=s.id AND j.reversal_of IS NULL WHERE s.book_id=? AND s.type='opening_balance' ORDER BY j.posted_at DESC, s.id DESC", [bookId]);
      const live: { id: string; metadata: AnyRecord }[] = [];
      for (const row of rows) {
        let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { continue; }
        if (!metadata.reversed && !metadata.deleted) live.push({ id: row.id, metadata });
      }
      const prior = live[0]?.metadata || {};
      const otherAssets = cents(input.otherAssets ?? Number(prior.otherAssets || 0));
      const assetBreakdown = (input.assetBreakdown ?? prior.assetBreakdown ?? [])
        .map((asset: any) => ({ name: String(asset?.name || "").trim(), amount: cents(asset?.amount) }))
        .filter((asset: any) => asset.name || asset.amount);
      if (assetBreakdown.some((asset: any) => asset.amount < 0 || (asset.amount > 0 && !asset.name))) throw new Error('Each other opening asset requires a name and a non-negative amount');
      if (assetBreakdown.length && cents(assetBreakdown.reduce((sum: number, asset: any) => sum + asset.amount, 0)) !== otherAssets) throw new Error('Other opening asset details must equal the other-assets total');
      const accountsPayable = cents(input.accountsPayable ?? Number(prior.accountsPayable || 0));
      const otherLiabilities = cents(input.otherLiabilities ?? Number(prior.otherLiabilities || 0));
      const liabilityBreakdown = (input.liabilityBreakdown ?? prior.liabilityBreakdown ?? [])
        .map((liability: any) => ({ name: String(liability?.name || "").trim(), amount: cents(liability?.amount), type: liability?.type === "creditor" ? "creditor" : "other" }))
        .filter((liability: any) => liability.name || liability.amount);
      if (liabilityBreakdown.some((liability: any) => liability.amount < 0 || (liability.amount > 0 && !liability.name))) throw new Error('Each opening liability requires a name and a non-negative amount');
      if (liabilityBreakdown.length) {
        const creditorTotal = cents(liabilityBreakdown.filter((liability: any) => liability.type === "creditor").reduce((sum: number, liability: any) => sum + liability.amount, 0));
        const otherTotal = cents(liabilityBreakdown.filter((liability: any) => liability.type === "other").reduce((sum: number, liability: any) => sum + liability.amount, 0));
        if (creditorTotal !== accountsPayable || otherTotal !== otherLiabilities) throw new Error('Opening liability details must equal the liability totals');
      }
      const linkedLiabilityBreakdown = [];
      for (const liability of liabilityBreakdown) {
        if (liability.type === 'creditor' && liability.amount > 0) {
          const partyId = await this.party({ supplierName: liability.name }, 'supplier', bookId);
          linkedLiabilityBreakdown.push({ ...liability, partyId });
        } else {
          linkedLiabilityBreakdown.push(liability);
        }
      }
      const retainedEarnings = cents(input.retainedEarnings ?? Number(prior.retainedEarnings || 0));
      const ownerCapital = cents(input.ownerCapital ?? (cash + inventory + otherAssets - accountsPayable - otherLiabilities - retainedEarnings));
      if ([otherAssets, accountsPayable, otherLiabilities, retainedEarnings, ownerCapital].some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Opening balances must be non-negative');
      const totalAssets = cents(cash + inventory + otherAssets);
      const totalLiabilitiesAndEquity = cents(accountsPayable + otherLiabilities + ownerCapital + retainedEarnings);
      if (totalAssets !== totalLiabilitiesAndEquity) throw new Error(`Opening balances do not balance: assets are ${totalAssets.toFixed(2)} and liabilities plus equity are ${totalLiabilitiesAndEquity.toFixed(2)}.`);
      if (live.length === 1 && Number(prior.cash) === cash && Number(prior.inventory) === inventory && Number(prior.otherAssets || 0) === otherAssets && JSON.stringify(prior.assetBreakdown || []) === JSON.stringify(assetBreakdown) && Number(prior.accountsPayable || 0) === accountsPayable && Number(prior.otherLiabilities || 0) === otherLiabilities && JSON.stringify(prior.liabilityBreakdown || []) === JSON.stringify(linkedLiabilityBreakdown) && Number(prior.ownerCapital ?? ownerCapital) === ownerCapital && Number(prior.retainedEarnings || 0) === retainedEarnings && prior.date === date) {
        return { sourceId: live[0].id, alreadyPosted: true };
      }
      // Non-destructive correction: reverse every live opening set (normally one),
      // then repost at the requested date — all inside this one transaction.
      for (const entry of live) await this.documents.reverseSource(entry.id, 'opening_balance', 'Update opening balances', true);
      const total = totalAssets;
      const canonicalId = `${bookId}:opening:${target.id}`;
      if (total === 0) return { sourceId: live[0]?.id ?? canonicalId, alreadyPosted: false, journal: null };
      const occupied = await this.db.first('SELECT id FROM v2_sources WHERE id=?', [canonicalId]);
      const sourceId = occupied ? `${canonicalId}:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` : canonicalId;
      const source: any = { id: sourceId, bookId, type: 'opening_balance', date, metadata: { cash, inventory, otherAssets, assetBreakdown, accountsPayable, otherLiabilities, liabilityBreakdown: linkedLiabilityBreakdown, ownerCapital, retainedEarnings, date } };
      const lines: any[] = [];
      if (cash) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.CASH}`, debit: cash, credit: 0 });
      if (inventory) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.INVENTORY}`, debit: inventory, credit: 0 });
      if (otherAssets) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.OTHER_ASSETS}`, debit: otherAssets, credit: 0 });
      const creditorLines = linkedLiabilityBreakdown.filter((liability: any) => liability.type === 'creditor' && liability.amount > 0);
      for (const liability of creditorLines) {
        lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.AP}`, partyId: liability.partyId, debit: 0, credit: liability.amount, memo: liability.name });
      }
      if (accountsPayable && !creditorLines.length) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.AP}`, debit: 0, credit: accountsPayable });
      if (otherLiabilities) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.OTHER_LIABILITIES}`, debit: 0, credit: otherLiabilities });
      if (ownerCapital) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.CAPITAL}`, debit: 0, credit: ownerCapital });
      if (retainedEarnings) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.RETAINED_EARNINGS}`, debit: 0, credit: retainedEarnings });
      const journal = await this.repo.postSourceJournal(source, { bookId, periodId: target.id, date, memo: input.memo || 'Opening balances', lines });
      return { sourceId, alreadyPosted: false, journal };
    });
  }
  /** Record a dated physical inventory count in the authoritative V2 repository. */
  async recordInventoryCount(input: { date: string; value: number; notes?: string }) {
    const context = await this.activeContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.value);
    if (!Number.isFinite(value) || value < 0) throw new Error('Inventory value must be non-negative');
    const id = `${context.bookId}:inventory:${context.periodId}:${input.date}`;
    const prior = await this.db.first('SELECT id FROM v2_inventory_counts WHERE id=?', [id]);
    if (prior) { await this.db.run('UPDATE v2_inventory_counts SET value=? WHERE id=?', [value, id]); return { id, bookId: context.bookId, periodId: context.periodId, date: input.date, value }; }
    const count = await new V2CloseBooksRepository(this.db).recordInventoryCount({ id, bookId: context.bookId, periodId: context.periodId, date: input.date, value });
    return { ...count, notes: input.notes || '' };
  }

  /** Record a dated non-trading asset (for example, a shop/security deposit) with an explicit funding source. */
  async recordManualAsset(input: { date: string; name: string; category?: string; amount: number; funding: 'cash' | 'bank' | 'capital' | 'liability'; notes?: string }) {
    const context = await this.activeContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.amount);
    const name = String(input.name || '').trim();
    if (!name || !Number.isFinite(value) || value <= 0) throw new Error('Asset name and a positive amount are required');
    await this.repo.ensureDefaultAccounts(context.bookId);
    // [M4] Capital-funded manual assets credit Owner Contributions (3400), NOT Member
    // Capital (3000), so they never pollute partnership capital reconciliation.
    const creditCode = input.funding === 'bank' ? V2_ACCOUNT_CODES.BANK
      : input.funding === 'capital' ? V2_ACCOUNT_CODES.OWNER_CONTRIBUTIONS
      : input.funding === 'liability' ? V2_ACCOUNT_CODES.OTHER_LIABILITIES
      : V2_ACCOUNT_CODES.CASH;
    const source: any = {
      id: `manual_asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      bookId: context.bookId,
      type: 'manual_asset',
      date: input.date,
      metadata: { name, category: String(input.category || 'Other asset'), total: value, funding: input.funding, notes: input.notes || '' },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: context.bookId, periodId: context.periodId, date: input.date,
      memo: `Asset: ${name}`,
      lines: [
        { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.OTHER_ASSETS}`, debit: value, credit: 0, memo: name },
        { accountId: `${context.bookId}:account:${creditCode}`, debit: 0, credit: value, memo: input.notes || name },
      ],
    });
    return { source, journal };
  }

  /** Record a dated non-trading liability. Supplier dues belong in vendor bills, not here. */
  async recordManualLiability(input: { date: string; name: string; category?: string; amount: number; recognition: 'cash' | 'bank' | 'asset' | 'expense' | 'creditor'; notes?: string }) {
    const context = await this.activeContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.amount);
    const name = String(input.name || '').trim();
    if (!name || !Number.isFinite(value) || value <= 0) throw new Error('Liability name and a positive amount are required');
    await this.repo.ensureDefaultAccounts(context.bookId);
    const debitCode = input.recognition === 'bank' ? V2_ACCOUNT_CODES.BANK
      : input.recognition === 'asset' ? V2_ACCOUNT_CODES.OTHER_ASSETS
      : input.recognition === 'expense' ? V2_ACCOUNT_CODES.EXPENSES
      : input.recognition === 'creditor' ? V2_ACCOUNT_CODES.INVENTORY
      : V2_ACCOUNT_CODES.CASH;
    const source: any = {
      id: `manual_liability_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      bookId: context.bookId,
      type: 'manual_liability',
      date: input.date,
      metadata: { name, category: String(input.category || 'Other liability'), total: value, recognition: input.recognition, notes: input.notes || '' },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: context.bookId, periodId: context.periodId, date: input.date,
      memo: `Liability: ${name}`,
      lines: [
        { accountId: `${context.bookId}:account:${debitCode}`, debit: value, credit: 0, memo: input.notes || name },
        { accountId: `${context.bookId}:account:${(input.recognition === 'creditor' ? V2_ACCOUNT_CODES.AP : V2_ACCOUNT_CODES.OTHER_LIABILITIES)}`, debit: 0, credit: value, memo: name },
      ],
    });
    return { source, journal };
  }

  /** Inventory screen data sourced exclusively from the V2 book when it is active. */
  async inventoryOverview() {
    const context = await this.activeContext();
    if (!context) return null;
    const period = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE id=? AND book_id=?', [context.periodId, context.bookId]);
    if (!period) return null;
    const closeRepo = new V2CloseBooksRepository(this.db);
    const counts = await closeRepo.listInventoryCounts(context.bookId, context.periodId);
    const expectedAt = async (to: string) => {
      const report = await buildPersistentV2Reports(this.db, { bookId: context.bookId, to });
      return cents(report.trialBalance.accounts.find((account) => account.code === V2_ACCOUNT_CODES.INVENTORY)?.normalBalance || 0);
    };
    const history = await Promise.all(counts.map(async (count) => {
      const expectedStock = await expectedAt(count.date);
      return { id: count.id, date: count.date, actualStock: count.value, expectedStock, variance: cents(count.value - expectedStock), notes: '' };
    }));
    const expected = await expectedAt(period.end_date);
    const openingInventory = await expectedAt(period.start_date);
    const lastAudit = history.length ? history[history.length - 1] : null;
    return { expected, openingInventory, lastAudit, purchasesSince: 0, salesSince: 0, history: history.reverse() };
  }

  async deleteV2InventoryCount(id: string) {
    const context = await this.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const count = await this.db.first<{ id: string }>('SELECT id FROM v2_inventory_counts WHERE id=? AND book_id=? AND period_id=?', [id, context.bookId, context.periodId]);
    if (!count) throw new Error('Inventory count not found in the active period');
    await this.db.run('DELETE FROM v2_inventory_counts WHERE id=?', [id]);
  }
  async listManualBalanceTransactions() {
    const context = await this.activeContext();
    if (!context) return [];
    const rows = await this.db.all<any>("SELECT id,type,date,metadata FROM v2_sources WHERE book_id=? AND type IN ('manual_asset','manual_liability') ORDER BY date DESC,id DESC", [context.bookId]);
    return rows.flatMap((row) => {
      let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; }
      if (metadata.reversed || metadata.deleted) return [];
      return [{ id: row.id, type: row.type === 'manual_asset' ? 'asset' as const : 'liability' as const, date: row.date, name: String(metadata.name || ''), category: String(metadata.category || ''), amount: Number(metadata.total || 0), counterparty: String(metadata.funding || metadata.recognition || ''), notes: String(metadata.notes || '') }];
    });
  }

  async deleteManualBalanceTransaction(sourceId: string) {
    const type = await this.sourceType(sourceId);
    if (type !== 'manual_asset' && type !== 'manual_liability') throw new Error('Manual balance transaction not found');
    return this.documents.reverseSource(sourceId, type, 'Delete manual balance transaction', true);
  }
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
  async deletePayment(id: string) { const type = await this.sourceType(id); if (type !== 'supplier_payment' && type !== 'drawing' && type !== 'commission_payment') throw new Error('Payment not found'); return this.documents.reverseSource(id, type, type === 'drawing' ? 'Delete member drawing' : type === 'commission_payment' ? 'Delete commission payment' : 'Delete supplier payment', true); }
  async deleteSale(id: string) {
    const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]);
    if (!row) throw new Error('Sale not found');
    if (['cash_sale', 'credit_sale', 'invoice'].includes(row.type)) {
      return this.documents.reverseSource(id, row.type, 'Delete sale', true);
    }
    return this.documents.reverseSource(id, 'cash_sale', 'Delete cash sale', true);
  }
  async deleteBill(id: string) { const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]); if (!row || !['cash_purchase', 'credit_purchase'].includes(row.type)) throw new Error('Bill not found'); return this.documents.reverseSource(id, row.type, 'Delete bill', true); }
  /**
   * [Finding C] Rebuild the edit payload so the replacement posts into an OPEN
   * period. When the original date is in a closed period the correction is dated
   * into the current open period (matching the reversal-side redirect); a clear
   * error is raised only when NO open period exists at all.
   */
  private async editInput(input: AnyRecord): Promise<AnyRecord> {
    const date = await this.editReplacementDate(input.date);
    if (!date) throw new Error('No active versioned V2 book with an open accounting period');
    return date === input.date ? input : { ...input, date };
  }
  async updateExpense(id: string, input: AnyRecord) { const next = await this.editInput(input); return this.documents.replaceSource(id, 'expense', 'Edit expense', () => this.createExpense(next)); }
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
  async updateInvoice(id: string, input: AnyRecord) {
    // [Finding F] A STATUS-ONLY edit (e.g. the invoices screen "mark unpaid",
    // which sends { status:'unpaid' } and no total) must NOT re-post the invoice
    // — re-posting with an undefined amount previously threw "Amount must be
    // positive" as an unhandled rejection. Handle it explicitly:
    //   - no receipts applied  → no-op (the invoice is already open); return it
    //   - receipts applied     → actionable error (unapply the receipt first)
    const hasTotal = input.total != null || input.amount != null;
    if (!hasTotal && input.status != null) {
      const row = await this.db.first<any>("SELECT id,type,date,reference,metadata FROM v2_sources WHERE id=? AND type='invoice'", [id]);
      if (!row) throw new Error('Invoice not found');
      const alloc = await this.db.first<{ id: string }>('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [id]);
      if (String(input.status) === 'unpaid' && alloc) {
        throw new Error('This invoice has a receipt applied to it. Delete or adjust the receipt to mark it unpaid.');
      }
      let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
      return { source: { id: row.id, type: row.type, date: row.date, reference: row.reference, metadata } };
    }
    const next = await this.editInput(input);
    // [Finding E] If receipts are already allocated to this invoice, edit through
    // the allocation-preserving path (re-post + re-point allocations) so a
    // partially-paid invoice can be corrected. Guarded: new total must be >= the
    // amount already received.
    const allocated = await this.db.first<{ id: string }>('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [id]);
    if (allocated) {
      const newTotal = amount(next.total ?? next.amount);
      return this.documents.replaceInvoicePreservingAllocations(id, 'Edit invoice', newTotal, () => this.createInvoice(next));
    }
    return this.documents.replaceSource(id, 'invoice', 'Edit invoice', () => this.createInvoice(next));
  }
  async updateSale(id: string, input: AnyRecord) {
    const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]);
    if (row?.type === 'invoice' || row?.type === 'credit_sale' || input.clientName || input.partyId) {
      return this.updateInvoice(id, input);
    }
    const sourceType = row?.type && ['cash_sale', 'credit_sale', 'invoice'].includes(row.type) ? row.type : 'cash_sale';
    const next = await this.editInput(input);
    return this.documents.replaceSource(id, sourceType, 'Edit sale', () => this.createSale(next));
  }
  async updateBill(id: string, input: AnyRecord) { const row = await this.db.first<any>('SELECT type FROM v2_sources WHERE id=?', [id]); if (!row || !['cash_purchase', 'credit_purchase'].includes(row.type)) throw new Error('Bill not found'); const next = await this.editInput(input); return this.documents.replaceSource(id, row.type, 'Edit bill', () => this.createBill(next)); }
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

/**
 * [Vault C2 / Gauge H3] The V2-first write path deliberately treats the legacy mirror
 * write as best-effort, but the failure must not be silent. Each mirror failure is logged
 * and captured here (capped) so a failed legacy mirror is diagnosable instead of vanishing.
 * V2-first ordering is unchanged: V2 remains authoritative; only observability improves.
 */
export type MirrorError = { operation: string; message: string; at: string };
const MIRROR_ERROR_CAP = 50;
export const lastMirrorErrors: MirrorError[] = [];
export function recordMirrorError(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  console.warn(`[V2] legacy mirror write failed for ${operation}: ${message}`);
  lastMirrorErrors.push({ operation, message, at: new Date().toISOString() });
  if (lastMirrorErrors.length > MIRROR_ERROR_CAP) lastMirrorErrors.splice(0, lastMirrorErrors.length - MIRROR_ERROR_CAP);
}

export function createAppWriteRouter(v2: V2AppService, legacy: AnyRecord) {
  type WriteName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
  const route = (name: WriteName) => async (payload: AnyRecord) => {
    if (await v2.activeContext(payload.date)) {
      const v2Res = await v2[name](payload);
      const injectedPayload = { ...payload, id: v2Res.source?.id };
      try { await legacy[name](injectedPayload); } catch (error) { recordMirrorError(name, error); }
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
      try { await legacy[name](id, payload); } catch (error) { recordMirrorError(name, error); }
      return v2Res;
    }
    return legacy[name](id, payload);
  };
  const remove = (name: 'deleteReceipt'|'deleteInvoice'|'deleteExpense'|'deletePayment', type: string) => async (id: string) => {
    if (await v2.ownsSource(id, type)) {
      const v2Res = await v2[name](id);
      try { await legacy[name](id); } catch (error) { recordMirrorError(name, error); }
      return v2Res;
    }
    return legacy[name](id);
  };
  return {
    updateReceipt: update('updateReceipt', 'receipt'), deleteReceipt: remove('deleteReceipt', 'receipt'),
    updateSale: async (id: string, payload: AnyRecord) => {
      const isV2 = (await v2.ownsSource(id, 'cash_sale')) || (await v2.ownsSource(id, 'credit_sale')) || (await v2.ownsSource(id, 'invoice'));
      if (isV2) { const res = await v2.updateSale(id, payload); try { await legacy.updateSale(id, payload); } catch (error) { recordMirrorError('updateSale', error); } return res; }
      return legacy.updateSale(id, payload);
    },
    deleteSale: async (id: string) => {
      const isV2 = (await v2.ownsSource(id, 'cash_sale')) || (await v2.ownsSource(id, 'credit_sale')) || (await v2.ownsSource(id, 'invoice'));
      if (isV2) { const res = await v2.deleteSale(id); try { await legacy.deleteSale(id); } catch (error) { recordMirrorError('deleteSale', error); } return res; }
      return legacy.deleteSale(id);
    },
    updateBill: async (id: string, payload: AnyRecord) => {
      if (await v2.ownsSource(id, 'cash_purchase') || await v2.ownsSource(id, 'credit_purchase')) { const res = await v2.updateBill(id, payload); try { await legacy.updateBill(id, payload); } catch (error) { recordMirrorError('updateBill', error); } return res; }
      return legacy.updateBill(id, payload);
    },
    deleteBill: async (id: string) => {
      if (await v2.ownsSource(id, 'cash_purchase') || await v2.ownsSource(id, 'credit_purchase')) { const res = await v2.deleteBill(id); try { await legacy.deleteBill(id); } catch (error) { recordMirrorError('deleteBill', error); } return res; }
      return legacy.deleteBill(id);
    },
    updateInvoice: update('updateInvoice', 'invoice'), deleteInvoice: remove('deleteInvoice', 'invoice'),
    updateExpense: update('updateExpense', 'expense'), deleteExpense: remove('deleteExpense', 'expense'),
    updatePayment: async (id: string, payload: AnyRecord) => {
      const type = await v2.sourceType(id);
      if (type === 'supplier_payment' || type === 'drawing' || type === 'commission_payment') { const res = await v2.updatePayment(id, payload); try { await legacy.updatePayment(id, payload); } catch (error) { recordMirrorError('updatePayment', error); } return res; }
      return legacy.updatePayment(id, payload);
    },
    deletePayment: async (id: string) => {
      const type = await v2.sourceType(id);
      if (type === 'supplier_payment' || type === 'drawing' || type === 'commission_payment') { const res = await v2.deletePayment(id); try { await legacy.deletePayment(id); } catch (error) { recordMirrorError('deletePayment', error); } return res; }
      return legacy.deletePayment(id);
    },
    markInvoicePaid: async (id: string, payload: AnyRecord = {}) => {
      if (await v2.ownsSource(id, 'invoice')) { const res = await v2.markInvoicePaid(id, payload); try { await legacy.markInvoicePaid(id); } catch (error) { recordMirrorError('markInvoicePaid', error); } return res; }
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
