import AsyncStorage from '@react-native-async-storage/async-storage';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/gemini';

const GEMINI_KEY_STORAGE = 'gemini_api_key';
const GEMINI_MODEL_STORAGE = 'gemini_model';

export async function getGeminiKey(): Promise<string> {
  const local = await AsyncStorage.getItem(GEMINI_KEY_STORAGE);
  if (local) return local;
  const s = await db.getSettings();
  return s.googleApiKey || '';
}
export async function setGeminiKey(v: string) {
  await AsyncStorage.setItem(GEMINI_KEY_STORAGE, v);
}

export async function getGeminiModel(): Promise<string> {
  const local = await AsyncStorage.getItem(GEMINI_MODEL_STORAGE);
  if (local) return local;
  return 'gemini-2.0-flash-001';
}
export async function setGeminiModel(v: string) {
  await AsyncStorage.setItem(GEMINI_MODEL_STORAGE, v);
}

// ---------- reconcile helper (matching logic in JS) ----------
async function reconcileStatement(imageBase64: string, supplierId: string, mimeType = 'image/jpeg') {
  const key = await getGeminiKey();
  const model = await getGeminiModel();
  const extracted = await ai.reconcileStatementAI(key, model, imageBase64, mimeType);

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
  testKey: async () => ai.testKey(await getGeminiKey(), await getGeminiModel()),

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
  parseCommand: async (text: string) => ai.parseCommand(await getGeminiKey(), await getGeminiModel(), text),
  ocrReceipt: async (imageBase64: string, mimeType = 'image/jpeg') => ai.ocrReceipt(await getGeminiKey(), await getGeminiModel(), imageBase64, mimeType),
  transcribe: async (audioBase64: string, mimeType = 'audio/m4a') => ai.transcribe(await getGeminiKey(), await getGeminiModel(), audioBase64, mimeType),
  reconcileStatement: (imageBase64: string, supplierId: string, mimeType = 'image/jpeg') => reconcileStatement(imageBase64, supplierId, mimeType),
};
