import type { SqlRunner } from '../db/schema';
import { V2SqlRepository } from './repository';
import { V2_BOOK_VERSION, accountingBookVersion, ensureDefaultAccounts } from './appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from './bookConfigRepository';
import { V2DocumentService } from './documentService';
import type { V2PartyRole } from './types';
import type { AccountingPeriodPolicy } from './config';
import {
  PartyDomainService,
  partyDisplayName,
  stablePartyId,
  type V2ScanPartyRequest,
  type V2ScanPartyPreflightItem,
} from './services/partyDomainService';
import { InvoiceDomainService } from './services/invoiceDomainService';
import { ExpenseDomainService } from './services/expenseDomainService';
import { SaleDomainService } from './services/saleDomainService';
import {
  CapitalDomainService,
  type V2CloseBooksAppInput,
  type V2CloseBooksAppResult,
  type V2OpeningBalancesInput,
  type V2ClosingBalancePartner,
  type V2ClosingBalancesImportInput,
} from './services/capitalDomainService';
import { PayrollDomainService } from './services/payrollDomainService';
import { FixedAssetDomainService } from './services/fixedAssetDomainService';
import { ProductDomainService } from './services/productDomainService';
import { LocationDomainService } from './services/locationDomainService';
import { localTodayIso } from '../utils/dateValidation';

export {
  partyDisplayName,
  stablePartyId,
  type V2ScanPartyRequest,
  type V2ScanPartyPreflightItem,
  type V2CloseBooksAppInput,
  type V2CloseBooksAppResult,
  type V2OpeningBalancesInput,
  type V2ClosingBalancePartner,
  type V2ClosingBalancesImportInput,
};

type AnyRecord = Record<string, any>;

export type V2ActiveContext = { bookId: string; periodId: string };
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

const validIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value; } catch { return false; }
};

/** The application boundary for normal transaction writes. Legacy collections are not touched here. */
export class V2AppService {
  readonly repo: V2SqlRepository;
  readonly documents: V2DocumentService;
  readonly parties: PartyDomainService;
  readonly invoices: InvoiceDomainService;
  readonly expenses: ExpenseDomainService;
  readonly sales: SaleDomainService;
  readonly capital: CapitalDomainService;
  readonly payroll: PayrollDomainService;
  readonly fixedAssets: FixedAssetDomainService;
  readonly products: ProductDomainService;
  readonly locations: LocationDomainService;

  constructor(readonly db: SqlRunner) {
    this.repo = new V2SqlRepository(db);
    this.documents = new V2DocumentService(this.repo);
    this.parties = new PartyDomainService(this.db, this.repo, this.documents, () => this.activeContext());
    this.invoices = new InvoiceDomainService(
      this.db,
      this.repo,
      this.documents,
      this.parties,
      (date) => this.activeContext(date),
      (input) => this.editInput(input),
    );
    this.expenses = new ExpenseDomainService(
      this.db,
      this.repo,
      this.documents,
      this.parties,
      (date) => this.activeContext(date),
      (input) => this.editInput(input),
      (id) => this.sourceType(id),
    );
    this.sales = new SaleDomainService(
      this.db,
      this.repo,
      this.documents,
      this.parties,
      this.invoices,
      (date) => this.activeContext(date),
      (input) => this.editInput(input),
      (id) => this.sourceType(id),
    );
    this.payroll = new PayrollDomainService(this.db, this.repo, (date) => this.activeContext(date));
    this.fixedAssets = new FixedAssetDomainService(this.db, this.repo, (date) => this.activeContext(date));
    this.products = new ProductDomainService(this.db, this.repo, (date) => this.activeContext(date));
    this.locations = new LocationDomainService(this.db, this.repo, (date) => this.activeContext(date));
    this.capital = new CapitalDomainService(
      this.db,
      this.repo,
      this.documents,
      this.parties,
      (date) => this.activeContext(date),
      (bookId) => this.periodPolicy(bookId),
      (bookId, policy) => this.storePeriodPolicy(bookId, policy),
      (input) => this.editInput(input),
      (id) => this.sourceType(id),
    );
  }

  async activeContext(date?: string): Promise<V2ActiveContext | null> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) return null;
    await ensureDefaultAccounts(this.db, active.value);
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
    const now = localTodayIso();
    return now < open.start_date ? open.start_date : now > open.end_date ? open.end_date : now;
  }

  private async editInput(input: AnyRecord): Promise<AnyRecord> {
    const date = await this.editReplacementDate(input.date);
    if (!date) throw new Error('No active versioned V2 book with an open accounting period');
    return date === input.date ? input : { ...input, date };
  }

  // ---------- Party Domain Delegation ----------
  async assertPartyNameAvailable(name: string, bookId?: string) { return this.parties.assertPartyNameAvailable(name, bookId); }
  async preflightScanParties(requests: V2ScanPartyRequest[]) { return this.parties.preflightScanParties(requests); }
  async ensureParty(name: string, role: V2PartyRole, details: { phone?: string; email?: string } = {}) { return this.parties.ensureParty(name, role, details); }
  async listParties() { return this.parties.listParties(); }
  async getPartyDetail(id: string, role: 'customer' | 'supplier') { return this.parties.getPartyDetail(id, role); }
  async updateParty(id: string, patch: AnyRecord) { return this.parties.updateParty(id, patch); }
  async archiveParty(id: string) { return this.parties.archiveParty(id); }

  // ---------- Invoice Domain Delegation ----------
  async createInvoice(input: AnyRecord) { return this.invoices.createInvoice(input); }
  async updateInvoice(id: string, input: AnyRecord) { return this.invoices.updateInvoice(id, input); }
  async deleteInvoice(id: string) { return this.invoices.deleteInvoice(id); }
  async markInvoicePaid(id: string, input: AnyRecord = {}) { return this.invoices.markInvoicePaid(id, input); }
  async listSalesAndInvoices() { return this.invoices.listSalesAndInvoices(); }

  // ---------- Expense Domain Delegation ----------
  async createExpense(input: AnyRecord) { return this.expenses.createExpense(input); }
  async updateExpense(id: string, input: AnyRecord) { return this.expenses.updateExpense(id, input); }
  async deleteExpense(id: string) { return this.expenses.deleteExpense(id); }
  async listBills() { return this.expenses.listBills(); }
  async createBill(input: AnyRecord) { return this.expenses.createBill(input); }
  async updateBill(id: string, input: AnyRecord) { return this.expenses.updateBill(id, input); }
  async deleteBill(id: string) { return this.expenses.deleteBill(id); }
  async createPayment(input: AnyRecord) { return this.expenses.createPayment(input); }
  async updatePayment(id: string, input: AnyRecord) { return this.expenses.updatePayment(id, input); }
  async deletePayment(id: string) { return this.expenses.deletePayment(id); }

  // ---------- Sale Domain Delegation ----------
  async createSale(input: AnyRecord) { return this.sales.createSale(input); }
  async updateSale(id: string, input: AnyRecord) { return this.sales.updateSale(id, input); }
  async deleteSale(id: string) { return this.sales.deleteSale(id); }
  async createReceipt(input: AnyRecord) { return this.sales.createReceipt(input); }
  async updateReceipt(id: string, input: AnyRecord) { return this.sales.updateReceipt(id, input); }
  async deleteReceipt(id: string) { return this.sales.deleteReceipt(id); }
  async createCreditNote(input: AnyRecord) { return this.sales.createCreditNote(input); }
  async createDebitNote(input: AnyRecord) { return this.sales.createDebitNote(input); }
  async updateNote(id: string, input: AnyRecord) { return this.sales.updateNote(id, input); }
  async deleteNote(id: string) { return this.sales.deleteNote(id); }
  async listCashMovements() { return this.sales.listCashMovements(); }
  async recordManualCash(input: { date: string; amount: number; direction: 'in' | 'out'; notes?: string }) { return this.sales.recordManualCash(input); }
  async updateManualCash(sourceId: string, input: { date: string; amount: number; direction: 'in' | 'out'; notes?: string }) { return this.sales.updateManualCash(sourceId, input); }
  async deleteManualCash(sourceId: string) { return this.sales.deleteManualCash(sourceId); }

  // ---------- Capital & Books Close Domain Delegation ----------
  async postOpeningBalances(input: V2OpeningBalancesInput) { return this.capital.postOpeningBalances(input); }
  async updateOpeningBalances(input: V2OpeningBalancesInput) { return this.capital.updateOpeningBalances(input); }
  async importClosingBalances(input: V2ClosingBalancesImportInput) { return this.capital.importClosingBalances(input); }
  async getOpeningBalances() { return this.capital.getOpeningBalances(); }
  async recordInventoryCount(input: { date: string; value: number; notes?: string }) { return this.capital.recordInventoryCount(input); }
  async recordManualAsset(input: { date: string; name: string; category?: string; amount: number; funding: 'cash' | 'bank' | 'capital' | 'liability'; notes?: string }) { return this.capital.recordManualAsset(input); }
  async recordManualLiability(input: { date: string; name: string; category?: string; amount: number; recognition: 'cash' | 'bank' | 'asset' | 'expense' | 'creditor'; notes?: string }) { return this.capital.recordManualLiability(input); }
  async inventoryOverview() { return this.capital.inventoryOverview(); }
  async deleteV2InventoryCount(id: string) { return this.capital.deleteV2InventoryCount(id); }
  async listManualBalanceTransactions() { return this.capital.listManualBalanceTransactions(); }
  async deleteManualBalanceTransaction(sourceId: string) { return this.capital.deleteManualBalanceTransaction(sourceId); }
  async updateManualBalanceTransaction(sourceId: string, input: AnyRecord) { return this.capital.updateManualBalanceTransaction(sourceId, input); }
  async closeBooks(input: V2CloseBooksAppInput): Promise<V2CloseBooksAppResult> { return this.capital.closeBooks(input); }

  listEmployees() { return this.payroll.listEmployees(); }
  upsertEmployee(input: AnyRecord) { return this.payroll.upsertEmployee(input as any); }
  archiveEmployee(id: string) { return this.payroll.archiveEmployee(id); }
  runPayroll(input: AnyRecord) { return this.payroll.runPayroll(input as any); }
  listPayRuns() { return this.payroll.listPayRuns(); }
  listPayslips(payRunId: string) { return this.payroll.listPayslips(payRunId); }
  yearEndPayrollSummary(year: string) { return this.payroll.yearEndSummary(year); }

  listFixedAssets() { return this.fixedAssets.listAssets(); }
  acquireFixedAsset(input: AnyRecord) { return this.fixedAssets.acquireAsset(input as any); }
  postAssetDepreciation(input: AnyRecord) { return this.fixedAssets.postDepreciation(input as any); }
  disposeFixedAsset(input: AnyRecord) { return this.fixedAssets.disposeAsset(input as any); }

  listProducts(locationId?: string) { return this.products.listProducts(locationId); }
  upsertProduct(input: AnyRecord) { return this.products.upsertProduct(input as any); }
  archiveProduct(id: string) { return this.products.archiveProduct(id); }
  adjustProductQty(input: AnyRecord) { return this.products.adjustQty(input as any); }

  listLocations() { return this.locations.listLocations(); }
  createLocation(input: AnyRecord) { return this.locations.createLocation(input as any); }
  archiveLocation(id: string) { return this.locations.archiveLocation(id); }
  transferLocationCash(input: AnyRecord) { return this.locations.transferCash(input as any); }
  transferLocationStock(input: AnyRecord) { return this.locations.transferStock(input as any); }
  listLocationStockTransfers() { return this.locations.listStockTransfers(); }

  // ---------- Source Ownership & Helpers ----------
  async sourceType(id: string): Promise<string | null> {
    const row = await this.db.first<{ type: string }>('SELECT type FROM v2_sources WHERE id=?', [id]);
    return row?.type || null;
  }

  async ownsSource(id: string, type?: string) {
    const st = await this.sourceType(id);
    return Boolean(st && (!type || st === type));
  }

  async importScanTransaction(input: V2ScanTransactionImportInput) {
    const context = await this.activeContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    return this.repo.runInTransaction(async () => {
      const partyName = String(input.partyName || '').trim();
      const allowCreation = Boolean(input.createMissingParty);
      switch (input.entryType) {
        case 'sale':
          if (input.method === 'credit') {
            const partyId = await this.parties.approvedScanParty(context.bookId, partyName, 'customer', allowCreation);
            return this.createInvoice({ ...input, partyId, clientName: partyName, total: input.amount });
          }
          return this.createSale({ ...input, method: 'cash' });
        case 'purchase_bill': {
          const partyId = await this.parties.approvedScanParty(context.bookId, partyName, 'supplier', allowCreation);
          return this.createBill({ ...input, partyId, supplierName: partyName, paymentType: input.method === 'credit' ? 'credit' : 'cash' });
        }
        case 'receipt_in':
          if (!partyName) return this.createSale({ ...input, method: 'cash' });
          return this.createReceipt({
            ...input,
            partyId: await this.parties.approvedScanParty(context.bookId, partyName, 'customer', allowCreation),
            clientName: partyName,
            method: 'cash',
          });
        case 'payment_out':
          return this.createPayment({
            ...input,
            partyId: await this.parties.approvedScanParty(context.bookId, partyName, 'supplier', allowCreation),
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
