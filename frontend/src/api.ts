import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const API = `${BASE}/api`;

const GEMINI_KEY_STORAGE = 'gemini_api_key';

export async function getGeminiKey(): Promise<string> {
  return (await AsyncStorage.getItem(GEMINI_KEY_STORAGE)) || '';
}
export async function setGeminiKey(v: string) {
  await AsyncStorage.setItem(GEMINI_KEY_STORAGE, v);
}

async function req<T = any>(path: string, method = 'GET', body?: any, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = await getGeminiKey();
  if (key) headers['x-gemini-api-key'] = key;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.detail) || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  // Settings
  getSettings: () => req('/settings'),
  updateSettings: (s: { googleApiKey?: string; fcRate?: number }) => req('/settings', 'PUT', s),
  testKey: () => req('/settings/test-key', 'POST'),

  // Suppliers
  listSuppliers: () => req('/suppliers'),
  createSupplier: (s: any) => req('/suppliers', 'POST', s),
  updateSupplier: (id: string, s: any) => req(`/suppliers/${id}`, 'PUT', s),
  getSupplier: (id: string) => req(`/suppliers/${id}`),
  deleteSupplier: (id: string) => req(`/suppliers/${id}`, 'DELETE'),

  // Bills
  listBills: () => req('/bills'),
  createBill: (b: any) => req('/bills', 'POST', b),
  updateBill: (id: string, b: any) => req(`/bills/${id}`, 'PUT', b),
  deleteBill: (id: string) => req(`/bills/${id}`, 'DELETE'),

  // Sales
  listSales: () => req('/sales'),
  createSale: (s: any) => req('/sales', 'POST', s),
  updateSale: (id: string, s: any) => req(`/sales/${id}`, 'PUT', s),
  deleteSale: (id: string) => req(`/sales/${id}`, 'DELETE'),

  // Payments
  listPayments: () => req('/payments'),
  createPayment: (p: any) => req('/payments', 'POST', p),
  updatePayment: (id: string, p: any) => req(`/payments/${id}`, 'PUT', p),
  deletePayment: (id: string) => req(`/payments/${id}`, 'DELETE'),

  // Inventory
  listInventory: () => req('/inventory'),
  expectedInventory: () => req('/inventory/expected'),
  createInventory: (i: any) => req('/inventory', 'POST', i),
  deleteInventory: (id: string) => req(`/inventory/${id}`, 'DELETE'),

  // Dashboard & reports
  dashboard: () => req('/dashboard'),
  pnl: () => req('/reports/pnl'),
  balanceSheet: () => req('/reports/balance-sheet'),
  trialBalance: () => req('/reports/trial-balance'),

  // Monthly summary
  monthlySummary: (month: string) => req(`/reports/monthly-summary?month=${month}`),
  dailySummary: (date: string) => req(`/reports/daily-summary?date=${date}`),

  // Backup
  exportBackup: () => req('/backup/export'),
  importBackup: (payload: any) => req('/backup/import', 'POST', payload),

  // Periods & danger
  listPeriods: () => req('/periods'),
  closePeriod: (actualStock: number, notes = '') => req('/periods/close', 'POST', { actualStock, notes }),
  resetAll: () => req('/reset?confirm=YES', 'POST'),

  // AI
  parseCommand: (text: string) => req('/ai/parse-command', 'POST', { text }),
  ocrReceipt: (imageBase64: string, mimeType = 'image/jpeg') =>
    req('/ai/ocr-receipt', 'POST', { imageBase64, mimeType }),
  transcribe: (audioBase64: string, mimeType = 'audio/m4a') =>
    req('/ai/transcribe', 'POST', { audioBase64, mimeType }),
  reconcileStatement: (imageBase64: string, supplierId: string, mimeType = 'image/jpeg') =>
    req('/ai/reconcile-statement', 'POST', { imageBase64, supplierId, mimeType }),
};
