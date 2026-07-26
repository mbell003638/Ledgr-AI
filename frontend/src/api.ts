import AsyncStorage from '@react-native-async-storage/async-storage';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig, ProviderId } from '@/src/db/ai';

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

export const api = {
  // Settings
  getSettings: () => db.getSettings(),
  updateSettings: (s: any) => db.updateSettings(s),
  testKey: async () => ai.testKey(await getAIConfig()),

  // Suppliers
  listSuppliers: () => db.listSuppliers(),
  createSupplier: (s: any) => db.createSupplier(s),
  updateSupplier: (id: string, s: any) => db.updateSupplier(id, s),
  getSupplier: (id: string) => db.getSupplier(id),
  deleteSupplier: (id: string) => db.deleteSupplier(id),

  // Bills / Sales / Payments
  listBills: () => db.listBills(),
  createBill: (b: any) => db.createBill(b),
  updateBill: (id: string, b: any) => db.updateBill(id, b),
  deleteBill: (id: string) => db.deleteBill(id),

  listSales: () => db.listSales(),
  createSale: (s: any) => db.createSale(s),
  updateSale: (id: string, s: any) => db.updateSale(id, s),
  deleteSale: (id: string) => db.deleteSale(id),

  listPayments: () => db.listPayments(),
  createPayment: (p: any) => db.createPayment(p),
  updatePayment: (id: string, p: any) => db.updatePayment(id, p),
  deletePayment: (id: string) => db.deletePayment(id),

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
  closePeriod: (actualStock: number, notes = '') => db.closePeriod(actualStock, notes),
  resetAll: () => db.resetAll(),

  // AI
  parseCommand: async (text: string) => ai.parseCommand(await getAIConfig(), text),
  ocrReceipt: async (imageBase64: string, mimeType = 'image/jpeg') => ai.ocrReceipt(await getAIConfig(), imageBase64, mimeType),
  transcribe: async (audioBase64: string, mimeType = 'audio/m4a') => ai.transcribe(await getAIConfig(), audioBase64, mimeType),
  reconcileStatement: (imageBase64: string, partyId: string, mimeType = 'image/jpeg', party: 'supplier' | 'customer' = 'supplier') => reconcileStatement(imageBase64, partyId, mimeType, party),
  askBooks: async (question: string, dataContext: string) => ai.askBooks(await getAIConfig(), question, dataContext),

  // Expenses
  listExpenses: () => db.listExpenses(),
  createExpense: (e: any) => db.createExpense(e),
  updateExpense: (id: string, e: any) => db.updateExpense(id, e),
  deleteExpense: (id: string) => db.deleteExpense(id),

  // Debtors
  listDebtors: () => db.listDebtors(),
  createDebtor: (d: any) => db.createDebtor(d),
  updateDebtor: (id: string, d: any) => db.updateDebtor(id, d),
  deleteDebtor: (id: string) => db.deleteDebtor(id),
  addDebtorPayment: (id: string, p: any) => db.addDebtorPayment(id, p),
  getDebtorStatement: (id: string) => db.getDebtorStatement(id),

  // Date-range reports
  pnlRange: (from: string, to: string) => db.pnlRange(from, to),
  creditorsReport: (from?: string, to?: string) => db.creditorsReport(from, to),
  debtorsReport: (from?: string, to?: string) => db.debtorsReport(from, to),

  // Invoices
  listInvoices: () => db.listInvoices(),
  createInvoice: (inv: any) => db.createInvoice(inv),
  updateInvoice: (id: string, inv: any) => db.updateInvoice(id, inv),
  deleteInvoice: (id: string) => db.deleteInvoice(id),
  markInvoicePaid: (id: string) => db.markInvoicePaid(id),
  overdueInvoices: () => db.overdueInvoices(),

  // Receipts (money actually received)
  listReceipts: () => db.listReceipts(),
  createReceipt: (r: any) => db.createReceipt(r),
  deleteReceipt: (id: string) => db.deleteReceipt(id),
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
