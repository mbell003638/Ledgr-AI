import AsyncStorage from '@react-native-async-storage/async-storage';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig, ProviderId } from '@/src/db/ai';
import { V2AppService, createAppWriteRouter, createAppMutationRouter, createCloseBooksRouter } from '@/src/accountingV2/appService';
import { initializeV2Book, accountingBookVersion } from '@/src/accountingV2/appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from '@/src/accountingV2/bookConfigRepository';
import type { PersonaId } from '@/src/accountingV2/config';
import { getV2Dashboard } from '@/src/accountingV2/v2Dashboard';
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
    if (!runner) {
      return { bookId: options.book.id, periodId: options.period.id || `${options.book.id}:period`, version: 1 };
    }
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

  createParty: async (p: any) => {
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const name = (p.name || '').trim();
    if (!name) throw new Error('Party name is required');
    const existingDebtors = await db.listDebtors();
    const existingSuppliers = await db.listSuppliers();
    if ([...existingDebtors, ...existingSuppliers].some((x: any) => norm(x.name) === norm(name))) {
      throw new Error(`A party or customer named '${name}' already exists in this account.`);
    }
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const id = p.id || `party_${Date.now()}`;
        const roles = p.roles || (p.type === 'customer' ? ['customer'] : ['supplier']);
        await service.repo.createParty({
          id,
          bookId: ctx.bookId,
          name,
          phone: p.phone,
          email: p.email,
          roles,
        });
        return { id, name, phone: p.phone, email: p.email, roles };
      }
    }
    return p.type === 'customer' ? db.createDebtor({ ...p, name }) : db.createSupplier({ ...p, name });
  },

  findOrCreateParty: async (rawName: string, role: 'customer' | 'supplier' = 'customer', details?: { phone?: string; email?: string }) => {
    const name = (rawName || '').trim();
    if (!name) return null;
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const [debtors, suppliers] = await Promise.all([db.listDebtors(), db.listSuppliers()]);
    const dMatch = debtors.find((x: any) => norm(x.name) === norm(name));
    const sMatch = suppliers.find((x: any) => norm(x.name) === norm(name));

    if (dMatch || sMatch) {
      const match = dMatch || sMatch;
      // If party exists as debtor but not supplier and role is supplier, auto-add supplier entry
      if (role === 'supplier' && !sMatch && dMatch) {
        try { await db.createSupplier({ name: dMatch.name, phone: dMatch.phone || details?.phone || '' }); } catch {}
      }
      // If party exists as supplier but not debtor and role is customer, auto-add debtor entry
      if (role === 'customer' && !dMatch && sMatch) {
        try { await db.createDebtor({ name: sMatch.name, phone: sMatch.phone || details?.phone || '' }); } catch {}
      }
      return { id: match.id, name: match.name, role: (dMatch && sMatch) ? 'both' : (dMatch ? 'customer' : 'supplier') };
    }

    // Party does not exist -> auto create it in the books
    try {
      const created = role === 'customer' 
        ? await db.createDebtor({ name, phone: details?.phone || '', email: details?.email || '' })
        : await db.createSupplier({ name, phone: details?.phone || '', email: details?.email || '' });
      return { id: created.id, name: created.name, role };
    } catch {
      const freshAll = [...(await db.listDebtors()), ...(await db.listSuppliers())];
      const freshMatch = freshAll.find((x: any) => norm(x.name) === norm(name));
      return freshMatch ? { id: freshMatch.id, name: freshMatch.name, role: freshMatch.role || role } : null;
    }
  },

  searchParties: async (query: string) => {
    const q = (query || '').trim().toLowerCase();
    const [debtors, suppliers] = await Promise.all([db.listDebtors(), db.listSuppliers()]);
    const map = new Map<string, { id: string; name: string; phone?: string; role: string }>();

    for (const d of debtors as any[]) {
      if (d.name) map.set(d.name.trim().toLowerCase(), { id: d.id, name: d.name, phone: d.phone, role: 'customer' });
    }
    for (const s of suppliers as any[]) {
      const k = s.name.trim().toLowerCase();
      const existing = map.get(k);
      if (existing) {
        existing.role = 'both';
      } else {
        map.set(k, { id: s.id, name: s.name, phone: s.phone, role: 'supplier' });
      }
    }

    const list = Array.from(map.values());
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
  },

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
    return (await service.activeContext()) ? rows : db.listSales();
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
  dashboard: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        return getV2Dashboard(runner, ctx.bookId);
      }
    }
    return db.dashboard();
  },
  pnl: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          revenue: d.totalSales, cogs: d.totalPurchases, grossProfit: d.grossProfit,
          managerCommissionPct: d.managerCommissionPct, commission: d.commission,
          drawings: d.drawings, netProfit: d.netProfit,
        };
      }
    }
    return db.pnl();
  },
  balanceSheet: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          assets: { cash: d.cash, inventory: d.inventoryValue, total: d.assets },
          liabilities: { suppliersPayable: d.liabilities, total: d.liabilities },
          equity: d.netWorth,
        };
      }
    }
    return db.balanceSheet();
  },
  trialBalance: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          debits: [
            { account: 'Cash', amount: d.cash },
            { account: 'Inventory', amount: d.inventoryValue },
            { account: 'Purchases', amount: d.totalPurchases },
            { account: 'Drawings', amount: d.drawings },
          ],
          credits: [
            { account: 'Sales Revenue', amount: d.totalSales },
            { account: 'Accounts Payable', amount: d.liabilities },
          ],
        };
      }
    }
    return db.trialBalance();
  },
  capitalStatement: () => db.capitalStatement(),
  drawingsHistory: () => db.drawingsHistory(),
  monthlyProfitTrend: (months?: number) => db.monthlyProfitTrend(months),
  assetDistribution: () => db.assetDistribution(),
  monthlySummary: (m: string) => db.monthlySummary(m),
  dailySummary: async (d: string) => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const salesAndInvoices = await service.listSalesAndInvoices();
        const bills = await service.listBills();
        const daySales = salesAndInvoices.filter((x: any) => (x.date || '').slice(0, 10) === d);
        const dayBills = bills.filter((x: any) => (x.date || '').slice(0, 10) === d);
        const revenue = daySales.reduce((sum: number, x: any) => sum + (Number(x.amount) || 0), 0);
        const purchases = dayBills.reduce((sum: number, x: any) => sum + (Number(x.amount) || 0), 0);
        const grossProfit = Math.round((revenue - purchases) * 100) / 100;
        return {
          date: d,
          revenue: Math.round(revenue * 100) / 100,
          purchases: Math.round(purchases * 100) / 100,
          grossProfit,
          netCash: Math.round(revenue * 100) / 100,
          salesCount: daySales.length,
          billsCount: dayBills.length,
          paymentsCount: 0,
        };
      }
    }
    return db.dailySummary(d);
  },

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
  resetAll: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      await Promise.all([
        'v2_sources', 'v2_journal_entries', 'v2_journal_lines', 'v2_parties',
        'v2_invoice_allocations', 'v2_inventory_counts', 'v2_members', 'v2_close_books',
        'v2_periods', 'v2_accounts', 'v2_personas', 'v2_books'
      ].map(t => runner.run(`DELETE FROM ${t}`).catch(() => {})));
      await runner.run(`DELETE FROM meta WHERE key LIKE 'v2_%'`).catch(() => {});
    }
    return db.resetAll();
  },

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
