import AsyncStorage from '@react-native-async-storage/async-storage';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig, ProviderId } from '@/src/db/ai';
import { V2AppService, createAppWriteRouter, createAppMutationRouter, createCloseBooksRouter } from '@/src/accountingV2/appService';
import { initializeV2Book, accountingBookVersion } from '@/src/accountingV2/appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from '@/src/accountingV2/bookConfigRepository';
import type { PersonaId } from '@/src/accountingV2/config';
import {
  listBooks as beListBooks,
  activeBookId as beActiveBookId,
  activeSqlRunner,
  setActiveBook as beSetActiveBook,
  createBook as beCreateBook,
  renameBook as beRenameBook,
  deleteBook as beDeleteBook,
  type BookMeta,
} from '@/src/db/backend';

const AI_PROVIDER_KEY = 'ai_provider';
const AI_API_KEY_KEY  = 'ai_api_key';
const AI_MODEL_KEY    = 'ai_model';
const AI_BASE_URL_KEY = 'ai_base_url';

// Legacy keys kept for migration
const LEGACY_GEMINI_KEY   = 'gemini_api_key';
const LEGACY_GEMINI_MODEL = 'gemini_model';

export async function getAIConfig(): Promise<AIConfig> {
  const [provider, apiKey, model, baseUrl, legacyKey, legacyModel] = await Promise.all([
    AsyncStorage.getItem(AI_PROVIDER_KEY),
    AsyncStorage.getItem(AI_API_KEY_KEY),
    AsyncStorage.getItem(AI_MODEL_KEY),
    AsyncStorage.getItem(AI_BASE_URL_KEY),
    AsyncStorage.getItem(LEGACY_GEMINI_KEY),
    AsyncStorage.getItem(LEGACY_GEMINI_MODEL),
  ]);
  // Migrate legacy Gemini key on first run
  const resolvedKey = apiKey ?? legacyKey ?? (await db.getSettings()).googleApiKey ?? '';
  const resolvedModel = model ?? legacyModel ?? 'gemini-2.0-flash-001';
  return {
    provider: (provider as ProviderId) ?? 'gemini',
    apiKey: resolvedKey,
    model: resolvedModel,
    baseUrl: baseUrl ?? undefined,
  };
}

export async function setAIConfig(cfg: Partial<AIConfig>) {
  const ops: Promise<void>[] = [];
  if (cfg.provider !== undefined) ops.push(AsyncStorage.setItem(AI_PROVIDER_KEY, cfg.provider));
  if (cfg.apiKey  !== undefined) ops.push(AsyncStorage.setItem(AI_API_KEY_KEY,  cfg.apiKey));
  if (cfg.model   !== undefined) ops.push(AsyncStorage.setItem(AI_MODEL_KEY,    cfg.model));
  if (cfg.baseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_BASE_URL_KEY, cfg.baseUrl));
  await Promise.all(ops);
}

// Legacy shims so existing screens (voice.tsx, bill-form.tsx) keep compiling
export async function getGeminiKey(): Promise<string> { return (await getAIConfig()).apiKey; }
export async function setGeminiKey(v: string) { await setAIConfig({ apiKey: v }); }
export async function getGeminiModel(): Promise<string> { return (await getAIConfig()).model; }
export async function setGeminiModel(v: string) { await setAIConfig({ model: v }); }

// ---------- reconcile helper (matching logic in JS) ----------
// Works for BOTH a supplier (compare their statement to our bills/payments) and a
// customer/debtor (compare their statement to our invoices/receipts). `party`
// selects which ledger side to pull; `partyId` is the supplier or debtor id.
async function reconcileStatement(
  imageBase64: string,
  partyId: string,
  mimeType = 'image/jpeg',
  party: 'supplier' | 'customer' = 'supplier',
) {
  const extracted = await ai.reconcileStatementAI(await getAIConfig(), imageBase64, mimeType);

  // Pull our side of the ledger. For a customer, an invoice is a "bill" (debit /
  // what they owe) and a receipt/payment is a "payment" (credit).
  let ourBills: any[] = [], ourPayments: any[] = [];
  if (partyId && party === 'customer') {
    const debtors = await db.listDebtors();
    const d = debtors.find((x: any) => x.id === partyId);
    if (d) {
      ourBills = (d.invoices || []).map((i: any) => ({ ...i, amount: i.amount, date: i.date, reference: i.invoiceNumber }));
      ourPayments = (d.payments || []).map((p: any) => ({ ...p, amount: p.amount, date: p.date }));
    }
  } else if (partyId) {
    const all = await db.listBills();
    ourBills = all.filter((b: any) => b.supplierId === partyId);
    const pays = await db.listPayments();
    ourPayments = pays.filter((p: any) => p.supplierId === partyId && p.type === 'supplier_payment');
  }

  const daysBetween = (a: string, b: string) => {
    const A = new Date(a); const B = new Date(b);
    if (isNaN(A.getTime()) || isNaN(B.getTime())) return 999;
    return Math.abs(Math.round((A.getTime() - B.getTime()) / 86400000));
  };
  const match = (e: any, pool: any[]) => {
    const eAmt = Number(e.amount || 0);
    for (const o of pool) {
      if (daysBetween(e.date || '', o.date || '') > 3) continue;
      const oAmt = Number(o.amount || 0);
      if (eAmt && oAmt && Math.abs(oAmt - eAmt) / Math.max(eAmt, 1) <= 0.01) return o;
    }
    return null;
  };

  const matched: any[] = [], missing: any[] = [];
  for (const e of (extracted.entries || [])) {
    const pool = e.type === 'bill' ? ourBills : e.type === 'payment' ? ourPayments : [...ourBills, ...ourPayments];
    const m = match(e, pool);
    if (m) matched.push({ statement: e, ledgr: m });
    else missing.push(e);
  }
  const stmtRefs = (extracted.entries || []).map((e: any) => ({ date: e.date, amount: Number(e.amount || 0) }));
  const extra: any[] = [];
  for (const o of [...ourBills, ...ourPayments]) {
    const oAmt = Number(o.amount || 0);
    const found = stmtRefs.some((r: any) => r.date === o.date && r.amount && Math.abs(r.amount - oAmt) / Math.max(r.amount, 1) <= 0.01);
    if (!found) extra.push(o);
  }
  return { extracted, matched, missingInLedgr: missing, notOnStatement: extra, partyId, party, supplierId: party === 'supplier' ? partyId : undefined };
}

type AppCreateName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
async function createTransaction(name: AppCreateName, payload: any) {
  const runner = activeSqlRunner();
  if (!runner) return (db[name] as (value: any) => Promise<any>)(payload);
  const writes = createAppWriteRouter(new V2AppService(runner), db);
  return writes[name](payload);
}

async function mutateTransaction(name: 'updateReceipt'|'deleteReceipt'|'markInvoicePaid'|'updateInvoice'|'deleteInvoice'|'updateExpense'|'deleteExpense'|'updatePayment'|'deletePayment'|'updateSale'|'deleteSale'|'updateBill'|'deleteBill', ...args: any[]) {
  const runner = activeSqlRunner();
    const dbFn = (db as any)[name];
    if (!runner) return dbFn(...args);
    return (createAppMutationRouter(new V2AppService(runner), db) as any)[name](...args);
}

export const api = {
  // Persistent V2 runtime services are available after storage initialization.
  v2: () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return require('@/src/accountingV2/runtime').v2Services();
  },
  initializeV2Book: async (options: Parameters<typeof initializeV2Book>[1]) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return initializeV2Book(runner, options);
  },
  v2BookVersion: async (bookId: string) => {
    const runner = activeSqlRunner();
    return runner ? accountingBookVersion(runner, bookId) : null;
  },
  v2Personas: async (bookId: string, includeDisabled = true) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2BookConfigRepository(runner).listPersonas(bookId, includeDisabled);
  },
  setV2Persona: async (bookId: string, type: PersonaId) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2BookConfigRepository(runner).setActivePersona(bookId, type);
  },
  getV2BookConfig: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).getActiveBookConfig();
  },
  updateV2BookConfig: async (config: V2BookConfigUpdate) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).updateActiveBookConfig(config);
  },
  getSettings: () => db.getSettings(),
  updateSettings: (s: any) => db.updateSettings(s),
  testKey: async () => ai.testKey(await getAIConfig()),

  // Books (separate isolated accounts, e.g. Shop vs Technician)
  listBooks: (): Promise<BookMeta[]> => beListBooks(),
  activeBookId: (): string => beActiveBookId(),
  setActiveBook: (id: string) => beSetActiveBook(id),
  createBook: (name: string, businessType?: string) => beCreateBook(name, businessType),
  renameBook: (id: string, name: string) => beRenameBook(id, name),
  deleteBook: (id: string) => beDeleteBook(id),

  listParties: async () => {
    const runner=activeSqlRunner(); if(!runner)return [];
    const service=new V2AppService(runner); return (await service.activeContext()) ? service.listParties() : [];
  },
  listSalesAndInvoices: async () => {
    const runner=activeSqlRunner(); if(!runner)return db.listSales();
    const service=new V2AppService(runner); return (await service.activeContext()) ? service.listSalesAndInvoices() : db.listSales();
  },
  // Suppliers
  listSuppliers: () => db.listSuppliers(),
  createSupplier: (s: any) => db.createSupplier(s),
  updateSupplier: (id: string, s: any) => db.updateSupplier(id, s),
  getSupplier: (id: string) => db.getSupplier(id),
  deleteSupplier: (id: string) => db.deleteSupplier(id),

  listBills: async () => {
    const runner = activeSqlRunner();
    if (!runner) return db.listBills();
    const service = new V2AppService(runner);
    return (await service.activeContext()) ? service.listBills() : db.listBills();
  },
  createBill: (b: any) => createTransaction('createBill', b),
  updateBill: (id: string, b: any) => mutateTransaction('updateBill', id, b),
  deleteBill: (id: string) => mutateTransaction('deleteBill', id),

  listSales: async () => {
    const runner = activeSqlRunner();
    if (!runner) return db.listSales();
    const service = new V2AppService(runner);
    const rows = await service.listSalesAndInvoices();
    return (await service.activeContext()) ? rows.filter((x: any) => x.type === 'cash_sale') : db.listSales();
  },
  createSale: (s: any) => createTransaction('createSale', s),
  updateSale: (id: string, s: any) => mutateTransaction('updateSale', id, s),
  deleteSale: (id: string) => mutateTransaction('deleteSale', id),

  listPayments: () => db.listPayments(),
  createPayment: (p: any) => createTransaction('createPayment', p),
  updatePayment: (id: string, p: any) => mutateTransaction('updatePayment', id, p),
  deletePayment: (id: string) => mutateTransaction('deletePayment', id),

  // Inventory
  listInventory: () => db.listInventory(),
  expectedInventory: () => db.expectedInventory(),
  createInventory: (i: any) => db.createInventory(i),
  deleteInventory: (id: string) => db.deleteInventory(id),

  // Cash Book (manual cash in/out ledger)
  listCashEntries: () => db.listCashEntries(),
  createCashEntry: (e: any) => db.createCashEntry(e),
  updateCashEntry: (id: string, e: any) => db.updateCashEntry(id, e),
  deleteCashEntry: (id: string) => db.deleteCashEntry(id),

  // Dashboard & reports
  dashboard: () => db.dashboard(),
  pnl: () => db.pnl(),
  balanceSheet: () => db.balanceSheet(),
  trialBalance: () => db.trialBalance(),
  capitalStatement: () => db.capitalStatement(),
  drawingsHistory: () => db.drawingsHistory(),
  monthlyProfitTrend: (months?: number) => db.monthlyProfitTrend(months),
  assetDistribution: () => db.assetDistribution(),
  monthlySummary: (m: string) => db.monthlySummary(m),
  dailySummary: (d: string) => db.dailySummary(d),

  // Backup + danger
  exportBackup: async () => {
    const data: any = await db.exportBackup();
    // Strip API key from backup for security
    if (data.settings) {
      const { googleApiKey, ...safeSettings } = data.settings;
      data.settings = safeSettings;
    }
    // Include model name so it carries over to other devices
    data.geminiModel = await getGeminiModel();
    return data;
  },
  importBackup: async (payload: any) => {
    // Strip any API key that may have leaked into an older backup
    if (payload.settings) {
      delete payload.settings.googleApiKey;
    }
    const result = await db.importBackup(payload);
    // Restore model name if present in backup
    if (payload.geminiModel && typeof payload.geminiModel === 'string') {
      await setGeminiModel(payload.geminiModel);
    }
    return result;
  },
  listPeriods: () => db.listPeriods(),
  closePeriod: async (actualStock: number, notes = '') => {
    const runner = activeSqlRunner();
    if (!runner) return db.closePeriod(actualStock, notes);
    const service = new V2AppService(runner);
    const closeBooks = createCloseBooksRouter(service, db.closePeriod);
    const settings = await db.getSettings();
    return closeBooks({ actualStock, openingInventory: Number(settings.openingInventory || 0), commissionPct: Number(settings.managerCommissionPct || 0), notes });
  },
  resetAll: () => db.resetAll(),

  // AI
  parseCommand: async (text: string) => ai.parseCommand(await getAIConfig(), text),
  ocrReceipt: async (imageBase64: string, mimeType = 'image/jpeg') => ai.ocrReceipt(await getAIConfig(), imageBase64, mimeType),
  transcribe: async (audioBase64: string, mimeType = 'audio/m4a') => ai.transcribe(await getAIConfig(), audioBase64, mimeType),
  reconcileStatement: (imageBase64: string, partyId: string, mimeType = 'image/jpeg', party: 'supplier' | 'customer' = 'supplier') => reconcileStatement(imageBase64, partyId, mimeType, party),
  askBooks: async (question: string, dataContext: string) => ai.askBooks(await getAIConfig(), question, dataContext),

  // Expenses
  listExpenses: () => db.listExpenses(),
  createExpense: (e: any) => createTransaction('createExpense', e),
  updateExpense: (id: string, e: any) => mutateTransaction('updateExpense', id, e),
  deleteExpense: (id: string) => mutateTransaction('deleteExpense', id),

  // Debtors
  listDebtors: () => db.listDebtors(),
  createDebtor: (d: any) => db.createDebtor(d),
  updateDebtor: (id: string, d: any) => db.updateDebtor(id, d),
  deleteDebtor: (id: string) => db.deleteDebtor(id),
  addDebtorPayment: (id: string, p: any) => db.addDebtorPayment(id, p),
  deleteDebtorPayment: (debtorId: string, paymentId: string) => db.deleteDebtorPayment(debtorId, paymentId),
  updateDebtorPayment: (debtorId: string, paymentId: string, u: any) => db.updateDebtorPayment(debtorId, paymentId, u),
  getDebtorStatement: (id: string) => db.getDebtorStatement(id),

  // Date-range reports
  pnlRange: (from: string, to: string) => db.pnlRange(from, to),
  creditorsReport: (from?: string, to?: string) => db.creditorsReport(from, to),
  debtorsReport: (from?: string, to?: string) => db.debtorsReport(from, to),

  // Invoices
  listInvoices: () => db.listInvoices(),
  createInvoice: (inv: any) => createTransaction('createInvoice', inv),
  updateInvoice: (id: string, inv: any) => mutateTransaction('updateInvoice', id, inv),
  deleteInvoice: (id: string) => mutateTransaction('deleteInvoice', id),
  markInvoicePaid: (id: string, input?: any) => mutateTransaction('markInvoicePaid', id, input || {}),
  overdueInvoices: () => db.overdueInvoices(),

  // Receipts (money actually received)
  listReceipts: () => db.listReceipts(),
  createReceipt: (r: any) => createTransaction('createReceipt', r),
  updateReceipt: (id: string, input: any) => mutateTransaction('updateReceipt', id, input),
  deleteReceipt: (id: string) => mutateTransaction('deleteReceipt', id),
  invoicePaidAmount: (invoiceId: string) => db.invoicePaidAmount(invoiceId),

  // Advances / Deposits (advance receipts applied to invoices later)
  getAdvanceCredit: (debtorId: string) => db.getAdvanceCredit(debtorId),
  listAdvances: (debtorId: string) => db.listAdvances(debtorId),
  applyAdvanceToInvoice: (debtorId: string, invoiceId: string, amount?: number) => db.applyAdvanceToInvoice(debtorId, invoiceId, amount),

  // Quotes / Estimates (non-posting until converted)
  listQuotes: () => db.listQuotes(),
  createQuote: (q: any) => db.createQuote(q),
  updateQuote: (id: string, q: any) => db.updateQuote(id, q),
  deleteQuote: (id: string) => db.deleteQuote(id),
  setQuoteStatus: (id: string, status: any) => db.setQuoteStatus(id, status),
  convertQuoteToInvoice: (id: string, opts?: any) => db.convertQuoteToInvoice(id, opts),

  // Credit / Debit Notes (post-sale adjustments: discounts, returns, extra charges)
  listCreditNotes: (debtorId?: string) => db.listCreditNotes(debtorId),
  listDebitNotes: (debtorId?: string) => db.listDebitNotes(debtorId),
  createCreditNote: (n: any) => db.createCreditNote(n),
  createDebitNote: (n: any) => db.createDebitNote(n),
  deleteCreditNote: (id: string) => db.deleteCreditNote(id),
  deleteDebitNote: (id: string) => db.deleteDebitNote(id),

  // Delivery Notes / Challans (goods movement, no ledger posting)
  listDeliveryNotes: () => db.listDeliveryNotes(),
  createDeliveryNote: (n: any) => db.createDeliveryNote(n),
  updateDeliveryNote: (id: string, n: any) => db.updateDeliveryNote(id, n),
  deleteDeliveryNote: (id: string) => db.deleteDeliveryNote(id),

  // Enhanced reports
  taxReport: (from: string, to: string) => db.taxReport(from, to),
  salesRegister: (from: string, to: string) => db.salesRegister(from, to),
  receiptsRegister: (from: string, to: string) => db.receiptsRegister(from, to),
};
