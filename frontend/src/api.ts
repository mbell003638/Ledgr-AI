import AsyncStorage from '@react-native-async-storage/async-storage';
import { storage } from '@/src/utils/storage';
import { bumpDataVersion } from '@/src/utils/dataVersion';
import { localTodayIso } from '@/src/utils/dateValidation';
import { round2 } from '@/src/money';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig } from '@/src/db/ai';
import { V2AppService, createAppWriteRouter, createAppMutationRouter, createCloseBooksRouter, type V2ClosingBalancesImportInput, type V2ScanPartyRequest, type V2ScanTransactionImportInput } from '@/src/accountingV2/appService';
import { initializeV2Book, accountingBookVersion } from '@/src/accountingV2/appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from '@/src/accountingV2/bookConfigRepository';
import type { PersonaId } from '@/src/accountingV2/config';
import { getV2Dashboard } from '@/src/accountingV2/v2Dashboard';
import { partnershipProfitFromReports, postedCommissionFromReports } from './accountingV2/reports';
import { buildPersistentV2Reports } from '@/src/accountingV2/persistentReports';
import { resetAllV2AccountingData, factoryResetV2Data } from '@/src/accountingV2/resetBook';
import { V2InvestorLedgerService, type InvestorLedgerDetail } from '@/src/accountingV2/investorLedgerService';
import { v2Services } from '@/src/accountingV2/runtime';
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
  const [provider, secureKey, storedKey, model, baseUrl] = await Promise.all([
    AsyncStorage.getItem(AI_PROVIDER_KEY),
    storage.secureGet(AI_API_KEY_KEY, ''),
    AsyncStorage.getItem(AI_API_KEY_KEY),
    AsyncStorage.getItem(AI_MODEL_KEY),
    AsyncStorage.getItem(AI_BASE_URL_KEY),
  ]);
  const resolvedKey = secureKey || storedKey || '';
  if (resolvedKey && !secureKey) {
    await Promise.all([
      storage.secureSet(AI_API_KEY_KEY, resolvedKey),
      AsyncStorage.removeItem(AI_API_KEY_KEY),
    ]);
  }
  return {
    provider: ai.normalizeProviderId(provider),
    apiKey: resolvedKey,
    model: model ?? ai.DEFAULT_GEMINI_MODEL,
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
  if (cfg.baseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.baseUrl)));
  const [secureOk] = await Promise.all([
    secureKeyWrite ?? Promise.resolve(true),
    ...ops,
  ]);
  if (secureKeyWrite && secureOk === false) {
    throw new Error('Could not securely save your API key on this device. Please try again.');
  }
}
// Convenience aliases used by the current voice and bill screens.
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

  let ourBills: any[] = [], ourPayments: any[] = [];
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
  if (!partyId) throw new Error('Choose a customer or supplier before reconciling');
  const detail: any = await service.getPartyDetail(partyId, party);
  if (!detail) throw new Error(`${party === 'customer' ? 'Customer' : 'Supplier'} was not found in the active V2 book`);
  if (party === 'customer') {
    ourBills = (detail.statement?.ledger || []).filter((item: any) => item.kind === 'invoice').map((item: any) => ({ amount: item.debit, date: item.date, reference: item.ref }));
    ourPayments = (detail.payments || []).map((item: any) => ({ amount: item.amount, date: item.date }));
  } else {
    ourBills = detail.bills || [];
    ourPayments = detail.payments || [];
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
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const context = await service.activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  const [dashboard, reports, parties, salesAndInvoices, expenseSources, entrySources, inventoryCounts, members, quotes, deliveryNotes] = await Promise.all([
    getV2Dashboard(runner, context.bookId),
    buildPersistentV2Reports(runner, { bookId: context.bookId, from, to }),
    service.listParties(),
    service.listSalesAndInvoices(),
    runner.all<any>("SELECT date,metadata FROM v2_sources WHERE book_id=? AND type='expense' AND date>=? AND date<=? ORDER BY date DESC", [context.bookId, from, to]),
    runner.all<any>(
      `SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name
       FROM v2_sources s
       LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId')
       WHERE s.book_id=?
       ORDER BY s.date DESC,s.id DESC
       LIMIT 300`,
      [context.bookId],
    ),
    runner.all<any>("SELECT id,date,value FROM v2_inventory_counts WHERE book_id=? AND period_id=? ORDER BY date DESC,id DESC", [context.bookId, context.periodId]),
    runner.all<any>("SELECT id,name FROM v2_members WHERE book_id=? ORDER BY name", [context.bookId]),
    db.listQuotes().catch(() => []),
    db.listDeliveryNotes().catch(() => []),
  ]);
  const expensesByCategory: Record<string, number> = {};
  for (const row of expenseSources) {
    let meta: any = {}; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
    if (!meta.reversed && !meta.deleted) expensesByCategory.General = (expensesByCategory.General || 0) + Number(meta.total || 0);
  }
  const recentEntries: any[] = entrySources.flatMap((row: any) => {
    let meta: any = {};
    try { meta = JSON.parse(row.metadata || '{}'); } catch { return []; }
    if (meta.reversed || meta.deleted) return [];
    const entity = row.type === 'cash_purchase' || row.type === 'credit_purchase' ? 'bill'
      : row.type === 'cash_sale' ? 'sale'
      : row.type === 'capital_injection' ? 'capital'
      : row.type === 'credit_note' || row.type === 'debit_note' ? 'note'
      : row.type === 'manual_cash_income' || row.type === 'manual_cash_expense' ? 'cash_entry'
      : row.type;
    return [{
      id: row.id,
      entity,
      sourceType: row.type,
      date: row.date,
      reference: row.reference || '',
      amount: Number(meta.total ?? meta.amount ?? meta.value ?? 0),
      partyId: meta.partyId || '',
      memberId: meta.memberId || '',
      partyName: row.party_name || meta.clientName || meta.supplierName || meta.partnerName || meta.memberName || '',
      category: meta.category || '',
      paymentType: meta.paymentType || '',
      method: meta.method || '',
      notes: meta.notes || '',
      lines: Array.isArray(meta.lines) ? meta.lines.slice(0, 20) : undefined,
    }];
  });
  recentEntries.push(
    ...inventoryCounts.map((row: any) => ({ id: row.id, entity: 'inventory_count', sourceType: 'inventory_count', date: row.date, amount: Number(row.value) })),
    ...quotes.slice(0, 100).map((row: any) => ({ id: row.id, entity: 'quote', sourceType: 'quote', date: row.date, reference: row.quoteNumber || '', amount: Number(row.total || 0), partyName: row.clientName || '', status: row.status, notes: row.notes || '', lines: Array.isArray(row.lines) ? row.lines.slice(0, 20) : [] })),
    ...deliveryNotes.slice(0, 100).map((row: any) => ({ id: row.id, entity: 'delivery_note', sourceType: 'delivery_note', date: row.date, reference: row.noteNumber || '', partyName: row.clientName || '', status: row.status, notes: row.notes || '', items: Array.isArray(row.items) ? row.items.slice(0, 20) : [] })),
  );
  recentEntries.sort((a: any, b: any) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.id).localeCompare(String(a.id)));
  const visibleEntries = recentEntries.slice(0, 300);
  return {
    source: 'v2', currency: settings.currency, businessName: settings.businessName,
    snapshot: { cash: dashboard.cash, inventoryValue: dashboard.inventoryValue, netWorth: dashboard.netWorth, totalSales: dashboard.totalSales, totalPurchases: dashboard.totalPurchases, grossProfit: dashboard.grossProfit, netProfit: dashboard.netProfit },
    yearToDate: reports.profitAndLoss,
    creditors: parties.filter((p: any) => p.roles.includes('supplier') && p.payable !== 0).sort((a: any, b: any) => b.payable - a.payable).slice(0, 20).map((p: any) => ({ name: p.name, owed: p.payable })),
    debtors: parties.filter((p: any) => p.roles.includes('customer') && p.receivable !== 0).sort((a: any, b: any) => b.receivable - a.receivable).slice(0, 20).map((p: any) => ({ name: p.name, owes: p.receivable })),
    expensesByCategory,
    openInvoices: salesAndInvoices.filter((item: any) => item.type === 'invoice' && item.status !== 'paid').slice(0, 50).map((item: any) => ({ id: item.id, number: item.reference || item.id, client: item.clientName, amount: item.openAmount ?? item.amount })),
    parties: parties.map((party: any) => ({ id: party.id, name: party.name, roles: party.roles, receivable: party.receivable, payable: party.payable })),
    capitalAccounts: members.map((member: any) => ({ id: member.id, name: member.name })),
    recentEntries: visibleEntries,
    snapshotLimit: 300,
    snapshotTruncated: recentEntries.length > visibleEntries.length,
  };
}

/** Settings store preferences only. Accounting state and configuration live in V2. */
async function preferenceSettings() {
  const settings = await db.getSettings();
  const runner = activeSqlRunner();
  if (!runner) return settings;
  const service = new V2AppService(runner);
  const context = await service.activeContext();
  if (!context) return settings;
  const config = await new V2BookConfigRepository(runner).getBookConfig(context.bookId);
  return {
    ...settings,
    accountingStyle: config.style,
    accountingBasis: config.basis,
    selectedPersonas: config.selectedPersonas,
    activePersona: config.activePersona,
    managerCommissionPct: config.retailPartnership?.commissionPct ?? settings.managerCommissionPct ?? 0,
  };
}
type AppCreateName = 'createSale'|'createInvoice'|'createReceipt'|'createBill'|'createPayment'|'createExpense';
async function createTransaction(name: AppCreateName, payload: any) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const writes = createAppWriteRouter(service);

  const injected = { ...payload };
  const partyId = name === 'createBill' || name === 'createPayment'
    ? injected.supplierId
    : name === 'createInvoice' || name === 'createReceipt'
      ? (injected.partyId || injected.debtorId)
      : null;
  if (partyId && !injected.supplierName && !injected.clientName) {
    const party = (await service.listParties()).find((item: any) => item.id === partyId);
    if (party) {
      if (name === 'createBill' || name === 'createPayment') injected.supplierName = party.name;
      else injected.clientName = party.name;
    }
  }

  const result = await writes[name](injected);
  bumpDataVersion();
  return result;
}

type AppMutationName = 'updateReceipt'|'deleteReceipt'|'markInvoicePaid'|'updateInvoice'|'deleteInvoice'|'updateExpense'|'deleteExpense'|'updatePayment'|'deletePayment'|'updateSale'|'deleteSale'|'updateBill'|'deleteBill'|'updateNote'|'deleteNote';
async function mutateTransaction(name: AppMutationName, ...args: any[]) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const r = await (createAppMutationRouter(new V2AppService(runner)) as any)[name](...args);
  bumpDataVersion();
  return r;
}

/**
 * [Finding A] Create a credit/debit note. The customer screen sends {customerId}
 * and the supplier screen sends {supplierId}. We map those fields to a canonical
 * shape and route the note through the V2 write
 * path so it hits the journal + party balance and is visible on party detail /
 * statements. Active V2 books have one write path and no compatibility mirror.
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
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const v2 = new V2AppService(runner);
  const v2Res = await (name === 'createCreditNote' ? v2.createCreditNote(mapped) : v2.createDebitNote(mapped));
  bumpDataVersion();
  const total = Number(v2Res.source?.metadata?.total ?? mapped.amount);
  return { ...v2Res, id: v2Res.source?.id, noteNumber: v2Res.source?.reference || v2Res.source?.id, amount: total };
}

/**
 * The ONE computation of an investor's live ledger detail: the V2
 * journal-derived detail. Both the investor detail screen (api.getInvestorLedger) and the
 * Parties list tile (api.listInvestors) MUST read the balance from here so the
 * two surfaces can never disagree after a deposit/draw.
 */
async function mergedInvestorLedgerDetail(id: string): Promise<InvestorLedgerDetail> {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const app = new V2AppService(runner);
  const context = await app.activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  return new V2InvestorLedgerService(runner).detail(context.bookId, id);
}

/** Read source documents from the authoritative ledger in screen-friendly form. */
async function v2SourceDocuments(types: string[]) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const context = await service.activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  const placeholders = types.map(() => '?').join(',');
  const rows = await runner.all<any>(
    `SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name
     FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId')
     WHERE s.book_id=? AND s.type IN (${placeholders}) ORDER BY s.date DESC,s.id DESC`,
    [context.bookId, ...types],
  );
  return rows.flatMap((row: any) => {
    let metadata: any = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; }
    if (metadata.deleted || metadata.reversed) return [];
    return [{
      ...metadata,
      id: row.id,
      type: row.type,
      date: row.date,
      reference: row.reference || '',
      amount: Number(metadata.total || 0),
      total: Number(metadata.total || 0),
      tax: Number(metadata.tax || 0),
      taxRate: Number(metadata.taxRate || 0),
      subtotal: Number(metadata.subtotal ?? (metadata.total ? Number(metadata.total) - Number(metadata.tax || 0) : 0)),
      partyId: metadata.partyId || null,
      partyName: row.party_name || '',
      clientName: row.party_name || '',
      supplierName: row.party_name || '',
      metadata,
    }];
  });
}

async function v2Report(from?: string, to?: string) {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const context = await new V2AppService(runner).activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  return buildPersistentV2Reports(runner, { bookId: context.bookId, from, to });
}

export const api = {
  // Persistent V2 runtime services are available after storage initialization.
  v2: () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return v2Services();
  },
  initializeV2Book: async (options: Parameters<typeof initializeV2Book>[1]) => {
    const runner = activeSqlRunner();
    if (!runner) {
      return { bookId: options.book.id, periodId: options.period.id || `${options.book.id}:period`, version: 1 };
    }
    const result = await initializeV2Book(runner, options);
    await preferenceSettings();
    return result;
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
  getV2OpeningBalances: async () => {
    const runner = activeSqlRunner();
    if (!runner) return null;
    return new V2AppService(runner).getOpeningBalances();
  },
  getV2ActivePeriod: async () => {
    const runner = activeSqlRunner();
    if (!runner) return null;
    return new V2AppService(runner).getActivePeriod();
  },
  postV2OpeningBalances: async (input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).postOpeningBalances(input);
    bumpDataVersion();
    return r;
  },
  updateV2OpeningBalances: async (input: { date?: string; cash: number; inventory: number; otherAssets?: number; assetBreakdown?: { name: string; amount: number }[]; accountsPayable?: number; otherLiabilities?: number; liabilityBreakdown?: { name: string; amount: number; type: "creditor" | "other" }[]; ownerCapital?: number; retainedEarnings?: number; memo?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).updateOpeningBalances(input);
    bumpDataVersion();
    return r;
  },
  importV2ClosingBalances: async (input: V2ClosingBalancesImportInput) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).importClosingBalances(input);
    bumpDataVersion();
    return r;
  },
  preflightV2ScanParties: async (requests: V2ScanPartyRequest[]) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).preflightScanParties(requests);
  },
  importV2ScanTransaction: async (input: V2ScanTransactionImportInput) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const r = await new V2AppService(runner).importScanTransaction(input);
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
  updateManualBalanceTransaction: async (sourceId: string, input: any) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Manual balance transactions require SQLite storage');
    const r = await new V2AppService(runner).updateManualBalanceTransaction(sourceId, input);
    bumpDataVersion();
    return r;
  },
  getSettings: () => preferenceSettings(),
  updateSettings: async (s: any) => {
    const runner = activeSqlRunner();
    if (runner && s.managerCommissionPct !== undefined) {
      const service = new V2AppService(runner);
      const context = await service.activeContext();
      if (context) {
        const repo = new V2BookConfigRepository(runner);
        const config = await repo.getBookConfig(context.bookId);
        await repo.updateBookConfig(context.bookId, {
          style: config.style,
          basis: config.basis,
          selectedPersonas: config.selectedPersonas,
          activePersona: config.activePersona,
          retailPartnership: {
            ...config.retailPartnership,
            commissionPct: Number(s.managerCommissionPct || 0),
          },
        });
      }
    }
    const r = await db.updateSettings(s);
    const preferences = await preferenceSettings();
    bumpDataVersion();
    return { ...r, ...preferences };
  },
  testKey: async () => ai.testKey(await getAIConfig()),

  // Books (separate isolated accounts, e.g. Shop vs Technician)
  listBooks: (): Promise<BookMeta[]> => beListBooks(),
  activeBookId: (): string => beActiveBookId(),
  setActiveBook: async (id: string) => { const r = await beSetActiveBook(id); bumpDataVersion(); return r; },
  createBook: async (name: string, businessType?: string) => { const r = await beCreateBook(name, businessType); bumpDataVersion(); return r; },
  renameBook: async (id: string, name: string) => { const r = await beRenameBook(id, name); bumpDataVersion(); return r; },
  deleteBook: async (id: string) => { const r = await beDeleteBook(id); bumpDataVersion(); return r; },

  createParty: async (p: any) => {
    const name = (p.name || '').trim();
    if (!name) throw new Error('Business account name is required');
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const ctx = await service.activeContext();
    if (!ctx) throw new Error('No active versioned V2 book with an open accounting period');
    const roles: string[] = p.roles || (p.type === 'customer' ? ['customer'] : ['supplier']);
    const primaryRole = roles.includes('supplier') && !roles.includes('customer') ? 'supplier' : 'customer';
    const party = await service.ensureParty(name, primaryRole, { phone: p.phone, email: p.email });
    for (const r of roles) {
      if (r !== primaryRole && (r === 'customer' || r === 'supplier')) {
        await service.ensureParty(name, r, { phone: p.phone, email: p.email });
      }
    }
    const finalRoles = Array.isArray(party.roles) ? party.roles : JSON.parse(party.roles || '[]');
    return { id: party.id, name: party.name, phone: party.phone || p.phone, email: party.email || p.email, roles: finalRoles };
  },

  findOrCreateParty: async (rawName: string, role: 'customer' | 'supplier' = 'customer', details?: { phone?: string; email?: string }) => {
    const name = (rawName || '').trim();
    if (!name) return null;
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const context = await service.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    await service.assertPartyNameAvailable(name, context.bookId);
    const existing = (await service.listParties()).find((party: any) => norm(party.name) === norm(name));
    const party = existing || await service.ensureParty(name, role, details);
    const roles: string[] = Array.isArray(party.roles) ? party.roles : JSON.parse(party.roles || '[]');
    if (!roles.includes(role)) await service.ensureParty(name, role, details);
    return { id: party.id, name: party.name, role: roles.length > 1 ? 'both' : role };
  },

  searchParties: async (query: string) => {
    const q = (query || '').trim().toLowerCase();
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
    const parties = await service.listParties();
    return parties
      .filter((party: any) => !q || party.name.toLowerCase().includes(q))
      .map((party: any) => ({ id: party.id, name: party.name, phone: party.phone || '', role: party.roles.length > 1 ? 'both' : party.roles[0] }));
  },

  listParties: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
    return service.listParties();
  },
  listInvestors: async (): Promise<{ id: string; name: string; openingCapital: number; currentCapital: number; profitSharePct: number }[]> => {
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
    return [];
  },
  listSalesAndInvoices: async () => {
    const runner=activeSqlRunner(); if(!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listSalesAndInvoices();
  },
  // Suppliers
  listSuppliers: async () => (await api.listParties()).filter((party: any) => party.roles.includes('supplier')).map((party: any) => ({ ...party, balance: party.payable })),
  createSupplier: (s: any) => api.createParty({ ...s, roles: ['supplier'] }),
  updateSupplier: async (id: string, s: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'supplier')) throw new Error('Supplier not found');
    return service.updateParty(id, s);
  },
  getSupplier: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const detail: any = await new V2AppService(runner).getPartyDetail(id, 'supplier');
    if (!detail) throw new Error('Supplier not found');
    return detail;
  },
  deleteSupplier: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'supplier')) throw new Error('Supplier not found');
    return service.archiveParty(id);
  },
  listBills: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    return new V2AppService(runner).listBills() as Promise<any[]>;
  },
  createBill: (b: any) => createTransaction('createBill', b),
  updateBill: (id: string, b: any) => mutateTransaction('updateBill', id, b),
  deleteBill: (id: string) => mutateTransaction('deleteBill', id),

  listSales: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    return service.listSalesAndInvoices();
  },
  createSale: (s: any) => createTransaction('createSale', s),
  updateSale: (id: string, s: any) => mutateTransaction('updateSale', id, s),
  deleteSale: (id: string) => mutateTransaction('deleteSale', id),

  listPayments: async () => (await v2SourceDocuments(['supplier_payment','drawing','commission_payment'])).map((row: any) => ({ ...row, supplierId: row.partyId, partnerName: row.partnerName || row.memberName })),
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
          id: entry.sourceType === 'manual_cash_income' || entry.sourceType === 'manual_cash_expense' ? entry.sourceId : entry.id,
          notes: entry.sourceType === 'capital_injection' && entry.sourceNotes && !String(entry.notes || '').includes(entry.sourceNotes)
            ? `${entry.notes} — ${entry.sourceNotes}`
            : entry.notes,
          origin: 'v2',
          editable: entry.sourceType === 'manual_cash_income' || entry.sourceType === 'manual_cash_expense',
        }));
        return v2Entries;
      }
    }
    return [];
  },
  createCashEntry: async (e: any) => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      if (await service.activeContext(e.date)) {
        const result = await service.recordManualCash(e);
        bumpDataVersion();
        return result;
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  updateCashEntry: async (id: string, e: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const result = await new V2AppService(runner).updateManualCash(id, e); bumpDataVersion(); return result;
  },
  deleteCashEntry: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const result = await new V2AppService(runner).deleteManualCash(id); bumpDataVersion(); return result;
  },

  getInvestorLedger: async (id: string): Promise<InvestorLedgerDetail> => {
    const runner = activeSqlRunner();
    if (runner && await new V2AppService(runner).activeContext()) return mergedInvestorLedgerDetail(id);
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  depositInvestorCapital: async (id: string, input: { amount: number; date: string; notes?: string }) => {
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext(input.date);
      if (context) {
        const result = await new V2InvestorLedgerService(runner).deposit({ ...input, bookId: context.bookId, memberId: id });
        bumpDataVersion();
        return result;
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  updateInvestorCapital: async (id: string, sourceId: string, input: { amount: number; date: string; notes?: string }) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Editing posted capital requires SQLite storage');
    const app = new V2AppService(runner);
    const context = await app.activeContext(input.date);
    if (!context) throw new Error('Posting date is outside the open accounting period');
    const result = await new V2InvestorLedgerService(runner).updateDeposit(sourceId, { ...input, bookId: context.bookId, memberId: id });
    bumpDataVersion();
    return result;
  },
  deleteInvestorCapital: async (id: string, sourceId: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('Reversing posted capital requires SQLite storage');
    const app = new V2AppService(runner);
    const context = await app.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const result = await new V2InvestorLedgerService(runner).deleteDeposit(sourceId, context.bookId, id);
    bumpDataVersion();
    return result;
  },
  drawInvestorFunds: async (id: string, input: { amount: number; date: string; method?: 'cash' | 'bank' | 'card' | 'mobile' | 'upi'; notes?: string }) => {
    const runner = activeSqlRunner();
    if (runner) {
      const app = new V2AppService(runner); const context = await app.activeContext(input.date);
      if (context) {
        const result = await new V2InvestorLedgerService(runner).draw({ ...input, bookId: context.bookId, memberId: id });
        bumpDataVersion();
        return result;
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
  },

  // Dashboard & reports
  dashboard: async () => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const ctx = await new V2AppService(runner).activeContext();
    if (!ctx) throw new Error('No active versioned V2 book with an open accounting period');
    return getV2Dashboard(runner, ctx.bookId);
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
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  balanceSheet: async () => {
    const runner = activeSqlRunner();
    if (runner) {
      const service = new V2AppService(runner);
      const ctx = await service.activeContext();
      if (ctx) {
        const d = await getV2Dashboard(runner, ctx.bookId);
        return {
          assets: { cash: d.cash, inventory: d.inventoryValue, accountsReceivable: d.accountsReceivable, supplierAdvances: d.supplierAdvances, other: d.otherAssets, total: d.assets },
          liabilities: { suppliersPayable: d.accountsPayable, customerAdvances: d.customerAdvances, commissionPayable: d.commissionPayable, other: d.otherLiabilities, total: d.liabilities },
          equity: d.netWorth,
        };
      }
    }
    throw new Error('No active versioned V2 book with an open accounting period');
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
    throw new Error('No active versioned V2 book with an open accounting period');
  },
  capitalStatement: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); const context = await service.activeContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const period = await service.getActivePeriod();
    const report = await v2Report(period?.startDate, period?.endDate);
    const members = await api.listInvestors();
    const investors = await Promise.all(members.map(async (member: any) => {
      const detail = await mergedInvestorLedgerDetail(member.id);
      const profitShare = Math.round(report.profitAndLoss.netProfit * Number(member.profitSharePct || 0)) / 100;
      return { id: member.id, name: member.name, contributed: detail.openingCapital + detail.totalInjected, drawings: detail.totalDrawings, profitShare, balance: detail.currentCapitalBalance, profitSharePct: member.profitSharePct };
    }));
    return { netProfit: report.profitAndLoss.netProfit, investors };
  },
  drawingsHistory: async () => (await v2SourceDocuments(['drawing'])).map((row: any) => ({ ...row, investorId: row.memberId })),
  monthlyProfitTrend: async (months = 6) => {
    const out: any[] = []; const now = new Date();
    for (let offset = months - 1; offset >= 0; offset--) {
      const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const from = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
      const to = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
      const report = await v2Report(from, to);
      out.push({ month: from.slice(0, 7), revenue: report.profitAndLoss.revenue, purchases: report.profitAndLoss.cogs, grossProfit: report.profitAndLoss.grossProfit, netProfit: report.profitAndLoss.netProfit });
    }
    return out;
  },
  assetDistribution: async () => {
    const d = await api.dashboard();
    return [
      { label: 'Cash', value: d.cash }, { label: 'Inventory', value: d.inventoryValue },
      { label: 'Receivables', value: d.accountsReceivable }, { label: 'Other Assets', value: d.otherAssets },
    ].filter((item) => Number(item.value) !== 0);
  },
  monthlySummary: async (m: string) => {
    const [year, month] = m.split('-').map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    const from = `${m}-01`;
    const to = `${m}-${String(lastDay).padStart(2, '0')}`;
    const report = await v2Report(from, to);
    const pnl = report.profitAndLoss;
    const config = await api.getV2BookConfig();
    const isCash = config?.basis === 'cash';
    const operatingExpenses = isCash ? pnl.expenses : round2(pnl.grossProfit - pnl.netProfit);
    const settings: any = await api.getSettings().catch(() => ({}));
    const commissionPct = Number(config?.retailPartnership?.commissionPct ?? settings?.managerCommissionPct ?? 0);
    const profit = partnershipProfitFromReports(pnl, commissionPct, postedCommissionFromReports(report));
    return {
      month: m,
      periodStart: from,
      revenue: pnl.revenue,
      purchases: pnl.cogs,
      cogs: pnl.cogs,
      grossProfit: pnl.grossProfit,
      expenses: operatingExpenses,
      totalExpenses: pnl.expenses,
      commission: profit.commission,
      managerCommissionPct: commissionPct,
      netProfit: profit.netProfit,
    };
  },
  dailySummary: async (d: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('No active versioned V2 book with an open accounting period');
    const service = new V2AppService(runner);
    const ctx = await service.activeContext();
    if (!ctx) throw new Error('No active versioned V2 book with an open accounting period');
    const report = await buildPersistentV2Reports(runner, { bookId: ctx.bookId, from: d, to: d });
    const salesAndInvoices = await service.listSalesAndInvoices();
    const bills = await service.listBills();
    const payments = await api.listPayments();
    const cashMovements = await service.listCashMovements();
    const daySales = salesAndInvoices.filter((x: any) => (x.date || '').slice(0, 10) === d);
    const dayBills = bills.filter((x: any) => (x.date || '').slice(0, 10) === d);
    const dayPayments = payments.filter((x: any) => (x.date || '').slice(0, 10) === d);
    const dayMovements = cashMovements.filter((m: any) => (m.date || '').slice(0, 10) === d);
    const netCash = round2(dayMovements.reduce((sum: number, m: any) => sum + (m.direction === 'in' ? Number(m.amount || 0) : -Number(m.amount || 0)), 0));
    const expenses = round2(report.profitAndLoss.grossProfit - report.profitAndLoss.netProfit);
    return {
      date: d,
      revenue: report.profitAndLoss.revenue,
      purchases: report.profitAndLoss.cogs,
      grossProfit: report.profitAndLoss.grossProfit,
      expenses,
      netProfit: report.profitAndLoss.netProfit,
      netCash,
      salesCount: daySales.length,
      billsCount: dayBills.length,
      paymentsCount: dayPayments.length,
    };
  },

  // Backup + danger
  exportBackup: async () => {
    const data: any = await db.exportBackup();
    // Include model name so it carries over to other devices
    data.geminiModel = await getGeminiModel();
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
  listPeriods: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const context = await new V2AppService(runner).activeContext(); if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const rows = await runner.all<any>('SELECT p.id,p.start_date,p.end_date,c.closed_at,c.snapshot FROM v2_periods p JOIN v2_close_books c ON c.period_id=p.id WHERE p.book_id=? ORDER BY p.end_date DESC', [context.bookId]);
    return rows.map((row: any) => { const snapshot = JSON.parse(row.snapshot || '{}'); return { id: row.id, startDate: row.start_date, endDate: row.end_date, closedAt: row.closed_at, ...snapshot, closingCash: Number(snapshot.cash || 0) + Number(snapshot.bank || 0), closingInventory: Number(snapshot.inventory || 0) }; });
  },
  closePeriod: async (actualStock: number, notes = '', commissionPct = 0, date?: string) => {
    const runner = activeSqlRunner();
    if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const closeBooks = createCloseBooksRouter(service);
    const overview = await service.inventoryOverview();
    const result = await closeBooks({ actualStock, openingInventory: Number(overview?.openingInventory || 0), commissionPct, notes, date });
    bumpDataVersion();
    return result;
  },
  // Clears books and ledgers only; device preferences and AI credentials remain.
  clearAccountingData: async () => {
    const runner = activeSqlRunner();
    const today = localTodayIso();
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
      if (originalBookId && (await beListBooks()).some((book) => book.id === originalBookId)) {
        await beSetActiveBook(originalBookId);
      }
      if (runner && originalV2Active?.value) {
        await runner.run("INSERT OR REPLACE INTO meta(key, value) VALUES('v2_active_book_id', ?)", [originalV2Active.value]);
      }
      return { success: true };
    } catch (e: any) {
      if (originalBookId) await beSetActiveBook(originalBookId);
      if (runner && originalV2Active?.value) {
        await runner.run("INSERT OR REPLACE INTO meta(key, value) VALUES('v2_active_book_id', ?)", [originalV2Active.value]);
      }
      throw e;
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
        AI_PROVIDER_KEY, AI_API_KEY_KEY, AI_MODEL_KEY, AI_BASE_URL_KEY,
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
  listExpenses: async () => (await v2SourceDocuments(['expense'])).map((row: any) => ({ ...row, category: row.category || 'Expense' })),
  createExpense: (e: any) => createTransaction('createExpense', e),
  updateExpense: (id: string, e: any) => mutateTransaction('updateExpense', id, e),
  deleteExpense: (id: string) => mutateTransaction('deleteExpense', id),

  // Debtors
  listDebtors: async () => (await api.listParties()).filter((party: any) => party.roles.includes('customer')).map((party: any) => ({ ...party, balance: party.receivable })),
  getCustomer: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const detail: any = await new V2AppService(runner).getPartyDetail(id, 'customer');
    if (!detail) throw new Error('Customer not found');
    return detail;
  },
  createDebtor: (d: any) => api.createParty({ ...d, roles: ['customer'] }),
  updateDebtor: async (id: string, d: any) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'customer')) throw new Error('Customer not found');
    return service.updateParty(id, d);
  },
  deleteDebtor: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner); if (!await service.getPartyDetail(id, 'customer')) throw new Error('Customer not found');
    return service.archiveParty(id);
  },
  getDebtorStatement: async (id: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const detail: any = await new V2AppService(runner).getPartyDetail(id, 'customer');
    if (!detail) throw new Error('Customer not found');
    return detail.statement;
  },
  // Date-range reports
  pnlRange: async (from: string, to: string) => {
    const report = await v2Report(from, to);
    const config = await api.getV2BookConfig();
    const settings: any = await api.getSettings().catch(() => ({}));
    const commissionPct = Number(config?.retailPartnership?.commissionPct ?? settings?.managerCommissionPct ?? 0);
    const pnl = partnershipProfitFromReports(report.profitAndLoss, commissionPct, postedCommissionFromReports(report));
    const expenses = round2(report.profitAndLoss.grossProfit - report.profitAndLoss.netProfit);
    return {
      revenue: report.profitAndLoss.revenue,
      purchases: report.profitAndLoss.cogs,
      cogs: report.profitAndLoss.cogs,
      grossProfit: report.profitAndLoss.grossProfit,
      expenses,
      managerCommissionPct: commissionPct,
      commission: pnl.commission,
      netProfit: pnl.netProfit,
    };
  },
  creditorsReport: async (_from?: string, _to?: string) => (await api.listSuppliers()).map((party: any) => ({ id: party.id, name: party.name, balance: party.payable || party.balance || 0 })),
  debtorsReport: async (_from?: string, _to?: string) => (await api.listDebtors()).map((party: any) => ({ id: party.id, name: party.name, balance: party.receivable || party.balance || 0 })),

  // Invoices
  listInvoices: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const service = new V2AppService(runner);
    const statuses = new Map((await service.listSalesAndInvoices()).filter((row: any) => row.type === 'invoice').map((row: any) => [row.id, row]));
    return (await v2SourceDocuments(['invoice'])).map((row: any) => {
      const live: any = statuses.get(row.id);
      return { ...row, invoiceNumber: row.reference || row.id, status: live?.status || row.status || 'unpaid', openAmount: live?.openAmount ?? row.total, lines: Array.isArray(row.lines) ? row.lines : [] };
    });
  },
  createInvoice: (inv: any) => createTransaction('createInvoice', inv),
  updateInvoice: (id: string, inv: any) => mutateTransaction('updateInvoice', id, inv),
  deleteInvoice: (id: string) => mutateTransaction('deleteInvoice', id),
  markInvoicePaid: (id: string, input?: any) => mutateTransaction('markInvoicePaid', id, input || {}),
  overdueInvoices: async () => (await api.listInvoices()).filter((invoice: any) => invoice.status !== 'paid' && invoice.dueDate && invoice.dueDate < localTodayIso()),

  // Receipts (money actually received)
  listReceipts: async () => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const receipts = await v2SourceDocuments(['receipt']);
    const ids = receipts.map((row: any) => row.id);
    const allocations = ids.length ? await runner.all<any>(`SELECT receipt_source_id,invoice_source_id,amount FROM v2_invoice_allocations WHERE receipt_source_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    return receipts.map((row: any) => ({ ...row, receiptNumber: row.reference || row.id, debtorId: row.partyId, mode: row.mode || (Number(row.advance) > 0 ? 'advance' : 'against_invoice'), allocations: allocations.filter((item: any) => item.receipt_source_id === row.id).map((item: any) => ({ invoiceId: item.invoice_source_id, invoiceSourceId: item.invoice_source_id, amountApplied: Number(item.amount), amount: Number(item.amount) })) }));
  },
  createReceipt: (r: any) => createTransaction('createReceipt', r),
  updateReceipt: (id: string, input: any) => mutateTransaction('updateReceipt', id, input),
  deleteReceipt: (id: string) => mutateTransaction('deleteReceipt', id),
  invoicePaidAmount: async (invoiceId: string) => {
    const runner = activeSqlRunner(); if (!runner) throw new Error('V2 accounting requires SQLite storage');
    const row = await runner.first<{ total: number }>('SELECT COALESCE(SUM(amount),0) total FROM v2_invoice_allocations WHERE invoice_source_id=?', [invoiceId]);
    return Number(row?.total || 0);
  },

  // Quotes / Estimates (non-posting until converted)
  listQuotes: () => db.listQuotes(),
  createQuote: async (q: any) => { const r = await db.createQuote(q); bumpDataVersion(); return r; },
  updateQuote: async (id: string, q: any) => { const r = await db.updateQuote(id, q); bumpDataVersion(); return r; },
  deleteQuote: async (id: string) => { const r = await db.deleteQuote(id); bumpDataVersion(); return r; },
  setQuoteStatus: async (id: string, status: any) => { const r = await db.setQuoteStatus(id, status); bumpDataVersion(); return r; },
  convertQuoteToInvoice: async (id: string, opts?: any) => {
    // [Finding B] Route the invoice creation through the SAME V2 write path the
    // invoices screen uses so the converted invoice is visible to the V2 ledger
    // (dashboard, reports, party detail) — not stranded outside the ledger.
    const r = await db.convertQuoteToInvoice(id, opts, (payload: any) => createTransaction('createInvoice', payload));
    bumpDataVersion();
    return r;
  },

  // Credit / Debit Notes (post-sale adjustments: discounts, returns, extra charges)
  createCreditNote: async (n: any) => createNote('createCreditNote', n),
  createDebitNote: async (n: any) => createNote('createDebitNote', n),
  updateNote: async (id: string, n: any) => mutateTransaction('updateNote', id, n),
  deleteNote: async (id: string) => mutateTransaction('deleteNote', id),

  // Delivery Notes / Challans (goods movement, no ledger posting)
  listDeliveryNotes: () => db.listDeliveryNotes(),
  createDeliveryNote: async (n: any) => { const r = await db.createDeliveryNote(n); bumpDataVersion(); return r; },
  updateDeliveryNote: async (id: string, n: any) => { const r = await db.updateDeliveryNote(id, n); bumpDataVersion(); return r; },
  deleteDeliveryNote: async (id: string) => { const r = await db.deleteDeliveryNote(id); bumpDataVersion(); return r; },

  // Enhanced reports
  taxReport: async (from: string, to: string) => {
    const [settings, config, invoices, cashSales, receipts, bills, creditNotes, report] = await Promise.all([
      api.getSettings(), api.getV2BookConfig(), v2SourceDocuments(['invoice']), v2SourceDocuments(['cash_sale']), v2SourceDocuments(['receipt']), v2SourceDocuments(['cash_purchase','credit_purchase']), v2SourceDocuments(['credit_note']), v2Report(from, to).catch(() => null),
    ]);
    const inRange = (row: any) => row.date >= from && row.date <= to;
    const taxOf = (gross: number, rate: number) => rate > 0 ? Math.round((gross - gross / (1 + rate / 100)) * 100) / 100 : 0;
    const basis = config?.basis === 'cash' ? 'cash' : 'accrual';
    const rate = Number(settings.taxRate || 0);

    let outputBase = 0;
    let outputTax = 0;
    if (basis === 'accrual') {
      const salesRows = [...invoices, ...cashSales].filter(inRange);
      for (const row of salesRows) {
        const total = Number(row.total || row.amount || 0);
        const rowTax = Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
        const base = Number(row.subtotal ?? row.metadata?.subtotal ?? (total - rowTax));
        outputBase += base;
        outputTax += rowTax;
      }
    } else {
      const cashRows = [...cashSales, ...receipts].filter(inRange);
      for (const row of cashRows) {
        const total = Number(row.total || row.amount || 0);
        const rowTax = Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
        const base = Number(row.subtotal ?? row.metadata?.subtotal ?? (total - rowTax));
        outputBase += base;
        outputTax += rowTax;
      }
    }

    const cnRows = creditNotes.filter(inRange);
    const creditNoteTax = cnRows.reduce((sum: number, row: any) => {
      const total = Number(row.total || row.amount || 0);
      return sum + Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
    }, 0);
    const netOutputTax = Math.max(0, Math.round((outputTax - creditNoteTax) * 100) / 100);

    const inputRows = bills.filter(inRange);
    let inputBase = 0;
    let inputTax = 0;
    for (const row of inputRows) {
      const total = Number(row.amount || row.total || 0);
      const rowTax = Number(row.tax ?? row.metadata?.tax ?? (row.taxRate ? taxOf(total, Number(row.taxRate)) : 0));
      const base = Number(row.subtotal ?? row.metadata?.subtotal ?? (total - rowTax));
      inputBase += base;
      inputTax += rowTax;
    }
    inputBase = Math.round(inputBase * 100) / 100;
    inputTax = Math.round(inputTax * 100) / 100;
    outputBase = Math.round(outputBase * 100) / 100;
    outputTax = Math.round(outputTax * 100) / 100;

    const glTaxAccount = report?.trialBalance?.accounts?.find((a: any) => a.code === '2300');
    const glTaxPayable = glTaxAccount ? glTaxAccount.normalBalance : 0;
    const netTaxPayable = (basis === 'accrual' && glTaxAccount) ? glTaxPayable : Math.round((netOutputTax - inputTax) * 100) / 100;

    return { from, to, taxLabel: settings.taxLabel || 'Tax', taxRate: rate, basis, outputBase, outputTax, creditNoteTax, debitNoteTax: 0, netOutputTax, inputBase, inputTax, netTaxPayable, glTaxPayable };
  },
  salesRegister: async (from: string, to: string) => {
    const rows = (await v2SourceDocuments(['cash_sale','invoice'])).filter((row: any) => row.date >= from && row.date <= to).map((row: any) => ({ date: row.date, type: row.type === 'invoice' ? 'Invoice' : 'Cash Sale', ref: row.reference || '', party: row.partyName || '', amount: row.amount, status: row.status }));
    const cashTotal = rows.filter((row: any) => row.type === 'Cash Sale').reduce((sum: number, row: any) => sum + row.amount, 0);
    const invoiceTotal = rows.filter((row: any) => row.type === 'Invoice').reduce((sum: number, row: any) => sum + row.amount, 0);
    return { from, to, rows: rows.sort((a: any,b: any) => a.date.localeCompare(b.date)), total: cashTotal + invoiceTotal, cashTotal, invoiceTotal, count: rows.length };
  },
  receiptsRegister: async (from: string, to: string) => {
    const rows = (await api.listReceipts()).filter((row: any) => row.date >= from && row.date <= to).map((row: any) => ({ date: row.date, ref: row.receiptNumber, party: row.clientName || 'Walk-in', mode: row.mode, method: row.method || 'cash', amount: row.amount }));
    const byMethod: Record<string, number> = {}; const byMode: Record<string, number> = {};
    for (const row of rows) { byMethod[row.method] = (byMethod[row.method] || 0) + row.amount; byMode[row.mode] = (byMode[row.mode] || 0) + row.amount; }
    return { from, to, rows: rows.sort((a: any,b: any) => a.date.localeCompare(b.date)), byMethod, byMode, total: rows.reduce((sum: number, row: any) => sum + row.amount, 0), count: rows.length };
  },
};
