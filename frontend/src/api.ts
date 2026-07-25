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
async function reconcileStatement(imageBase64: string, supplierId: string, mimeType = 'image/jpeg') {
  const extracted = await ai.reconcileStatementAI(await getAIConfig(), imageBase64, mimeType);

  let ourBills: any[] = [], ourPayments: any[] = [];
  if (supplierId) {
    const all = await db.listBills();
    ourBills = all.filter((b: any) => b.supplierId === supplierId);
    const pays = await db.listPayments();
    ourPayments = pays.filter((p: any) => p.supplierId === supplierId && p.type === 'supplier_payment');
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
  return { extracted, matched, missingInLedgr: missing, notOnStatement: extra, supplierId };
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
  reconcileStatement: (imageBase64: string, supplierId: string, mimeType = 'image/jpeg') => reconcileStatement(imageBase64, supplierId, mimeType),
};
