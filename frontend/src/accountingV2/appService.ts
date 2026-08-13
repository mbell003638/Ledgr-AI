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
import { calculateInvoiceTotals } from '../utils/invoiceTotals';
import type { AccountingPeriodPolicy } from './config';

type AnyRecord = Record<string, any>;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => value === 'upi' ? 'mobile' : methods.has(value) ? value : 'cash';
const amount = (value: any) => Number(value);
const cents = round2;
const normalized = (value: any) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isGenericAccountsPayableName = (value: any) => /^(creditors?|accounts? payable)$/.test(normalized(value));
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
export type V2CloseBooksAppInput = { actualStock: number; openingInventory: number; commissionPct: number; notes?: string; date?: string };
export type V2CloseBooksAppResult = { source: 'v2'; result: CloseBooksResult };
export type V2OpeningBalancesInput = {
  date?: string;
  cash: number;
  inventory: number;
  otherAssets?: number;
  assetBreakdown?: { name: string; amount: number }[];
  accountsPayable?: number;
  otherLiabilities?: number;
  liabilityBreakdown?: { name: string; amount: number; type: 'creditor' | 'other' }[];
  ownerCapital?: number;
  retainedEarnings?: number;
  memo?: string;
};
export type V2ClosingBalancePartner = { memberId?: string; name: string; amount: number; profitSharePct?: number };
export type V2ClosingBalancesImportInput = V2OpeningBalancesInput & {
  ownerCapital: number;
  partnerCapitals: V2ClosingBalancePartner[];
  createMissingPartners?: boolean;
  createMissingCreditors?: boolean;
};
export type V2ScanPartyRequest = { name: string; role: V2PartyRole };
export type V2ScanPartyPreflightItem = V2ScanPartyRequest & {
  status: 'existing' | 'missing' | 'role_missing' | 'ignored_generic_ap';
  partyId?: string;
  requiresCreation: boolean;
};
export type V2ScanTransactionImportInput = {
  entryType: 'sale' | 'purchase_bill' | 'receipt_in' | 'payment_out' | 'expense';
  date: string;
  partyName?: string;
  amount: number;
  method?: 'cash' | 'credit';
  notes?: string;
  createMissingParty?: boolean;
};
type PeriodRow = { id: string; start_date: string; end_date: string };
type MemberCapitalRow = { id: string; name: string; profit_share_pct: number };
const dayAfter = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const endOfMonth = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const nextFixedPeriodEnd = (start: string, end: string, nextStart: string) => {
  const startDate = new Date(`${start}T00:00:00.000Z`); const endDate = new Date(`${end}T00:00:00.000Z`);
  const calendarAligned = startDate.getUTCDate() === 1 && end === endOfMonth(end);
  if (calendarAligned) {
    const months = (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth() + 1;
    const next = new Date(`${nextStart}T00:00:00.000Z`);
    return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + months, 0)).toISOString().slice(0, 10);
  }
  const durationDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
  return addDays(nextStart, durationDays);
};
const validIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value; } catch { return false; }
};

/** The application boundary for normal transaction writes. Legacy collections are not touched here. */
export class V2AppService {
  readonly repo: V2SqlRepository;
  readonly documents: V2DocumentService;
  constructor(readonly db: SqlRunner) { this.repo = new V2SqlRepository(db); this.documents = new V2DocumentService(this.repo); }

  async activeContext(date?: string): Promise<V2ActiveContext | null> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) return null;
    if (!date) {
      const period = await this.db.first<{ id: string }>("SELECT id FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [active.value]);
      return period ? { bookId: active.value, periodId: period.id } : null;
    }
    if (!validIsoDate(date)) throw new Error('Posting date must use a genuine YYYY-MM-DD date');
    const exact = await this.db.first<{ id: string }>("SELECT id FROM v2_periods WHERE book_id=? AND status='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1", [active.value, date, date]);
    if (exact) return { bookId: active.value, periodId: exact.id };
    const closed = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status!='open' AND start_date<=? AND end_date>=? LIMIT 1", [active.value, date, date]);
    if (closed) throw new Error(`Posting date ${date} falls in the closed period ${closed.start_date} to ${closed.end_date}`);
    const policy = await this.periodPolicy(active.value);
    if (policy.mode === 'fixed') throw new Error(`Posting date ${date} is outside the fixed accounting period ${policy.startDate} to ${policy.endDate}`);
    const periods = await this.db.all<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date", [active.value]);
    if (!periods.length) return null;
    const target = date < periods[0].start_date ? periods[0] : periods[periods.length - 1];
    const start = date < target.start_date ? date : target.start_date;
    const end = date > target.end_date ? date : target.end_date;
    const overlap = await this.db.first<{ id: string }>('SELECT id FROM v2_periods WHERE book_id=? AND id!=? AND start_date<=? AND end_date>=? LIMIT 1', [active.value, target.id, end, start]);
    if (overlap) throw new Error(`Posting date ${date} conflicts with another configured accounting period`);
    await this.db.run('UPDATE v2_periods SET start_date=?,end_date=? WHERE id=? AND book_id=?', [start, end, target.id, active.value]);
    return { bookId: active.value, periodId: target.id };
  }

  async getActivePeriod() {
    const context = await this.activeContext();
    if (!context) return null;
    const period = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE id=? AND book_id=?', [context.periodId, context.bookId]);
    return period ? { id: period.id, bookId: context.bookId, startDate: period.start_date, endDate: period.end_date } : null;
  }

  private async periodPolicy(bookId: string): Promise<AccountingPeriodPolicy> {
    return (await new V2BookConfigRepository(this.db).getBookConfig(bookId)).periodPolicy;
  }

  private async storePeriodPolicy(bookId: string, policy: AccountingPeriodPolicy): Promise<void> {
    const personas = await this.db.all<{ id: string; config: string }>('SELECT id,config FROM v2_personas WHERE book_id=? AND enabled=1', [bookId]);
    for (const persona of personas) {
      let config: AnyRecord = {};
      try { config = JSON.parse(persona.config || '{}'); } catch { config = {}; }
      config.periodPolicy = policy;
      await this.db.run('UPDATE v2_personas SET config=? WHERE id=?', [JSON.stringify(config), persona.id]);
    }
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

  async assertPartyNameAvailable(name: string, bookId?: string) {
    const targetBookId = bookId || (await this.activeContext())?.bookId;
    if (!targetBookId) throw new Error('No active versioned V2 book');
    const members = await this.db.all<{ name: string }>('SELECT name FROM v2_members WHERE book_id=?', [targetBookId]);
    if (members.some((member) => normalized(member.name) === normalized(name))) {
      throw new Error(`A Capital Account named '${String(name || '').trim()}' already exists. A Customer or Supplier must use a different name.`);
    }
  }

  private async party(input: AnyRecord, role: V2PartyRole, bookId: string) {
    const id = stablePartyId(role, input);
    const requestedName = partyDisplayName(input[role === 'customer' ? 'clientName' : 'supplierName']);
    const name = requestedName || partyDisplayName(input.partyId || id) || id;
    await this.assertPartyNameAvailable(name, bookId);
    const existing = await this.db.first('SELECT id FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
    if (!existing) await this.repo.createParty({ id, bookId, name, phone: input.clientPhone || input.phone, email: input.email, roles: [role] });
    else {
      const row = await this.db.first<{ roles: string }>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
      const roles: V2PartyRole[] = row ? JSON.parse(row.roles) : [];
      if (!roles.includes(role)) await this.db.run('UPDATE v2_parties SET roles=? WHERE id=?', [JSON.stringify([...roles, role]), id]);
    }
    return id;
  }

  /** Exact normalized-name lookup with no repair/upsert side effects. */
  private async partyByName(bookId: string, name: string, role?: V2PartyRole) {
    const rows = await this.db.all<{ id: string; name: string; roles: string }>('SELECT id,name,roles FROM v2_parties WHERE book_id=? AND archived=0', [bookId]);
    const matches = rows.filter((row) => normalized(row.name) === normalized(name));
    if (!matches.length) return null;
    if (!role) return matches[0];
    return matches.find((row) => {
      try { return (JSON.parse(row.roles || '[]') as string[]).includes(role); } catch { return false; }
    }) || matches[0];
  }

  /**
   * Read-only support-ledger preflight for scan review. It deliberately queries
   * parties directly: listParties performs identity repair and therefore is not
   * suitable for a UI preflight that promises zero writes before confirmation.
   */
  async preflightScanParties(requests: V2ScanPartyRequest[]) {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) {
      throw new Error('No active versioned V2 book');
    }
    const unique = new Map<string, V2ScanPartyRequest>();
    for (const request of requests || []) {
      const name = String(request?.name || '').trim();
      const role = request?.role === 'supplier' ? 'supplier' : 'customer';
      if (!name) throw new Error(`${role === 'supplier' ? 'Supplier' : 'Customer'} name is required`);
      unique.set(`${role}:${normalized(name)}`, { name, role });
    }
    const items: V2ScanPartyPreflightItem[] = [];
    for (const request of unique.values()) {
      if (request.role === 'supplier' && isGenericAccountsPayableName(request.name)) {
        items.push({ ...request, status: 'ignored_generic_ap', requiresCreation: false });
        continue;
      }
      const existing = await this.partyByName(active.value, request.name, request.role);
      if (!existing) {
        items.push({ ...request, status: 'missing', requiresCreation: true });
        continue;
      }
      let roles: string[] = [];
      try { roles = JSON.parse(existing.roles || '[]'); } catch { roles = []; }
      const hasRole = roles.includes(request.role);
      items.push({ ...request, partyId: existing.id, status: hasRole ? 'existing' : 'role_missing', requiresCreation: !hasRole });
    }
    return { items, requiresApproval: items.some((item) => item.requiresCreation) };
  }

  private async approvedScanParty(bookId: string, name: string, role: V2PartyRole, createMissingParty: boolean) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error(`${role === 'supplier' ? 'Supplier' : 'Customer'} name is required`);
    if (role === 'supplier' && isGenericAccountsPayableName(cleanName)) {
      throw new Error(`'${cleanName}' is an aggregate Accounts Payable label, not a supplier`);
    }
    const existing = await this.partyByName(bookId, cleanName, role);
    let roles: string[] = [];
    try { roles = existing ? JSON.parse(existing.roles || '[]') : []; } catch { roles = []; }
    if (existing && roles.includes(role)) return existing.id;
    if (!createMissingParty) {
      throw new Error(`${role === 'supplier' ? 'Supplier' : 'Customer'} ledger '${cleanName}' requires confirmed creation`);
    }
    return this.party({
      ...(existing ? { partyId: existing.id } : {}),
      [role === 'customer' ? 'clientName' : 'supplierName']: cleanName,
    }, role, bookId);
  }

  async ensureParty(name: string, role: V2PartyRole, details: { phone?: string; email?: string } = {}) {
    const context = await this.activeContext();
    if (!context) throw new Error('No active versioned V2 book');
    const id = await this.party({ [role === 'customer' ? 'clientName' : 'supplierName']: partyDisplayName(name), phone: details.phone, email: details.email }, role, context.bookId);
    return this.db.first<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE id=? AND book_id=?', [id, context.bookId]);
  }

  private async repairPartyIdentities(bookId: string) {
    const suspect = await this.db.first<{ id: string }>(`SELECT id FROM v2_parties
      WHERE book_id=? AND (
        id LIKE 'v2:customer:v2:%' OR id LIKE 'v2:supplier:v2:%'
        OR name LIKE 'v2:customer:%' OR name LIKE 'v2:supplier:%'
      ) LIMIT 1`, [bookId]);
    if (!suspect) return;
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
    const rows = await this.db.all<any>(`SELECT p.id,p.name,p.phone,p.email,p.roles,
      COALESCE(SUM(CASE WHEN a.code='1100' THEN l.debit-l.credit ELSE 0 END),0) AS receivable,
      COALESCE(SUM(CASE WHEN a.code='2000' THEN l.credit-l.debit ELSE 0 END),0) AS payable
      FROM v2_parties p
      LEFT JOIN v2_journal_lines l ON l.party_id=p.id
      LEFT JOIN v2_journal_entries j ON j.id=l.journal_id AND j.book_id=p.book_id
      LEFT JOIN v2_accounts a ON a.id=l.account_id
      WHERE p.book_id=? AND p.archived=0
      GROUP BY p.id,p.name,p.phone,p.email,p.roles
      ORDER BY p.name`, [context.bookId]);
    return rows.map((row) => {
      let roles: string[] = []; try { roles = JSON.parse(row.roles || '[]'); } catch { roles = []; }
      const receivable = Number(row.receivable || 0); const payable = Number(row.payable || 0);
      return { id: row.id, name: row.name, phone: row.phone, email: row.email, roles, receivable, payable, net: receivable - payable };
    });
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
      const ledger = active.map((row) => { const debit = cents(row.debit); const credit = cents(row.credit); running = cents(running + debit - credit); return { id: row.id, kind: row.type, date: row.date, ref: row.reference, reason: row.metadata.reason || '', notes: row.metadata.notes || '', amount: Number(row.metadata.total || debit || credit || 0), debit, credit, balance: running }; });
      const totalInvoiced = cents(active.filter((row) => row.type === 'invoice').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      const totalPaid = cents(active.filter((row) => row.type === 'receipt').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles,
        payments: active.filter((row) => row.type === 'receipt').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '' })),
        totalInvoiced, totalPaid, balance: running, statement: { ledger: ledger.slice().reverse(), balance: running } };
    }
    const bills = active.filter((row) => row.type === 'cash_purchase' || row.type === 'credit_purchase').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), invoiceNo: row.metadata.invoiceNo || row.reference || '', notes: row.metadata.notes || '', paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit' }));
    // [Finding A] Supplier credit/debit notes appear in the statement timeline
    // alongside payments (they, like a payment, adjust what we owe the supplier).
    const notes = active.filter((row) => row.type === 'credit_note' || row.type === 'debit_note').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), reason: row.metadata.reason || '', notes: row.metadata.notes || '', reference: row.reference || '', kind: row.type === 'credit_note' ? 'credit_note' : 'debit_note' }));
    const payments = active.filter((row) => row.type === 'supplier_payment').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '', reference: row.reference || '' }));
    const billsTotal = cents(bills.reduce((sum, row) => sum + row.amount, 0)); const paymentsTotal = cents(payments.reduce((sum, row) => sum + row.amount, 0));
    const balance = cents(active.reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0));
    return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles, bills: bills.reverse(), payments: payments.reverse(), notes: notes.reverse(), billsTotal, paymentsTotal, balance };
  }

  async updateParty(id: string, patch: AnyRecord) {
    const current = await this.db.first<{ book_id: string; name: string }>('SELECT book_id,name FROM v2_parties WHERE id=?', [id]);
    if (current && patch.name != null && normalized(patch.name) !== normalized(current.name)) {
      await this.assertPartyNameAvailable(String(patch.name), current.book_id);
    }
    return this.documents.updateParty(id, patch);
  }
  async archiveParty(id: string) { return this.documents.archiveParty(id); }
  async listSalesAndInvoices() {
    const context=await this.activeContext(); if(!context)return [];
    await this.repairPartyIdentities(context.bookId);
    const rows=await this.db.all<any>("SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_sale','invoice') ORDER BY s.date DESC,s.id DESC",[context.bookId]);
    const result=[];
    for(const row of rows){const meta=JSON.parse(row.metadata||'{}');if(meta.deleted||meta.reversed)continue;const open=row.type==='invoice'?await this.repo.invoiceOpen(row.id):0;result.push({id:row.id,type:row.type,date:row.date,reference:row.reference,amount:Number(meta.total||0),total:Number(meta.total||0),partyId:meta.partyId,partyName:row.party_name,clientName:row.party_name,clientPhone:meta.clientPhone||'',status:row.type==='cash_sale'?'paid':open<=0?'paid':open<Number(meta.total||0)?'partial':'unpaid',openAmount:open,notes:meta.notes,method:meta.method,lines:Array.isArray(meta.lines)?meta.lines:[],discount:Number(meta.discount||0),subtotal:Number(meta.subtotal??meta.total??0),tax: Number(meta.tax||0),taxLabel:meta.taxLabel,taxRate:Number(meta.taxRate||0),dueDate:meta.dueDate,terms:meta.terms});}
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
        memberId: meta.memberId ? String(meta.memberId) : null,
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

  async listBills() {
    const context = await this.activeContext(); if (!context) return [];
    await this.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>("SELECT s.id,s.type,s.date,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_purchase','credit_purchase') ORDER BY s.date DESC,s.id DESC", [context.bookId]);
    return rows.flatMap((row) => { const meta = JSON.parse(row.metadata || '{}'); return meta.deleted || meta.reversed ? [] : [{ id: row.id, sourceType: row.type, date: row.date, amount: Number(meta.total || 0), supplierId: meta.partyId, supplierName: row.party_name, partyName: row.party_name, paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit', method: meta.method, invoiceNo: meta.invoiceNo || '', notes: meta.notes || '', photo: meta.photo || '' }]; });
  }

  async createSale(input: AnyRecord) {
    const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const totals = lines.length ? calculateInvoiceTotals(lines, input.discount || 0, input.taxRate || 0) : null;
    const net = totals?.total ?? amount(input.total ?? input.amount);
    return postCashSale(this.repo, { ...c, date: input.date, amount: net, method: method(input.method), reference: input.reference, metadata: { notes: input.notes, lines, discount: totals?.discount ?? Number(input.discount || 0), subtotal: totals?.subtotal ?? Number(input.subtotal ?? input.amount ?? net), tax: totals?.tax ?? 0, taxRate: Number(input.taxRate || 0) } });
  }
  async createInvoice(input: AnyRecord) {
    const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const totals = lines.length ? calculateInvoiceTotals(lines, input.discount || 0, input.taxRate || 0) : null;
    const net = totals?.total ?? amount(input.total ?? input.amount);
    return this.repo.runInTransaction(async () => { const partyId = await this.party(input, 'customer', c.bookId); return postInvoice(this.repo, { ...c, date: input.date, partyId, amount: net, reference: input.invoiceNumber || input.reference, metadata: { clientPhone: input.clientPhone, dueDate: input.dueDate, lines, notes: input.notes, terms: input.terms, taxLabel: input.taxLabel, taxRate: Number(input.taxRate || 0), discount: totals?.discount ?? Number(input.discount || 0), subtotal: totals?.subtotal ?? Number(input.subtotal ?? net), tax: totals?.tax ?? 0 } }); });
  }
  async createReceipt(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); const allocations = (input.allocations || []).map((a: AnyRecord) => ({ invoiceSourceId: a.invoiceSourceId || a.invoiceId, amount: amount(a.amount ?? a.amountApplied) })); return this.repo.runInTransaction(async () => { const partyId = await this.party(input, 'customer', c.bookId); return postReceipt(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method), reference: input.reference, allocations, metadata: { mode: input.mode, notes: input.notes, taxLabel: input.taxLabel, taxRate: input.taxRate } }); }); }
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
      return postSupplierPayment(this.repo, { ...c, date: input.date, partyId, amount: amount(input.amount), method: method(input.method), metadata: { notes: input.notes } });
    });
  }
  async createExpense(input: AnyRecord) { const c = await this.activeContext(input.date); if (!c) throw new Error('No active versioned V2 book with an open accounting period'); return postExpense(this.repo, { ...c, date: input.date, amount: amount(input.amount), method: method(input.method), metadata: { category: input.category, notes: input.notes } }); }

  /**
   * Confirmed scan write. Any missing party/role and its transaction are created
   * inside one outer savepoint; callers must explicitly authorize support-ledger
   * creation after using preflightScanParties.
   */
  async importScanTransaction(input: V2ScanTransactionImportInput) {
    const context = await this.activeContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    return this.repo.runInTransaction(async () => {
      const partyName = String(input.partyName || '').trim();
      const allowCreation = Boolean(input.createMissingParty);
      switch (input.entryType) {
        case 'sale':
          if (input.method === 'credit') {
            const partyId = await this.approvedScanParty(context.bookId, partyName, 'customer', allowCreation);
            return this.createInvoice({ ...input, partyId, clientName: partyName, total: input.amount });
          }
          return this.createSale({ ...input, method: 'cash' });
        case 'purchase_bill': {
          const partyId = await this.approvedScanParty(context.bookId, partyName, 'supplier', allowCreation);
          return this.createBill({ ...input, partyId, supplierName: partyName, paymentType: input.method === 'credit' ? 'credit' : 'cash' });
        }
        case 'receipt_in':
          if (!partyName) return this.createSale({ ...input, method: 'cash' });
          return this.createReceipt({
            ...input,
            partyId: await this.approvedScanParty(context.bookId, partyName, 'customer', allowCreation),
            clientName: partyName,
            method: 'cash',
          });
        case 'payment_out':
          return this.createPayment({
            ...input,
            partyId: await this.approvedScanParty(context.bookId, partyName, 'supplier', allowCreation),
            supplierName: partyName,
            type: 'supplier_payment',
            method: 'cash',
          });
        case 'expense':
          return this.createExpense({ ...input, method: 'cash' });
        default:
          throw new Error('Unsupported scan transaction type');
      }
    });
  }
  /**
   * [Finding A] Post a credit/debit note through the V2 ledger so it hits the
   * journal + party balance (dashboard / party detail / statements), instead of
   * writing a disconnected record the V2 reads never see. Role-aware: customer
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
      return post(this.repo, { ...c, date: input.date, partyId, invoiceSourceId: input.invoiceId || input.invoiceSourceId || null, amount: amount(input.amount), role, reference: input.reference, reason: input.reason, notes: input.notes });
    });
  }
  async createCreditNote(input: AnyRecord) { return this.createNoteV2(input, 'credit_note'); }
  async createDebitNote(input: AnyRecord) { return this.createNoteV2(input, 'debit_note'); }
  /** Post opening cash/inventory against capital. Self-correcting: see applyOpeningBalances. */
  async postOpeningBalances(input: V2OpeningBalancesInput) {
    return this.applyOpeningBalances(input);
  }

  /** Replace the opening-balance journal for the book, preserving the reversal audit trail. */
  async updateOpeningBalances(input: V2OpeningBalancesInput) {
    return this.applyOpeningBalances(input);
  }

  /**
   * Import a closing balance sheet as the next opening position. The balance
   * sheet is posted once by the self-correcting opening engine; partner stakes
   * only establish each member's carried capital snapshot and never create a
   * second cash/capital journal.
   */
  async importClosingBalances(input: V2ClosingBalancesImportInput) {
    return this.repo.runInTransaction(async () => {
      const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
      if (!activeBook?.value || await accountingBookVersion(this.db, activeBook.value) !== V2_BOOK_VERSION) {
        throw new Error('No active versioned V2 book with an open accounting period');
      }
      const bookId = activeBook.value;
      const book = await this.db.first<{ style: string }>('SELECT style FROM v2_books WHERE id=?', [bookId]);
      const members = await this.db.all<MemberCapitalRow>('SELECT id,name,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY id', [bookId]);
      const hasPartnerScope = (input.partnerCapitals || []).length > 0 || Boolean(input.createMissingPartners) || members.length > 0;
      if (hasPartnerScope && book?.style !== 'retail_partnership') {
        throw new Error('Closing reports with capital accounts can only be imported with Equity Split enabled');
      }
      const memberById = new Map(members.map((member) => [member.id, member]));
      const membersByName = new Map<string, MemberCapitalRow[]>();
      for (const member of members) {
        const key = normalized(member.name);
        membersByName.set(key, [...(membersByName.get(key) || []), member]);
      }

      const matchedIds = new Set<string>();
      const newMemberIds = new Set<string>();
      const partnerCapitals = (input.partnerCapitals || []).map((partner) => {
        const partnerName = String(partner?.name || '').trim();
        const partnerAmount = cents(Number(partner?.amount));
        if (!partnerName || !Number.isFinite(partnerAmount) || partnerAmount < 0) {
          throw new Error('Every closing-report partner requires a name and a non-negative capital amount');
        }
        const candidates = membersByName.get(normalized(partnerName)) || [];
        if (candidates.length > 1) throw new Error(`Configured partner name '${partnerName}' is ambiguous`);
        let member = (partner.memberId ? memberById.get(String(partner.memberId)) : undefined) || candidates[0];
        if (!member) {
          if (!input.createMissingPartners) throw new Error(`No configured partner matches '${partnerName}'`);
          const profitSharePct = Number(partner.profitSharePct);
          if (!Number.isFinite(profitSharePct) || profitSharePct < 0 || profitSharePct > 100) {
            throw new Error(`A valid profit share is required to create partner '${partnerName}'`);
          }
          const memberKey = normalized(partnerName).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member';
          let memberId = `${bookId}:member:${memberKey}`;
          let suffix = 2;
          while (memberById.has(memberId)) memberId = `${bookId}:member:${memberKey}-${suffix++}`;
          member = { id: memberId, name: partnerName, profit_share_pct: profitSharePct };
          memberById.set(member.id, member);
          membersByName.set(normalized(member.name), [member]);
          newMemberIds.add(member.id);
        } else if (partner.profitSharePct !== undefined) {
          const suppliedShare = Number(partner.profitSharePct);
          if (!Number.isFinite(suppliedShare) || suppliedShare < 0 || suppliedShare > 100 || Math.abs(suppliedShare - Number(member.profit_share_pct)) > 0.005) {
            throw new Error(`Profit share for existing partner '${member.name}' must match the configured ${Number(member.profit_share_pct)}%`);
          }
        }
        if (matchedIds.has(member.id)) throw new Error(`Closing report contains partner '${member.name}' more than once`);
        matchedIds.add(member.id);
        return { memberId: member.id, name: member.name, amount: partnerAmount, profitSharePct: Number(member.profit_share_pct) };
      });

      const missing = members.filter((member) => !matchedIds.has(member.id));
      if (missing.length) throw new Error(`Closing report is missing configured partner${missing.length === 1 ? '' : 's'}: ${missing.map((member) => member.name).join(', ')}`);
      const profitShareTotal = cents(partnerCapitals.reduce((sum, partner) => sum + partner.profitSharePct, 0));
      if (partnerCapitals.length && Math.abs(profitShareTotal - 100) > 0.005) {
        throw new Error(`Capital-account profit shares must total 100% (currently ${profitShareTotal}%)`);
      }
      const ownerCapital = cents(Number(input.ownerCapital));
      const partnerTotal = cents(partnerCapitals.reduce((sum, partner) => sum + partner.amount, 0));
      if (hasPartnerScope && (!Number.isFinite(ownerCapital) || Math.abs(partnerTotal - ownerCapital) > 0.005)) {
        throw new Error(`Capital accounts (${partnerTotal.toFixed(2)}) must equal total equity (${Number.isFinite(ownerCapital) ? ownerCapital.toFixed(2) : 'invalid'})`);
      }

      const namedCreditors = (input.liabilityBreakdown || [])
        .filter((liability) => liability.type === 'creditor' && Number(liability.amount) > 0 && !isGenericAccountsPayableName(liability.name))
        .map((liability) => ({ name: liability.name, role: 'supplier' as const }));
      const creditorPreflight = await this.preflightScanParties(namedCreditors);
      const creditorCreations = creditorPreflight.items.filter((item) => item.requiresCreation);
      if (creditorCreations.length && !input.createMissingCreditors) {
        throw new Error(`Supplier ledger creation requires confirmation for: ${creditorCreations.map((item) => item.name).join(', ')}`);
      }

      for (const partner of partnerCapitals) {
        if (!newMemberIds.has(partner.memberId)) continue;
        await this.db.run(
          'INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES(?,?,?,?,?,?)',
          [partner.memberId, bookId, partner.name, partner.amount, partner.amount, partner.profitSharePct],
        );
      }

      // applyOpeningBalances owns reversal/repost and journal balancing. Its
      // nested savepoint plus this outer savepoint make the journal, metadata,
      // and member snapshots one all-or-nothing import.
      const result = await this.applyOpeningBalances(input);
      const source = await this.db.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=? AND book_id=?', [result.sourceId, bookId]);
      if (source) {
        let metadata: AnyRecord = {};
        try { metadata = JSON.parse(source.metadata || '{}'); } catch { /* preserve the canonical balances below */ }
        metadata.partnerCapitals = partnerCapitals;
        metadata.closingBalanceImport = true;
        await this.db.run('UPDATE v2_sources SET metadata=? WHERE id=? AND book_id=?', [JSON.stringify(metadata), result.sourceId, bookId]);
      }
      for (const partner of partnerCapitals) {
        await this.db.run('UPDATE v2_members SET current_capital=? WHERE id=? AND book_id=?', [partner.amount, partner.memberId, bookId]);
      }
      return { ...result, partnerCapitals };
    });
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
  private async applyOpeningBalances(input: V2OpeningBalancesInput) {
    const cash = cents(input.cash); const inventory = cents(input.inventory);
    if (!Number.isFinite(cash) || cash < 0 || !Number.isFinite(inventory) || inventory < 0) throw new Error('Opening balances must be non-negative');
    const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!activeBook?.value || await accountingBookVersion(this.db, activeBook.value) !== V2_BOOK_VERSION) throw new Error('No active versioned V2 book with an open accounting period');
    const bookId = activeBook.value;
    return this.repo.runInTransaction(async () => {
      if (input.date !== undefined && !validIsoDate(input.date)) throw new Error('Opening balance date must use a genuine YYYY-MM-DD date');
      const openPeriods = await this.db.all<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date", [bookId]);
      if (!openPeriods.length) throw new Error('No open accounting period is available. Create or reopen a period before setting opening balances.');
      const date = input.date || openPeriods[0].start_date;
      let target = [...openPeriods].reverse().find((period) => period.start_date <= date && period.end_date >= date);
      if (!target) {
        const closed = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status!='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1", [bookId, date, date]);
        if (closed) throw new Error(`Opening balances can't be dated ${date}: that date falls in the closed period ${closed.start_date} to ${closed.end_date}. Choose a date on or after ${openPeriods[0].start_date}.`);
        const policy = await this.periodPolicy(bookId);
        if (policy.mode === 'fixed') throw new Error(`Opening balance date ${date} is outside the fixed accounting period ${policy.startDate} to ${policy.endDate}`);
        const earliest = openPeriods[0];
        if (date < earliest.start_date) {
          const blocking = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND id!=? AND end_date>=? AND start_date<? ORDER BY start_date DESC LIMIT 1', [bookId, earliest.id, date, earliest.start_date]);
          if (blocking) throw new Error(`Opening balances can't be dated ${date}: the period ${blocking.start_date} to ${blocking.end_date} already covers it. Choose a date on or after ${earliest.start_date}.`);
          await this.db.run('UPDATE v2_periods SET start_date=? WHERE id=?', [date, earliest.id]);
          target = { ...earliest, start_date: date };
        } else {
          const latest = openPeriods[openPeriods.length - 1];
          const blocking = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND id!=? AND start_date<=? AND end_date>? ORDER BY start_date LIMIT 1', [bookId, latest.id, date, latest.end_date]);
          if (blocking) throw new Error(`Opening balances can't be dated ${date}: the period ${blocking.start_date} to ${blocking.end_date} already covers it.`);
          await this.db.run('UPDATE v2_periods SET end_date=? WHERE id=?', [date, latest.id]);
          target = { ...latest, end_date: date };
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
        if (liability.type === 'creditor' && liability.amount > 0 && !isGenericAccountsPayableName(liability.name)) {
          const existing = await this.partyByName(bookId, liability.name, 'supplier');
          const partyId = await this.party({ ...(existing ? { partyId: existing.id } : {}), supplierName: liability.name }, 'supplier', bookId);
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
    return { expected, openingInventory, lastAudit, purchasesSince: 0, salesSince: 0, history: history.reverse(), periodStart: period.start_date, periodEnd: period.end_date, periodPolicy: await this.periodPolicy(context.bookId) };
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
  async updateManualBalanceTransaction(sourceId: string, input: AnyRecord) {
    const row = await this.db.first<{ type: string; metadata: string }>('SELECT type,metadata FROM v2_sources WHERE id=?', [sourceId]);
    if (!row || (row.type !== 'manual_asset' && row.type !== 'manual_liability')) throw new Error('Manual balance transaction not found');
    let prior: AnyRecord = {};
    try { prior = JSON.parse(row.metadata || '{}'); } catch { prior = {}; }
    const next = await this.editInput({ ...prior, ...input });
    if (row.type === 'manual_asset') {
      return this.documents.replaceSource(sourceId, row.type, 'Edit manual asset', () => this.recordManualAsset({
        date: next.date, name: next.name, category: next.category, amount: next.amount ?? next.total,
        funding: next.funding || 'cash', notes: next.notes,
      }));
    }
    return this.documents.replaceSource(sourceId, row.type, 'Edit manual liability', () => this.recordManualLiability({
      date: next.date, name: next.name, category: next.category, amount: next.amount ?? next.total,
      recognition: next.recognition || 'expense', notes: next.notes,
    }));
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
  async deleteNote(id: string) {
    const type = await this.sourceType(id);
    if (type !== 'credit_note' && type !== 'debit_note') throw new Error('Debit / credit note not found');
    return this.documents.reverseSource(id, type, 'Reverse debit / credit note', true);
  }
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
    return this.repo.runInTransaction(async () => {
      let period = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [active.value]);
      if (!period) throw new Error('No open accounting period to close');
      const policy = await this.periodPolicy(active.value);
      const closeDate = input.date || period.end_date;
      if (!validIsoDate(closeDate)) throw new Error('Close date must use a genuine YYYY-MM-DD date');
      if (closeDate < period.start_date) throw new Error(`Close date ${closeDate} cannot be before the period start ${period.start_date}`);
      if (policy.mode === 'fixed' && closeDate !== policy.endDate) {
        throw new Error(`Fixed accounting period must close on ${policy.endDate}`);
      }
      const laterJournal = await this.db.first<{ date: string }>('SELECT date FROM v2_journal_entries WHERE book_id=? AND period_id=? AND date>? ORDER BY date LIMIT 1', [active.value, period.id, closeDate]);
      const laterCount = await this.db.first<{ date: string }>('SELECT date FROM v2_inventory_counts WHERE book_id=? AND period_id=? AND date>? ORDER BY date LIMIT 1', [active.value, period.id, closeDate]);
      const later = laterJournal || laterCount;
      if (later) throw new Error(`Accounting period cannot close on ${closeDate} because it contains activity dated ${later.date}`);
      const overlap = await this.db.first<{ id: string }>('SELECT id FROM v2_periods WHERE book_id=? AND id!=? AND start_date<=? AND end_date>=? LIMIT 1', [active.value, period.id, closeDate, period.start_date]);
      if (overlap) throw new Error('Close date conflicts with another configured accounting period');
      if (period.end_date !== closeDate) {
        await this.db.run('UPDATE v2_periods SET end_date=? WHERE id=? AND book_id=?', [closeDate, period.id, active.value]);
        period = { ...period, end_date: closeDate };
      }
      const closeRepo = new V2CloseBooksRepository(this.db);
      const counts = await closeRepo.listInventoryCounts(active.value, period.id);
      if (!counts.some((count) => count.date === period.start_date)) await closeRepo.recordInventoryCount({ id: `${period.id}:opening-inventory`, bookId: active.value, periodId: period.id, date: period.start_date, value: input.openingInventory });
      if (!counts.some((count) => count.date === closeDate)) await closeRepo.recordInventoryCount({ id: `${period.id}:closing-inventory`, bookId: active.value, periodId: period.id, date: closeDate, value: input.actualStock });
      const nextStart = dayAfter(closeDate);
      let next = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' AND start_date>? ORDER BY start_date LIMIT 1", [active.value, closeDate]);
      if (!next) {
        const nextEnd = policy.mode === 'fixed' ? nextFixedPeriodEnd(period.start_date, period.end_date, nextStart) : input.date ? '9999-12-31' : endOfMonth(nextStart);
        next = { id: `${active.value}:period:${nextStart}`, start_date: nextStart, end_date: nextEnd };
        await this.repo.createPeriod({ id: next.id, bookId: active.value, startDate: next.start_date, endDate: next.end_date, status: 'open' });
      }
      const result = await closeRepo.closeBooks({ id: `${active.value}:close:${period.id}`, bookId: active.value, periodId: period.id, nextPeriodId: next.id, date: closeDate, commissionPct: input.commissionPct });
      if (policy.mode === 'fixed') await this.storePeriodPolicy(active.value, { mode: 'fixed', startDate: next.start_date, endDate: next.end_date });
      return { source: 'v2' as const, result };
    });
  }
}

export function createAppWriteRouter(v2: V2AppService) {
  type WriteName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
  const route = (name: WriteName) => async (payload: AnyRecord) => v2[name](payload);
  return { createSale: route('createSale'), createInvoice: route('createInvoice'), createReceipt: route('createReceipt'), createBill: route('createBill'), createPayment: route('createPayment'), createExpense: route('createExpense') };
}

export function createAppMutationRouter(v2: V2AppService) {
  const update = (name: 'updateReceipt'|'updateInvoice'|'updateExpense'|'updatePayment', type: string) => async (id: string, payload: AnyRecord) => {
    if (await v2.ownsSource(id, type)) return v2[name](id, payload);
    throw new Error(`Cannot edit unknown V2 ${type} source`);
  };
  const remove = (name: 'deleteReceipt'|'deleteInvoice'|'deleteExpense'|'deletePayment', type: string) => async (id: string) => {
    if (await v2.ownsSource(id, type)) return v2[name](id);
    throw new Error(`Cannot delete unknown V2 ${type} source`);
  };
  return {
    updateReceipt: update('updateReceipt', 'receipt'), deleteReceipt: remove('deleteReceipt', 'receipt'),
    updateSale: async (id: string, payload: AnyRecord) => {
      const isV2 = (await v2.ownsSource(id, 'cash_sale')) || (await v2.ownsSource(id, 'credit_sale')) || (await v2.ownsSource(id, 'invoice'));
      if (isV2) return v2.updateSale(id, payload);
      throw new Error('Cannot edit unknown V2 sale source');
    },
    deleteSale: async (id: string) => {
      const isV2 = (await v2.ownsSource(id, 'cash_sale')) || (await v2.ownsSource(id, 'credit_sale')) || (await v2.ownsSource(id, 'invoice'));
      if (isV2) return v2.deleteSale(id);
      throw new Error('Cannot delete unknown V2 sale source');
    },
    updateBill: async (id: string, payload: AnyRecord) => {
      if (await v2.ownsSource(id, 'cash_purchase') || await v2.ownsSource(id, 'credit_purchase')) return v2.updateBill(id, payload);
      throw new Error('Cannot edit unknown V2 purchase source');
    },
    deleteBill: async (id: string) => {
      if (await v2.ownsSource(id, 'cash_purchase') || await v2.ownsSource(id, 'credit_purchase')) return v2.deleteBill(id);
      throw new Error('Cannot delete unknown V2 purchase source');
    },
    updateInvoice: update('updateInvoice', 'invoice'), deleteInvoice: remove('deleteInvoice', 'invoice'),
    updateNote: async (id: string, payload: AnyRecord) => {
      const type = await v2.sourceType(id);
      if (type === 'credit_note' || type === 'debit_note') return v2.updateNote(id, payload);
      throw new Error('Cannot edit unknown V2 debit / credit note');
    },
    deleteNote: async (id: string) => {
      const type = await v2.sourceType(id);
      if (type === 'credit_note' || type === 'debit_note') return v2.deleteNote(id);
      throw new Error('Cannot reverse unknown V2 debit / credit note');
    },
    updateExpense: update('updateExpense', 'expense'), deleteExpense: remove('deleteExpense', 'expense'),
    updatePayment: async (id: string, payload: AnyRecord) => {
      const type = await v2.sourceType(id);
      if (type === 'supplier_payment' || type === 'drawing' || type === 'commission_payment') return v2.updatePayment(id, payload);
      throw new Error('Cannot edit unknown V2 payment source');
    },
    deletePayment: async (id: string) => {
      const type = await v2.sourceType(id);
      if (type === 'supplier_payment' || type === 'drawing' || type === 'commission_payment') return v2.deletePayment(id);
      throw new Error('Cannot delete unknown V2 payment source');
    },
    markInvoicePaid: async (id: string, payload: AnyRecord = {}) => {
      if (await v2.ownsSource(id, 'invoice')) return v2.markInvoicePaid(id, payload);
      throw new Error('Cannot mark an unknown V2 invoice as paid');
    },
  };
}

export function createCloseBooksRouter(v2: V2AppService) {
  return async (input: V2CloseBooksAppInput) => v2.closeBooks(input);
}
