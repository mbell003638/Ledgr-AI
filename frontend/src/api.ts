import AsyncStorage from '@react-native-async-storage/async-storage';
import { storage } from '@/src/utils/storage';
import { bumpDataVersion } from '@/src/utils/dataVersion';
import { dedupeLegacyMirrors } from '@/src/utils/ledgerDisplay';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig, ProviderId } from '@/src/db/ai';
import { V2AppService, createAppWriteRouter, createAppMutationRouter, createCloseBooksRouter, recordMirrorError } from '@/src/accountingV2/appService';
import { initializeV2Book, accountingBookVersion } from '@/src/accountingV2/appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from '@/src/accountingV2/bookConfigRepository';
import type { PersonaId } from '@/src/accountingV2/config';
import { getV2Dashboard } from '@/src/accountingV2/v2Dashboard';
import { buildPersistentV2Reports } from '@/src/accountingV2/persistentReports';
import { resetAllV2AccountingData, factoryResetV2Data } from '@/src/accountingV2/resetBook';
import { V2InvestorLedgerService, type InvestorLedgerDetail } from '@/src/accountingV2/investorLedgerService';
import {
  listBooks as beListBooks,
  activeBookId as beActiveBookId,
  activeSqlRunner,
  setActiveBook as beSetActiveBook,
  createBook as beCreateBook,
  renameBook as beRenameBook,
  deleteBook as beDeleteBook,
  resetBooksAndActiveBook as beResetBooksAndActiveBook,
  type BookMeta,
} from '@/src/db/backend';

const AI_PROVIDER_KEY = 'ai_provider';
const AI_API_KEY_KEY  = 'ai_api_key';
const AI_MODEL_KEY    = 'ai_model';
const AI_BASE_URL_KEY = 'ai_base_url';

// Legacy keys kept for migration
const LEGACY_GEMINI_KEY   = 'gemini_api_key';
const LEGACY_GEMINI_MODEL = 'gemini_model';

// User-preference + UI-customization AsyncStorage keys that live OUTSIDE the
// per-book settings blob. A factory reset must wipe these too so the device is
// returned to a truly pristine state (the user explicitly wants preferences
// gone, not preserved). Mirrors the keys written by:
//   - ThemeContext.tsx: 'theme_mode', 'animations_enabled'
//   - app/(tabs)/index.tsx: 'ledgr_tile_order', 'ledgr_tile_usage'
const THEME_MODE_KEY        = 'theme_mode';
const ANIMATIONS_ENABLED_KEY = 'animations_enabled';
const TILE_ORDER_KEY        = 'ledgr_tile_order';
const TILE_USAGE_KEY        = 'ledgr_tile_usage';
// Exported so the reset UI (advanced-settings) can assert/reset in lockstep and
// tests can enumerate the exact device-level keys a factory reset must clear.
export const FACTORY_RESET_PREF_KEYS = [
  THEME_MODE_KEY,
  ANIMATIONS_ENABLED_KEY,
  TILE_ORDER_KEY,
  TILE_USAGE_KEY,
] as const;

export async function getAIConfig(): Promise<AIConfig> {
  const [provider, secureKey, storedKey, model, baseUrl, legacyKey, legacyModel] = await Promise.all([
    AsyncStorage.getItem(AI_PROVIDER_KEY),
    storage.secureGet(AI_API_KEY_KEY, ''),
    AsyncStorage.getItem(AI_API_KEY_KEY),
    AsyncStorage.getItem(AI_MODEL_KEY),
    AsyncStorage.getItem(AI_BASE_URL_KEY),
    AsyncStorage.getItem(LEGACY_GEMINI_KEY),
    AsyncStorage.getItem(LEGACY_GEMINI_MODEL),
  ]);
  // Migrate every historical plaintext key into the device keychain/keystore.
  const resolvedKey = secureKey || storedKey || legacyKey || '';
  if (resolvedKey && !secureKey) {
    await Promise.all([
      storage.secureSet(AI_API_KEY_KEY, resolvedKey),
      AsyncStorage.removeItem(AI_API_KEY_KEY),
      AsyncStorage.removeItem(LEGACY_GEMINI_KEY),
    ]);
  }
  const resolvedModel = model ?? legacyModel ?? ai.DEFAULT_GEMINI_MODEL;
  return {
    provider: ai.normalizeProviderId(provider),
    apiKey: resolvedKey,
    model: resolvedModel,
    baseUrl: baseUrl ?? undefined,
  };
}

export async function setAIConfig(cfg: Partial<AIConfig>) {
  const ops: Promise<unknown>[] = [];
  if (cfg.provider !== undefined) ops.push(AsyncStorage.setItem(AI_PROVIDER_KEY, cfg.provider));
  // The secure keychain write is the ONE op whose failure must not be silent:
  // the storage wrapper returns false (never throws) on failure, and the
  // original code discarded that result — a lost API key would vanish with no
  // signal. Check it explicitly and throw so the caller can alert the user. [M4]
  let secureKeyWrite: Promise<boolean> | null = null;
  if (cfg.apiKey !== undefined) {
    secureKeyWrite = cfg.apiKey ? storage.secureSet(AI_API_KEY_KEY, cfg.apiKey) : storage.secureRemove(AI_API_KEY_KEY);
    ops.push(AsyncStorage.removeItem(AI_API_KEY_KEY));
  }
  if (cfg.model !== undefined) ops.push(AsyncStorage.setItem(AI_MODEL_KEY, cfg.model));
  if (cfg.baseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_BASE_URL_KEY, cfg.baseUrl));
  const [secureOk] = await Promise.all([
    secureKeyWrite ?? Promise.resolve(true),
    ...ops,
  ]);
  if (secureKeyWrite && secureOk === false) {
    throw new Error('Could not securely save your API key on this device. Please try again.');
  }
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

  // V2 is authoritative whenever it is active. Legacy collections remain only as a fallback.
  let ourBills: any[] = [], ourPayments: any[] = [];
  const runner = activeSqlRunner();
  const service = runner ? new V2AppService(runner) : null;
  const context = service ? await service.activeContext() : null;
  if (context && service && partyId) {
    const detail: any = await service.getPartyDetail(partyId, party);
    if (party === 'customer' && detail) {
      ourBills = (detail.statement?.ledger || []).filter((item: any) => item.kind === 'invoice').map((item: any) => ({ amount: item.debit, date: item.date, reference: item.ref }));
      ourPayments = (detail.payments || []).map((item: any) => ({ amount: item.amount, date: item.date }));
    } else if (party === 'supplier' && detail) {
      ourBills = detail.bills || [];
      ourPayments = detail.payments || [];
    }
  } else if (partyId && party === 'customer') {
    const debtors = await db.listDebtors();
    const d = debtors.find((x: any) => x.id === partyId);
    if (d) {
      ourBills = (d.invoices || []).map((i: any) => ({ ...i, amount: i.amount, date: i.date, reference: i.invoiceNumber }));
      ourPayments = (d.payments || []).map((item: any) => ({ ...item, amount: item.amount, date: item.date }));
    }
  } else if (partyId) {
    const all = await db.listBills();
    ourBills = all.filter((item: any) => item.supplierId === partyId);
    const payments = await db.listPayments();
    ourPayments = payments.filter((item: any) => item.supplierId === partyId && item.type === 'supplier_payment');
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

async function buildAiSnapshot(from: string, to: string) {
  const settings = await db.getSettings();
  const runner = activeSqlRunner();
  if (runner) {
    const service = new V2AppService(runner);
    const context = await service.activeContext();
    if (context) {
      const [dashboard, reports, parties, salesAndInvoices, expenseSources] = await Promise.all([
        getV2Dashboard(runner, context.bookId),
        buildPersistentV2Reports(runner, { bookId: context.bookId, from, to }),
        service.listParties(),
        service.listSalesAndInvoices(),
        runner.all<any>("SELECT date,metadata FROM v2_sources WHERE book_id=? AND type='expense' AND date>=? AND date<=? ORDER BY date DESC", [context.bookId, from, to]),
      ]);
      const expensesByCategory: Record<string, number> = {};
      for (const row of expenseSources) {
        let meta: any = {}; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
        if (!meta.reversed && !meta.deleted) expensesByCategory.General = (expensesByCategory.General || 0) + Number(meta.total || 0);
      }
      return {
        source: 'v2', currency: settings.currency, businessName: settings.businessName,
        snapshot: { cash: dashboard.cash, inventoryValue: dashboard.inventoryValue, netWorth: dashboard.netWorth, totalSales: dashboard.totalSales, totalPurchases: dashboard.totalPurchases, grossProfit: dashboard.grossProfit, netProfit: dashboard.netProfit },
        yearToDate: reports.profitAndLoss,
        creditors: parties.filter((p: any) => p.roles.includes('supplier') && p.payable !== 0).sort((a: any, b: any) => b.payable - a.payable).slice(0, 20).map((p: any) => ({ name: p.name, owed: p.payable })),
        debtors: parties.filter((p: any) => p.roles.includes('customer') && p.receivable !== 0).sort((a: any, b: any) => b.receivable - a.receivable).slice(0, 20).map((p: any) => ({ name: p.name, owes: p.receivable })),
        expensesByCategory,
        openInvoices: salesAndInvoices.filter((item: any) => item.type === 'invoice' && item.status !== 'paid').slice(0, 20).map((item: any) => ({ number: item.reference || item.id, client: item.clientName, amount: item.openAmount ?? item.amount })),
      };
    }
  }
  const [dashboard, pnlYear, creditors, debtors, expenses, invoices] = await Promise.all([
    db.dashboard(), db.pnlRange(from, to), db.creditorsReport(), db.debtorsReport(), db.listExpenses(), db.listInvoices(),
  ]);
  const expensesByCategory: Record<string, number> = {};
  for (const expense of expenses as any[]) expensesByCategory[expense.category || 'General'] = (expensesByCategory[expense.category || 'General'] || 0) + Number(expense.amount || 0);
  return {
    source: 'legacy', currency: settings.currency, businessName: settings.businessName,
    snapshot: { cash: dashboard.cash, inventoryValue: dashboard.inventoryValue, netWorth: dashboard.netWorth, totalSales: dashboard.totalSales, totalPurchases: dashboard.totalPurchases, grossProfit: dashboard.grossProfit, netProfit: dashboard.netProfit },
    yearToDate: pnlYear,
    creditors: (creditors as any[]).filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance).slice(0, 20).map((c) => ({ name: c.name, owed: c.balance })),
    debtors: (debtors as any[]).filter((d) => d.balance !== 0).sort((a, b) => b.balance - a.balance).slice(0, 20).map((d) => ({ name: d.name, owes: d.balance })),
    expensesByCategory,
    openInvoices: (invoices as any[]).filter((i) => i.status === 'unpaid').sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 20).map((i) => ({ number: i.invoiceNumber, client: i.clientName, amount: i.total })),
  };
}
type AppCreateName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
async function createTransaction(name: AppCreateName, payload: any) {
  const runner = activeSqlRunner();
  if (!runner) {
    const r = await (db[name] as (value: any) => Promise<any>)(payload);
    bumpDataVersion();
    return r;
  }
  const writes = createAppWriteRouter(new V2AppService(runner), db);

  const injected = { ...payload };
  if (name === 'createBill' || name === 'createPayment') {
    if (injected.supplierId && !injected.supplierName) {
      try {
        const s = await db.getSupplier(injected.supplierId);
        injected.supplierName = s.name;
      } catch {}
    }
  } else if (name === 'createInvoice' || name === 'createReceipt') {
    if ((injected.partyId || injected.debtorId) && !injected.clientName) {
      try {
        const debtors = await db.listDebtors();
        const partyId = injected.partyId || injected.debtorId;
        const d = debtors.find((x: any) => x.id === partyId);
        if (d) injected.clientName = d.name;
      } catch {}
    }
  }

  const result = await writes[name](injected);
  bumpDataVersion();
  return result;
}

async function mutateTransaction(name: 'updateReceipt'|'deleteReceipt'|'markInvoicePaid'|'updateInvoice'|'deleteInvoice'|'updateExpense'|'deleteExpense'|'updatePayment'|'deletePayment'|'updateSale'|'deleteSale'|'updateBill'|'deleteBill', ...args: any[]) {
  const runner = activeSqlRunner();
    const dbFn = (db as any)[name];
    if (!runner) {
      const r = await dbFn(...args);
      bumpDataVersion();
      return r;
    }
    const r = await (createAppMutationRouter(new V2AppService(runner), db) as any)[name](...args);
    bumpDataVersion();
    return r;
}

/**
 * [Finding A] Create a credit/debit note. The customer screen sends {customerId}
 * and the supplier screen sends {supplierId}; db.createNote requires {debtorId}.
 * We map those fields to a canonical shape, route the note through the V2 write
 * path (so it hits the journal + party balance and is visible on party detail /
 * statements), and keep a legacy mirror consistent with the other documents.
 * Off the V2 path (no runner) we fall back to the legacy record alone.
 */
async function createNote(name: 'createCreditNote'|'createDebitNote', raw: any) {
  const isSupplier = raw.supplierId != null || raw.role === 'supplier';
  const partyId = raw.debtorId || raw.customerId || raw.supplierId || raw.partyId;
  const partyName = raw.clientName || raw.customerName || raw.supplierName || raw.partyName || '';
  const mapped = {
    ...raw,
    debtorId: partyId,
    partyId,
    role: isSupplier ? 'supplier' : 'customer',
    clientName: isSupplier ? raw.clientName : partyName,
    supplierName: isSupplier ? partyName : raw.supplierName,
  };
  const runner = activeSqlRunner();
  if (runner && await new V2AppService(runner).activeContext(mapped.date)) {
    const v2 = new V2AppService(runner);
    const v2Res = await (name === 'createCreditNote' ? v2.createCreditNote(mapped) : v2.createDebitNote(mapped));
    // Legacy mirror (best-effort, keyed by debtorId like the other documents).
    try { await (db[name] as (value: any) => Promise<any>)({ ...mapped, invoiceId: mapped.invoiceId || mapped.invoiceSourceId || null }); }
    catch (error) { recordMirrorError(name, error); }
    bumpDataVersion();
    const total = Number(v2Res.source?.metadata?.total ?? mapped.amount);
    return { ...v2Res, id: v2Res.source?.id, noteNumber: v2Res.source?.reference || v2Res.source?.id, amount: total };
  }
  const r = await (db[name] as (value: any) => Promise<any>)(mapped);
  bumpDataVersion();
  return r;
}

/**
 * [Vault C2] Build human-readable warnings comparing the legacy collections to
 * their authoritative V2 source counterparts. Returns [] when there is no V2
 * context (nothing to diverge from) or the counts match. Best-effort: any error
 * yields no warning rather than blocking the export.
 */
async function exportDivergenceWarnings(): Promise<string[]> {
  const runner = activeSqlRunner();
  if (!runner) return [];
  const warnings: string[] = [];
  try {
    const service = new V2AppService(runner);
    const ctx = await service.activeContext();
    if (!ctx) return [];
    const bookId = ctx.bookId;
    const v2Count = async (type: string): Promise<number> => {
      const row = await runner.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=? AND type=?', [bookId, type]);
      return Number(row?.n || 0);
    };
    // (legacyCount, v2 source type, human label)
    const checks: Array<[Promise<any[]>, string, string]> = [
      [db.listInvoices(), 'invoice', 'invoices'],
      [db.listBills(), 'bill', 'bills'],
      [db.listReceipts(), 'receipt', 'receipts'],
      [db.listPayments(), 'payment', 'payments'],
    ];
    for (const [legacyPromise, v2Type, label] of checks) {
      const [legacyRows, v2n] = await Promise.all([legacyPromise, v2Count(v2Type)]);
      const legacyN = Array.isArray(legacyRows) ? legacyRows.length : 0;
      if (legacyN !== v2n) {
        warnings.push(`${label}: legacy backup has ${legacyN} record(s) but the V2 ledger has ${v2n}. The V2 ledger is authoritative and will be restored intact.`);
      }
    }
  } catch { /* divergence check is advisory only */ }
  return warnings;
}

/**
 * The ONE computation of an investor's live ledger detail: the V2
 * journal-derived detail merged with any legacy-only capital movements that
 * predate V2. Both the investor detail screen (api.getInvestorLedger) and the
 * Parties list tile (api.listInvestors) MUST read the balance from here so the
 * two surfaces can never disagree after a deposit/draw.
 */
async function mergedInvestorLedgerDetail(id: string): Promise<InvestorLedgerDetail> {
  const runner = activeSqlRunner();
  if (!runner) return db.investorLedgerDetail(id);
  const app = new V2AppService(runner);
  const context = await app.activeContext();
  if (!context) return db.investorLedgerDetail(id);
  const v2 = await new V2InvestorLedgerService(runner).detail(context.bookId, id);
  let legacy: db.InvestorLedgerDetail | null = null;
  try { legacy = await db.investorLedgerDetail(v2.name); } catch { /* no legacy member mirror */ }
  if (!legacy) return v2;
  const known = new Set(v2.transactions.map((item) => item.id));
  const extras = legacy.transactions.filter((item) => !known.has(item.id) && (item.type === 'capital_injection' || item.type === 'drawing'));
  const extraInjected = extras.filter((item) => item.type === 'capital_injection').reduce((sum, item) => sum + item.amount, 0);
  const extraDrawings = extras.filter((item) => item.type === 'drawing').reduce((sum, item) => sum + item.amount, 0);
  return {
    ...v2,
    totalInjected: Math.round((v2.totalInjected + extraInjected) * 100) / 100,
    totalDrawings: Math.round((v2.totalDrawings + extraDrawings) * 100) / 100,
    currentCapitalBalance: Math.round((v2.currentCapitalBalance + extraInjected - extraDrawings) * 100) / 100,
    transactions: [...v2.transactions, ...extras].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
  };
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
    const r = await new V2BookConfigRepository(runner).setActivePersona(bookId, type);
    bumpDataVersion();
    return r;
  },
  getV2BookConfig: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).getActiveBookConfig();
  },
  updateV2BookConfig: async (config: V2BookConfigUpdate) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).updateActiveBookConfig(config);
    bumpDataVersion();
    return r;
  },
  postV2OpeningBalances: async (input: { date?: string; cash: number; inventory: number; memo?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).postOpeningBalances(input);
    bumpDataVersion();
    return r;
  },
  updateV2OpeningBalances: async (input: { date?: string; cash: number; inventory: number; memo?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).updateOpeningBalances(input);
    bumpDataVersion();
    return r;
  },
  recordV2InventoryCount: async (input: { date: string; value: number; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).recordInventoryCount(input);
    bumpDataVersion();
    return r;
  },
  createManualAsset: async (input: { date: string; name: string; category?: string; amount: number; funding: 'cash' | 'bank' | 'capital' | 'liability'; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual asset transactions require SQLite storage');
    const r = await new V2AppService(runner).recordManualAsset(input);
    bumpDataVersion();
    return r;
  },
  createManualLiability: async (input: { date: string; name: string; category?: string; amount: number; recognition: 'cash' | 'bank' | 'asset' | 'expense' | 'creditor'; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual liability transactions require SQLite storage');
    const r = await new V2AppService(runner).recordManualLiability(input);
    bumpDataVersion();
    return r;
  },
  listManualBalanceTransactions: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    return new V2AppService(runner).listManualBalanceTransactions();
  },
  deleteManualBalanceTransaction: async (sourceId: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual balance transactions require SQLite storage');
    const r = await new V2AppService(runner).deleteManualBalanceTransaction(sourceId);
    bumpDataVersion();
    return r;
  },
  getSettings: () => db.getSettings(),
  updateSettings: async (s: any) => { const r = await db.updateSettings(s); bumpDataVersion(); return r; },
  testKey: async () => ai.testKey(await getAIConfig()),

  // Books (separate isolated accounts, e.g. Shop vs Technician)
  listBooks: (): Promise<BookMeta[]> => beListBooks(),
  activeBookId: (): string => beActiveBookId(),
  setActiveBook: async (id: string) => { const r = await beSetActiveBook(id); bumpDataVersion(); return r; },
  createBook: async (name: string, businessType?: string) => { const r = await beCreateBook(name, businessType); bumpDataVersion(); return r; },
  renameBook: async (id: string, name: string) => { const r = await beRenameBook(id, name); bumpDataVersion(); return r; },
  deleteBook: async (id: string) => { const r = await beDeleteBook(id); bumpDataVersion(); return r; },

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

    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      if (await service.activeContext()) {
        const existing = (await service.listParties()).find((party: any) => norm(party.name) === norm(name));
        const party = existing || await service.ensureParty(name, role, details);
        const roles: string[] = Array.isArray(party.roles) ? party.roles : JSON.parse(party.roles || '[]');
        if (!roles.includes(role)) await service.ensureParty(name, role, details);
        try {
          const legacy = role === 'customer' ? await db.listDebtors() : await db.listSuppliers();
          if (!legacy.some((item: any) => norm(item.name) === norm(name))) {
            if (role === 'customer') await db.createDebtor({ name: party.name, phone: details?.phone || '', email: details?.email || '' });
            else await db.createSupplier({ name: party.name, phone: details?.phone || '', email: details?.email || '' });
          }
        } catch { /* V2 remains authoritative */ }
        return { id: party.id, name: party.name, role: roles.length > 1 ? 'both' : role };
      }
    }

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
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      if (await service.activeContext()) {
        const parties = await service.listParties();
        return parties
          .filter((party: any) => !q || party.name.toLowerCase().includes(q))
          .map((party: any) => ({
            id: party.id, name: party.name, phone: party.phone || '',
            role: party.roles.length > 1 ? 'both' : party.roles[0],
          }));
      }
    }
    const [debtors, suppliers] = await Promise.all([db.listDebtors(), db.listSuppliers()]);
    const map = new Map<string, { id: string; name: string; phone: string; role: string }>();

    for (const d of debtors as any[]) {
      if (d.name) map.set(d.name.trim().toLowerCase(), { id: d.id, name: d.name, phone: d.phone || '', role: 'customer' });
    }
    for (const s of suppliers as any[]) {
      const k = s.name.trim().toLowerCase();
      const existing = map.get(k);
      if (existing) {
        existing.role = 'both';
      } else {
        map.set(k, { id: s.id, name: s.name, phone: s.phone || '', role: 'supplier' });
      }
    }

    const list = Array.from(map.values());
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q));
  },

  listParties: async () => {
    const runner = activeSqlRunner();
    if (!runner) return [];
    const service = new V2AppService(runner);
    if (await service.activeContext()) {
      const v2Parties = await service.listParties();
      const [suppliers, debtors] = await Promise.all([db.listSuppliers(), db.listDebtors()]);
      const v1Map = new Map();
      for (const s of suppliers) v1Map.set(s.id, s.name);
      for (const d of debtors) v1Map.set(d.id, d.name);
      return v2Parties.map(p => {
        const isId = /^[0-9]+-[a-z0-9]+$/.test(p.name) || p.name === p.id;
        if (isId && v1Map.get(p.id)) {
          p.name = v1Map.get(p.id);
        }
        return p;
      });
    }
    return [];
  },
  listInvestors: async (): Promise<Array<{ id: string; name: string; openingCapital: number; currentCapital: number; profitSharePct: number }>> => {
    const settings = await db.getSettings();
    if (settings.accountingStyle !== 'retail_partnership') return [];
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext();
      if (context) {
        const rows = await runner.all<any>('SELECT id,name,opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY name', [context.bookId]);
        if (rows.length) {
          // v2_members.current_capital is the PERIOD-OPENING capital snapshot;
          // the live balance is journal-derived. Compute it via the SAME
          // merged-ledger path the investor detail screen uses so the Parties
          // tile always shows Opening + injections + profit share − drawings.
          return Promise.all(rows.map(async (row) => {
            let currentCapital = Number(row.current_capital);
            try { currentCapital = (await mergedInvestorLedgerDetail(row.id)).currentCapitalBalance; }
            catch { /* keep the period-opening snapshot if the detail is unavailable */ }
            return { id: row.id, name: row.name, openingCapital: Number(row.opening_contribution), currentCapital, profitSharePct: Number(row.profit_share_pct) };
          }));
        }
      }
    }
    return (settings.investors || []).map((item: any) => ({ id: String(item.id || item.name), name: String(item.name), openingCapital: Number(item.amount || 0), currentCapital: Number(item.amount || 0), profitSharePct: Number(item.profitSharePct || 0) }));
  },
  listSalesAndInvoices: async () => {
    const runner=activeSqlRunner(); if(!runner)return db.listSales();
    const service=new V2AppService(runner); return (await service.activeContext()) ? service.listSalesAndInvoices() : db.listSales();
  },
  // Suppliers
  listSuppliers: () => db.listSuppliers(),
  createSupplier: (s: any) => db.createSupplier(s),
  updateSupplier: async (id: string, s: any) => {
    const runner = activeSqlRunner(); if (runner) { const service = new V2AppService(runner); if (await service.getPartyDetail(id, 'supplier')) return service.updateParty(id, s); }
    return db.updateSupplier(id, s);
  },
  getSupplier: async (id: string) => {
    const runner = activeSqlRunner(); if (runner) { const detail = await new V2AppService(runner).getPartyDetail(id, 'supplier'); if (detail) return detail; }
    return db.getSupplier(id);
  },
  deleteSupplier: async (id: string) => {
    const runner = activeSqlRunner(); if (runner) { const service = new V2AppService(runner); if (await service.getPartyDetail(id, 'supplier')) return service.archiveParty(id); }
    return db.deleteSupplier(id);
  },
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
  v2InventoryOverview: async () => {
    const runner = activeSqlRunner();
    if (!runner) return null;
    return new V2AppService(runner).inventoryOverview();
  },
  deleteV2InventoryCount: async (id: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).deleteV2InventoryCount(id);
  },
  listInventory: () => db.listInventory(),
  expectedInventory: () => db.expectedInventory(),
  createInventory: (i: any) => db.createInventory(i),
  deleteInventory: (id: string) => db.deleteInventory(id),

  // Cash Book (manual cash in/out ledger)
  listCashEntries: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        // V2 rows are journal-derived movements. They stay visible, but must be
        // changed from their original source document rather than as cash rows.
        // The enriched read includes reversal linkage (reversal_of/posted_at/
        // source flags) so screens can collapse reverse+repost noise for display.
        // Capital deposits keep the journal memo ("Capital deposit — <name>")
        // and surface the user's own note as appended detail.
        const v2Entries = (await service.listCashMovements()).map((entry: any) => ({
          ...entry,
          notes: entry.sourceType === 'capital_injection' && entry.sourceNotes && !String(entry.notes || '').includes(entry.sourceNotes)
            ? `${entry.notes} — ${entry.sourceNotes}`
            : entry.notes,
          origin: 'v2',
          editable: false,
        }));
        const legacyEntries = (await db.listCashEntries()).map((entry: any) => ({ ...entry, origin: 'manual', editable: true }));
        // Legacy rows that merely MIRROR a V2-journaled movement (investor
        // capital mirrors, receipt bridge rows) carry different ids than their
        // journal-derived twins, so the id-keyed merge below can't collapse
        // them — dedupe on source linkage FIRST so screens list (and total)
        // each movement exactly once.
        const merged = dedupeLegacyMirrors([...legacyEntries, ...v2Entries] as any);
        const all = [...new Map(merged.map((entry: any) => [entry.id, entry])).values()].sort((a: any, b: any) =>
          (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0)
        );
        return all;
      }
    }
    return db.listCashEntries();
  },
  createCashEntry: async (e: any) => { const r = await db.createCashEntry(e); bumpDataVersion(); return r; },
  updateCashEntry: async (id: string, e: any) => { const r = await db.updateCashEntry(id, e); bumpDataVersion(); return r; },
  deleteCashEntry: async (id: string) => { const r = await db.deleteCashEntry(id); bumpDataVersion(); return r; },

  getInvestorLedger: async (id: string): Promise<InvestorLedgerDetail> => {
    const settings = await db.getSettings();
    if (settings.accountingStyle !== 'retail_partnership') throw new Error('Investor ledgers are available only in Partnership Mode');
    return mergedInvestorLedgerDetail(id);
  },
  depositInvestorCapital: async (id: string, input: { amount: number; date: string; notes?: string }) => {
    const settings = await db.getSettings();
    if (settings.accountingStyle !== 'retail_partnership') throw new Error('Investor ledgers are available only in Partnership Mode');
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext(input.date);
      if (context) {
        const result = await new V2InvestorLedgerService(runner).deposit({ ...input, bookId: context.bookId, memberId: id });
        // Legacy mirror for backup/export continuity. It carries the V2 source
        // id BOTH as its own id and as explicit v2SourceId linkage so the Cash
        // Book merge (dedupeLegacyMirrors) can always identify it as the same
        // movement as the journal-derived row.
        try { await db.createCashEntry({ id: result.source.id, v2SourceId: result.source.id, ...input, direction: 'in', type: 'capital_injection', investorId: id, notes: input.notes || 'Capital injection' }); } catch {}
        bumpDataVersion();
        return result;
      }
    }
    const r = await db.recordInvestorCapital(id, input);
    bumpDataVersion();
    return r;
  },
  drawInvestorFunds: async (id: string, input: { amount: number; date: string; notes?: string }) => {
    const settings = await db.getSettings();
    if (settings.accountingStyle !== 'retail_partnership') throw new Error('Investor ledgers are available only in Partnership Mode');
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext(input.date);
      if (context) {
        const result = await new V2InvestorLedgerService(runner).draw({ ...input, bookId: context.bookId, memberId: id });
        try { await db.createPayment({ id: result.source.id, ...input, type: 'drawing', partnerName: String(result.source.metadata?.memberName || id), investorId: id, method: 'cash' }); } catch {}
        bumpDataVersion();
        return result;
      }
    }
    const r = await db.recordInvestorDrawing(id, input);
    bumpDataVersion();
    return r;
  },

  // Dashboard & reports
  dashboard: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        // One-time migration for values entered before V2 was enabled. Never
        // duplicate or overwrite an existing authoritative opening source.
        const opening = await runner.first<{ id: string }>("SELECT id FROM v2_sources WHERE book_id=? AND type='opening_balance' LIMIT 1", [ctx.bookId]);
        if (!opening) {
          const settings = await db.getSettings();
          const cash = Number(settings.openingCash || 0);
          const inventory = Number(settings.openingInventory || 0);
          if (cash > 0 || inventory > 0) await service.postOpeningBalances({ cash, inventory, memo: 'Opening balances (migrated)' });
        }
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
          assets: { cash: d.cash, inventory: d.inventoryValue, accountsReceivable: d.accountsReceivable, other: d.otherAssets, total: d.assets },
          liabilities: { suppliersPayable: d.accountsPayable, commissionPayable: d.commissionPayable, other: d.otherLiabilities, total: d.liabilities },
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
    // Include model name so it carries over to other devices
    data.geminiModel = await getGeminiModel();
    // [Vault C2] Export-time divergence warning: when a V2 ledger is active,
    // compare legacy collection counts to their V2 source counterparts. A
    // mismatch means the legacy mirror drifted from the authoritative ledger;
    // surface it so the user knows before sharing (export still proceeds).
    const warnings: string[] = await exportDivergenceWarnings();
    data.warnings = warnings;
    return data;
  },
  importBackup: async (payload: any) => {
    const result: any = await db.importBackup(payload);
    // Restore model name if present in backup
    if (payload.geminiModel && typeof payload.geminiModel === 'string') {
      await setGeminiModel(payload.geminiModel);
    }
    // Surface the atomic-import outcome (v2 restore status + warnings) to callers.
    return result;
  },
  listPeriods: () => db.listPeriods(),
  closePeriod: async (actualStock: number, notes = '', commissionPct = 0) => {
    const runner = activeSqlRunner();
    if (!runner) return db.closePeriod(actualStock, notes, commissionPct);
    const service = new V2AppService(runner);
    const closeBooks = createCloseBooksRouter(service, db.closePeriod);
    const settings = await db.getSettings();
    // The V2 carried inventory count is authoritative. The setting is only
    // a compatibility mirror and may still refer to the prior period.
    const overview = await service.inventoryOverview();
    const result = await closeBooks({ actualStock, openingInventory: Number(overview?.openingInventory ?? settings.openingInventory ?? 0), commissionPct, notes });
    if ((result as any)?.source === 'v2') {
      const next = await runner.first<{ start_date: string }>("SELECT start_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [(result as any).result.bookId]);
      await db.updateSettings({ currentPeriodStart: next?.start_date || settings.currentPeriodStart, openingInventory: actualStock });
    }
    bumpDataVersion();
    return result;
  },
  // Clears books and ledgers only; device preferences and AI credentials remain.
  clearAccountingData: async () => {
    const runner = activeSqlRunner();
    const today = new Date().toISOString().slice(0, 10);
    const originalBookId = beActiveBookId();
    const originalV2Active = runner ? await runner.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'") : null;
    try {
      if (runner) {
        await resetAllV2AccountingData(runner, today);
      }
      const books = await beListBooks();
      for (const book of books) {
        await beSetActiveBook(book.id);
        await db.resetAll();
      }
      bumpDataVersion();
      return { ok: true };
    } finally {
      await beSetActiveBook(originalBookId);
      if (runner) {
        if (originalV2Active?.value) await runner.run("INSERT INTO meta(key,value) VALUES('v2_active_book_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [originalV2Active.value]);
        else await runner.run("DELETE FROM meta WHERE key='v2_active_book_id'");
      }
    }
  },

  resetAll: async () => api.clearAccountingData(),
  factoryReset: async () => {
    await api.clearAccountingData();
    // Wipe each book's business configuration (and its logo key). We iterate all
    // books first, THEN tear down the books index — so no book is missed.
    try {
      for (const book of await beListBooks()) {
        await beSetActiveBook(book.id);
        await db.factoryReset();
      }
    } finally {
      // Remove the books index + active-book pointer, reset the in-memory active
      // book to default, and clear the V2 meta keys (v2_active_book_id +
      // every v2_book_version:*). Preserves theme keys + AI-config clearing. [C4/M2]
      await beResetBooksAndActiveBook();
    }
    // Scorched earth for the authoritative V2 SQLite store: a FACTORY reset must
    // leave ZERO rows in EVERY v2_* table. clearAccountingData deliberately
    // preserves book identity rows (v2_books/v2_accounts/v2_personas/v2_members)
    // for the in-app "reset data" action — leaving them here made the next
    // onboarding bootstrap crash with "UNIQUE constraint failed: v2_books.id"
    // when it re-inserted the same deterministic active-book id. [reset]
    {
      const runner = activeSqlRunner();
      if (runner) await factoryResetV2Data(runner);
    }
    await Promise.all([
      storage.secureRemove(AI_API_KEY_KEY),
      AsyncStorage.multiRemove([
        AI_PROVIDER_KEY, AI_API_KEY_KEY, AI_MODEL_KEY, AI_BASE_URL_KEY, LEGACY_GEMINI_KEY, LEGACY_GEMINI_MODEL,
        // Device-level user prefs + UI customizations (theme, animations, tile
        // order/usage). The user wants EVERYTHING wiped on factory reset. [reset]
        ...FACTORY_RESET_PREF_KEYS,
      ]),
    ]);
    return { ok: true };
  },

  aiSnapshot: (from: string, to: string) => buildAiSnapshot(from, to),
  // AI
  parseCommand: async (text: string) => { const settings = await db.getSettings(); return ai.parseCommand(await getAIConfig(), text, settings.currency || 'USD'); },
  ocrReceipt: async (imageBase64: string, mimeType = 'image/jpeg') => { const settings = await db.getSettings(); return ai.ocrReceipt(await getAIConfig(), imageBase64, mimeType, settings.currency || 'USD'); },
  analyzeDocument: async (input: { base64?: string; mimeType?: string; text?: string }) => ai.analyzeDocumentAI(await getAIConfig(), input),
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
  getCustomer: async (id: string) => {
    const runner = activeSqlRunner(); if (runner) { const detail = await new V2AppService(runner).getPartyDetail(id, 'customer'); if (detail) return detail; }
    return (await db.listDebtors()).find((item: any) => item.id === id) || null;
  },
  createDebtor: (d: any) => db.createDebtor(d),
  updateDebtor: async (id: string, d: any) => {
    const runner = activeSqlRunner(); if (runner) { const service = new V2AppService(runner); if (await service.getPartyDetail(id, 'customer')) return service.updateParty(id, d); }
    return db.updateDebtor(id, d);
  },
  deleteDebtor: async (id: string) => {
    const runner = activeSqlRunner(); if (runner) { const service = new V2AppService(runner); if (await service.getPartyDetail(id, 'customer')) return service.archiveParty(id); }
    return db.deleteDebtor(id);
  },
  addDebtorPayment: (id: string, p: any) => db.addDebtorPayment(id, p),
  deleteDebtorPayment: (debtorId: string, paymentId: string) => db.deleteDebtorPayment(debtorId, paymentId),
  updateDebtorPayment: (debtorId: string, paymentId: string, u: any) => db.updateDebtorPayment(debtorId, paymentId, u),
  getDebtorStatement: async (id: string) => {
    const runner = activeSqlRunner(); if (runner) { const detail: any = await new V2AppService(runner).getPartyDetail(id, 'customer'); if (detail) return detail.statement; }
    return db.getDebtorStatement(id);
  },
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
  applyAdvanceToInvoice: async (debtorId: string, invoiceId: string, amount?: number) => { const r = await db.applyAdvanceToInvoice(debtorId, invoiceId, amount); bumpDataVersion(); return r; },

  // Quotes / Estimates (non-posting until converted)
  listQuotes: () => db.listQuotes(),
  createQuote: async (q: any) => { const r = await db.createQuote(q); bumpDataVersion(); return r; },
  updateQuote: async (id: string, q: any) => { const r = await db.updateQuote(id, q); bumpDataVersion(); return r; },
  deleteQuote: async (id: string) => { const r = await db.deleteQuote(id); bumpDataVersion(); return r; },
  setQuoteStatus: async (id: string, status: any) => { const r = await db.setQuoteStatus(id, status); bumpDataVersion(); return r; },
  convertQuoteToInvoice: async (id: string, opts?: any) => {
    // [Finding B] Route the invoice creation through the SAME V2 write path the
    // invoices screen uses so the converted invoice is visible to the V2 ledger
    // (dashboard, reports, party detail) — not stranded in the legacy collection.
    const r = await db.convertQuoteToInvoice(id, opts, (payload: any) => createTransaction('createInvoice', payload));
    bumpDataVersion();
    return r;
  },

  // Credit / Debit Notes (post-sale adjustments: discounts, returns, extra charges)
  listCreditNotes: (debtorId?: string) => db.listCreditNotes(debtorId),
  listDebitNotes: (debtorId?: string) => db.listDebitNotes(debtorId),
  createCreditNote: async (n: any) => createNote('createCreditNote', n),
  createDebitNote: async (n: any) => createNote('createDebitNote', n),
  deleteCreditNote: async (id: string) => { const r = await db.deleteCreditNote(id); bumpDataVersion(); return r; },
  deleteDebitNote: async (id: string) => { const r = await db.deleteDebitNote(id); bumpDataVersion(); return r; },

  // Delivery Notes / Challans (goods movement, no ledger posting)
  listDeliveryNotes: () => db.listDeliveryNotes(),
  createDeliveryNote: async (n: any) => { const r = await db.createDeliveryNote(n); bumpDataVersion(); return r; },
  updateDeliveryNote: async (id: string, n: any) => { const r = await db.updateDeliveryNote(id, n); bumpDataVersion(); return r; },
  deleteDeliveryNote: async (id: string) => { const r = await db.deleteDeliveryNote(id); bumpDataVersion(); return r; },

  // Enhanced reports
  taxReport: (from: string, to: string) => db.taxReport(from, to),
  salesRegister: (from: string, to: string) => db.salesRegister(from, to),
  receiptsRegister: (from: string, to: string) => db.receiptsRegister(from, to),
};
