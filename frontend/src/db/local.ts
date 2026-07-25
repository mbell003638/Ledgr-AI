import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Ledgr local database (single-user, on-device).
 * Each collection is stored as a JSON array under a key.
 */

const KEYS = {
  suppliers: 'ledgr:suppliers',
  bills: 'ledgr:bills',
  sales: 'ledgr:sales',
  payments: 'ledgr:payments',
  inventoryChecks: 'ledgr:inventoryChecks',
  periods: 'ledgr:periods',
  settings: 'ledgr:settings',
} as const;

export type Collection = keyof typeof KEYS;

// ---------- write serialization (prevents lost-update races) ----------
// All mutating create/update/delete ops chain onto this promise so that
// two rapid actions can't interleave read-modify-write and drop an entry.
let writeChain: Promise<any> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // keep the chain alive even if a op rejects
  writeChain = run.catch(() => {});
  return run;
}

async function readColl<T = any>(c: Collection): Promise<T[]> {
  const raw = await AsyncStorage.getItem(KEYS[c]);
  if (!raw) return [];
  try { return JSON.parse(raw) as T[]; } catch { return []; }
}
async function writeColl<T = any>(c: Collection, arr: T[]) {
  await AsyncStorage.setItem(KEYS[c], JSON.stringify(arr));
}
async function readSettings(): Promise<any> {
  const raw = await AsyncStorage.getItem(KEYS.settings);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
async function writeSettings(s: any) {
  await AsyncStorage.setItem(KEYS.settings, JSON.stringify(s));
}

const uuid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();

// ---------- currency (USD-only) ----------
function toUsd(amount: number) {
  return Number(amount) || 0;
}

// ---------- Settings ----------
export async function getSettings() {
  const s = await readSettings();
  return {
    googleApiKey: s.googleApiKey ?? '',
    managerCommissionPct: s.managerCommissionPct ?? 0.0,
    currentPeriodStart: s.currentPeriodStart ?? '1970-01-01',
    openingInventory: s.openingInventory ?? 0.0,
    openingCash: s.openingCash ?? 0.0,
    openingCapital: s.openingCapital ?? 0.0,
    partnerNames: Array.isArray(s.partnerNames) && s.partnerNames.length ? s.partnerNames : ['Amit', 'Rahim'],
    extraAssets: Array.isArray(s.extraAssets) ? s.extraAssets : [],
    extraLiabilities: Array.isArray(s.extraLiabilities) ? s.extraLiabilities : [],
  };
}
export async function updateSettings(partial: Record<string, any>) {
  const s = await readSettings();
  const next = { ...s, ...partial };
  await writeSettings(next);
  return next;
}

// ---------- Suppliers ----------
export async function listSuppliers() {
  const [suppliers, bills, payments, s] = await Promise.all([
    readColl<any>('suppliers'), readColl<any>('bills'), readColl<any>('payments'), getSettings(),
  ]);
  return suppliers.map((sup: any) => {
    const billTotal = bills
      .filter((b: any) => b.supplierId === sup.id)
      .reduce((sum: number, b: any) => sum + toUsd(b.amount), 0);
    const payTotal = payments
      .filter((p: any) => p.type === 'supplier_payment' && p.supplierId === sup.id)
      .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);
    return {
      ...sup,
      billsTotal: +billTotal.toFixed(2),
      paymentsTotal: +payTotal.toFixed(2),
      balance: +(billTotal - payTotal).toFixed(2),
    };
  });
}
export async function createSupplier(body: any) {
  return serialize(async () => {
    const arr = await readColl<any>('suppliers');
    const item = { id: uuid(), name: body.name, phone: body.phone || '', notes: body.notes || '', created_at: nowIso() };
    arr.push(item);
    await writeColl('suppliers', arr);
    return item;
  });
}
export async function updateSupplier(id: string, body: any) {
  return serialize(async () => {
    const arr = await readColl<any>('suppliers');
    const i = arr.findIndex((x: any) => x.id === id);
    if (i < 0) throw new Error('Supplier not found');
    arr[i] = { ...arr[i], ...body };
    await writeColl('suppliers', arr);
    return arr[i];
  });
}
export async function deleteSupplier(id: string) {
  return serialize(async () => {
    const arr = (await readColl<any>('suppliers')).filter((x: any) => x.id !== id);
    await writeColl('suppliers', arr);
    return { ok: true };
  });
}
export async function getSupplier(id: string) {
  const list = await listSuppliers();
  const s = list.find((x: any) => x.id === id);
  if (!s) throw new Error('Supplier not found');
  const bills = (await readColl<any>('bills')).filter((b: any) => b.supplierId === id).sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
  const payments = (await readColl<any>('payments')).filter((p: any) => p.supplierId === id && p.type === 'supplier_payment').sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
  return { ...s, bills, payments };
}

// ---------- Generic CRUD helpers ----------
function makeCrud(coll: Collection) {
  return {
    list: async () => {
      const arr = await readColl<any>(coll);
      return arr.sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
    },
    create: async (body: any) => serialize(async () => {
      const arr = await readColl<any>(coll);
      const item = { id: uuid(), ...body, created_at: nowIso() };
      arr.push(item);
      await writeColl(coll, arr);
      return item;
    }),
    update: async (id: string, body: any) => serialize(async () => {
      const arr = await readColl<any>(coll);
      const i = arr.findIndex((x: any) => x.id === id);
      if (i < 0) throw new Error('Not found');
      arr[i] = { ...arr[i], ...body };
      await writeColl(coll, arr);
      return arr[i];
    }),
    remove: async (id: string) => serialize(async () => {
      const arr = (await readColl<any>(coll)).filter((x: any) => x.id !== id);
      await writeColl(coll, arr);
      return { ok: true };
    }),
  };
}
const billsCrud = makeCrud('bills');
const salesCrud = makeCrud('sales');
const paymentsCrud = makeCrud('payments');

export const listBills = billsCrud.list;
export const createBill = billsCrud.create;
export const updateBill = billsCrud.update;
export const deleteBill = billsCrud.remove;

export const listSales = salesCrud.list;
export const createSale = salesCrud.create;
export const updateSale = salesCrud.update;
export const deleteSale = salesCrud.remove;

export const listPayments = paymentsCrud.list;
export const createPayment = paymentsCrud.create;
export const updatePayment = paymentsCrud.update;
export const deletePayment = paymentsCrud.remove;

// ---------- Inventory ----------
export async function listInventory() {
  const arr = await readColl<any>('inventoryChecks');
  return arr.sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
}
export async function expectedInventory() {
  const s = await getSettings();
  const all = await readColl<any>('inventoryChecks');
  const last = all.sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0))[0];
  const since = last ? last.date : '0000-01-01';
  const base = last ? last.actualStock : (s.openingInventory || 0);
  const bills = (await readColl<any>('bills')).filter((b: any) => b.date > since);
  const sales = (await readColl<any>('sales')).filter((x: any) => x.date > since);
  const purchasesSince = bills.reduce((sum: number, b: any) => sum + toUsd(b.amount), 0);
  const salesSince = sales.reduce((sum: number, x: any) => sum + toUsd(x.amount), 0);
  const expected = +(base + purchasesSince - salesSince).toFixed(2);
  return { expected, lastAudit: last, purchasesSince: +purchasesSince.toFixed(2), salesSince: +salesSince.toFixed(2) };
}
export async function createInventory(body: any) {
  return serialize(async () => {
    const arr = await readColl<any>('inventoryChecks');
    const variance = +((body.actualStock - body.expectedStock).toFixed(2));
    const item = { id: uuid(), ...body, variance, created_at: nowIso() };
    arr.push(item);
    await writeColl('inventoryChecks', arr);
    return item;
  });
}
export async function deleteInventory(id: string) {
  return serialize(async () => {
    const arr = (await readColl<any>('inventoryChecks')).filter((x: any) => x.id !== id);
    await writeColl('inventoryChecks', arr);
    return { ok: true };
  });
}

// ---------- Dashboard ----------
export async function dashboard() {
  const s = await getSettings();
  const periodStart = s.currentPeriodStart || '1970-01-01';
  const openingInv = Number(s.openingInventory || 0);
  const openingCash = Number(s.openingCash || 0);
  const pct = Number(s.managerCommissionPct || 0);

  const bills = (await readColl<any>('bills')).filter((b: any) => (b.date || '') >= periodStart);
  const sales = (await readColl<any>('sales')).filter((x: any) => (x.date || '') >= periodStart);
  const payments = (await readColl<any>('payments')).filter((p: any) => (p.date || '') >= periodStart);
  const invHistory = (await readColl<any>('inventoryChecks')).filter((i: any) => (i.date || '') >= periodStart).sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
  const suppliersCount = (await readColl<any>('suppliers')).length;

  const totalPurchases = bills.reduce((sum: number, b: any) => sum + toUsd(b.amount), 0);
  const totalSales = sales.reduce((sum: number, x: any) => sum + toUsd(x.amount), 0);
  const supplierPayments = payments.filter((p: any) => p.type === 'supplier_payment')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);
  const drawings = payments.filter((p: any) => p.type === 'drawing')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);

  const grossProfit = +(totalSales - totalPurchases).toFixed(2);
  const commission = grossProfit > 0 ? +(grossProfit * pct / 100).toFixed(2) : 0;
  const netProfit = +(grossProfit - commission - drawings).toFixed(2);

  const liabilities = +(totalPurchases - supplierPayments + commission).toFixed(2);
  const inventoryValue = invHistory[0] ? Number(invHistory[0].actualStock) : openingInv;
  const cash = +(openingCash + totalSales - supplierPayments - drawings).toFixed(2);

  // custom (dynamic) assets & liabilities from settings
  const extraAssets = Array.isArray(s.extraAssets) ? s.extraAssets : [];
  const extraLiabilities = Array.isArray(s.extraLiabilities) ? s.extraLiabilities : [];
  const extraAssetsTotal = +extraAssets.reduce((sum: number, a: any) => sum + (Number(a.amount) || 0), 0).toFixed(2);
  const extraLiabTotal = +extraLiabilities.reduce((sum: number, l: any) => sum + (Number(l.amount) || 0), 0).toFixed(2);

  const assets = +(cash + inventoryValue + extraAssetsTotal).toFixed(2);
  const totalLiabilities = +(liabilities + extraLiabTotal).toFixed(2);
  const openingBalance = +(openingCash + openingInv).toFixed(2);
  const closingBalance = +assets.toFixed(2);
  const netWorth = +(assets - totalLiabilities).toFixed(2);

  const trend: Record<string, number> = {};
  for (const x of sales) {
    const d = (x.date || '').slice(0, 10);
    trend[d] = (trend[d] || 0) + toUsd(x.amount);
  }
  const salesTrend = Object.entries(trend).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-7)
    .map(([date, value]) => ({ date, value: +value.toFixed(2) }));

  return {
    assets, liabilities, netWorth, cash, inventoryValue,
    openingBalance, openingInventory: openingInv, openingCash, closingBalance,
    totalPurchases: +totalPurchases.toFixed(2), totalSales: +totalSales.toFixed(2),
    grossProfit, managerCommissionPct: pct, commission, netProfit,
    drawings: +drawings.toFixed(2), supplierPayments: +supplierPayments.toFixed(2),
    suppliers: suppliersCount, periodStart, salesTrend,
    extraAssets, extraLiabilities, extraAssetsTotal, extraLiabTotal, totalLiabilities,
    openingCapital: Number(s.openingCapital || 0),
  };
}

// ---------- Reports ----------
export async function pnl() {
  const d = await dashboard();
  return {
    revenue: d.totalSales, cogs: d.totalPurchases, grossProfit: d.grossProfit,
    managerCommissionPct: d.managerCommissionPct, commission: d.commission,
    drawings: d.drawings, netProfit: d.netProfit,
  };
}
export async function balanceSheet() {
  const d = await dashboard();
  return {
    assets: {
      cash: d.cash,
      inventory: d.inventoryValue,
      extra: d.extraAssets,
      total: d.assets,
    },
    liabilities: {
      suppliersPayable: d.liabilities,
      extra: d.extraLiabilities,
      total: d.totalLiabilities,
    },
    equity: d.netWorth,
  };
}
export async function trialBalance() {
  const d = await dashboard();
  return {
    debits: [
      { account: 'Cash', amount: d.cash },
      { account: 'Inventory', amount: d.inventoryValue },
      { account: 'Purchases', amount: d.totalPurchases },
      { account: 'Drawings', amount: d.drawings },
    ],
    credits: [
      { account: 'Sales Revenue', amount: d.totalSales },
      { account: 'Suppliers Payable', amount: d.liabilities },
    ],
  };
}

// Partner Capital Statement: combined opening capital + net profit - per-partner drawings
export async function capitalStatement() {
  const s = await getSettings();
  const d = await dashboard();
  const periodStart = d.periodStart;
  const payments = (await readColl<any>('payments')).filter((p: any) => (p.date || '') >= periodStart);
  const drawingPayments = payments.filter((p: any) => p.type === 'drawing');

  const partnerNames: string[] = Array.isArray(s.partnerNames) && s.partnerNames.length ? s.partnerNames : ['Amit', 'Rahim'];
  // per-partner drawings (match on partnerName, case-insensitive; unmatched -> 'Other')
  const perPartner: Record<string, number> = {};
  for (const name of partnerNames) perPartner[name] = 0;
  let otherDrawings = 0;
  for (const p of drawingPayments) {
    const amt = toUsd(p.amount);
    const pn = (p.partnerName || '').trim();
    const matched = partnerNames.find((n) => n.toLowerCase() === pn.toLowerCase());
    if (matched) perPartner[matched] += amt;
    else otherDrawings += amt;
  }

  const openingCapital = Number(s.openingCapital || 0);
  const netProfit = d.netProfit;
  const totalDrawings = d.drawings;
  const closingCapital = +(openingCapital + netProfit - totalDrawings).toFixed(2);

  return {
    openingCapital: +openingCapital.toFixed(2),
    netProfit,
    totalDrawings,
    closingCapital,
    partners: partnerNames.map((name) => ({ name, drawings: +(perPartner[name] || 0).toFixed(2) })),
    otherDrawings: +otherDrawings.toFixed(2),
  };
}

// Drawings history with partner attribution (most recent first)
export async function drawingsHistory() {
  const all = await readColl<any>('payments');
  const draws = all.filter((p: any) => p.type === 'drawing')
    .sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
  return draws.map((p: any) => ({
    id: p.id,
    date: p.date,
    amount: +toUsd(p.amount).toFixed(2),
    partnerName: p.partnerName || 'Unknown',
    notes: p.notes || '',
  }));
}

// Monthly profit trend for the last N months (chart data)
export async function monthlyProfitTrend(months = 6) {
  const now = new Date();
  const result: { month: string; label: string; profit: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const ms = await monthlySummary(month);
    result.push({ month, label: dt.toLocaleString('en', { month: 'short' }), profit: ms.netProfit });
  }
  return result;
}

// Asset distribution for pie chart
export async function assetDistribution() {
  const d = await dashboard();
  const slices = [
    { label: 'Cash', value: Math.max(0, d.cash) },
    { label: 'Inventory', value: Math.max(0, d.inventoryValue) },
  ];
  for (const a of d.extraAssets || []) {
    const v = Number(a.amount) || 0;
    if (v > 0) slices.push({ label: a.name || 'Other', value: v });
  }
  return slices.filter((s) => s.value > 0);
}

export async function monthlySummary(month: string) {
  const s = await getSettings();
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const inRange = (d: string) => d >= start && d < next;

  const bills = (await readColl<any>('bills')).filter((b: any) => inRange(b.date));
  const sales = (await readColl<any>('sales')).filter((x: any) => inRange(x.date));
  const payments = (await readColl<any>('payments')).filter((p: any) => inRange(p.date));
  const suppliers = await readColl<any>('suppliers');
  const supMap: Record<string, string> = Object.fromEntries(suppliers.map((x: any) => [x.id, x.name]));

  const revenue = sales.reduce((sum: number, x: any) => sum + toUsd(x.amount), 0);
  const purchases = bills.reduce((sum: number, b: any) => sum + toUsd(b.amount), 0);
  const supplierPayments = payments.filter((p: any) => p.type === 'supplier_payment')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);
  const drawings = payments.filter((p: any) => p.type === 'drawing')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);
  const grossProfit = +(revenue - purchases).toFixed(2);
  const pct = Number(s.managerCommissionPct || 0);
  const commission = grossProfit > 0 ? +(grossProfit * pct / 100).toFixed(2) : 0;
  const netProfit = +(grossProfit - commission - drawings).toFixed(2);
  const cashFlow = +(revenue - supplierPayments - drawings - commission).toFixed(2);

  const supTotals: Record<string, number> = {};
  for (const b of bills) supTotals[b.supplierId] = (supTotals[b.supplierId] || 0) + toUsd(b.amount);
  const topSuppliers = Object.entries(supTotals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, amount]) => ({ supplierId: id, name: supMap[id] || 'Unknown', amount: +amount.toFixed(2) }));

  const daily: Record<string, number> = {};
  for (const x of sales) {
    const d = (x.date || '').slice(0, 10);
    daily[d] = (daily[d] || 0) + toUsd(x.amount);
  }
  return {
    month, revenue: +revenue.toFixed(2), purchases: +purchases.toFixed(2),
    grossProfit, managerCommissionPct: pct, commission, supplierPayments: +supplierPayments.toFixed(2),
    drawings: +drawings.toFixed(2), netProfit, cashFlow,
    billsCount: bills.length, salesCount: sales.length, paymentsCount: payments.length,
    topSuppliers,
    dailySales: Object.entries(daily).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value: +value.toFixed(2) })),
  };
}

export async function dailySummary(date: string) {
  const s = await getSettings();
  const on = (d: string) => (d || '').slice(0, 10) === date;
  const bills = (await readColl<any>('bills')).filter((b: any) => on(b.date));
  const sales = (await readColl<any>('sales')).filter((x: any) => on(x.date));
  const payments = (await readColl<any>('payments')).filter((p: any) => on(p.date));
  const suppliers = await readColl<any>('suppliers');
  const supMap: Record<string, string> = Object.fromEntries(suppliers.map((x: any) => [x.id, x.name]));
  const revenue = sales.reduce((s: number, x: any) => s + toUsd(x.amount), 0);
  const purchases = bills.reduce((s: number, b: any) => s + toUsd(b.amount), 0);
  const sp = payments.filter((p: any) => p.type === 'supplier_payment').reduce((s: number, p: any) => s + toUsd(p.amount), 0);
  const dr = payments.filter((p: any) => p.type === 'drawing').reduce((s: number, p: any) => s + toUsd(p.amount), 0);
  return {
    date, revenue: +revenue.toFixed(2), purchases: +purchases.toFixed(2),
    grossProfit: +(revenue - purchases).toFixed(2), supplierPayments: +sp.toFixed(2), drawings: +dr.toFixed(2),
    netCash: +(revenue - sp - dr).toFixed(2),
    billsCount: bills.length, salesCount: sales.length, paymentsCount: payments.length,
    suppliers: bills.map((b: any) => ({ name: supMap[b.supplierId] || 'Unknown', amount: toUsd(b.amount) })),
  };
}

// ---------- Periods (close & carry) ----------
export async function listPeriods() {
  return (await readColl<any>('periods')).sort((a: any, b: any) => (a.closed_at && b.closed_at ? (a.closed_at > b.closed_at ? -1 : a.closed_at < b.closed_at ? 1 : 0) : 0));
}
export async function closePeriod(actualStock: number, notes = '') {
  const d = await dashboard();
  const now = new Date();
  const nowDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const period = {
    id: uuid(), startDate: d.periodStart, endDate: nowDate,
    openingInventory: d.openingInventory, openingCash: d.openingCash,
    totalSales: d.totalSales, totalPurchases: d.totalPurchases,
    grossProfit: d.grossProfit, managerCommissionPct: d.managerCommissionPct,
    commission: d.commission, drawings: d.drawings, supplierPayments: d.supplierPayments,
    netProfit: d.netProfit, closingInventory: actualStock, closingCash: d.cash,
    notes, closed_at: nowIso(),
  };
  const periods = await readColl<any>('periods');
  periods.push(period);
  await writeColl('periods', periods);

  const inv = { id: uuid(), date: nowDate, expectedStock: d.inventoryValue, actualStock, variance: +(actualStock - d.inventoryValue).toFixed(2), notes: `Period close: ${d.periodStart} → ${nowDate}`, created_at: nowIso() };
  const invs = await readColl<any>('inventoryChecks');
  invs.push(inv);
  await writeColl('inventoryChecks', invs);

  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const nextStart = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  await updateSettings({ currentPeriodStart: nextStart, openingInventory: actualStock, openingCash: d.cash });
  return period;
}

// ---------- Backup / Restore / Reset ----------
export async function exportBackup() {
  const [suppliers, bills, sales, payments, inventoryChecks, periods, settings] = await Promise.all([
    readColl('suppliers'), readColl('bills'), readColl('sales'), readColl('payments'), readColl('inventoryChecks'), readColl('periods'), readSettings(),
  ]);
  return {
    suppliers, bills, sales, payments, inventoryChecks, periods, settings,
    _meta: { app: 'ledgr', version: 2, exportedAt: nowIso() },
  };
}
export async function importBackup(data: any) {
  const setColl = async (name: string, val: any) => { if (Array.isArray(val)) await AsyncStorage.setItem(`ledgr:${name}`, JSON.stringify(val)); };
  await setColl('suppliers', data.suppliers);
  await setColl('bills', data.bills);
  await setColl('sales', data.sales);
  await setColl('payments', data.payments);
  await setColl('inventoryChecks', data.inventoryChecks);
  await setColl('periods', data.periods);
  if (data.settings && typeof data.settings === 'object') {
    await writeSettings({ ...(await readSettings()), ...data.settings });
  }
  return { ok: true, mode: 'replace' };
}
export async function resetAll() {
  const s = await readSettings();
  const keep = { googleApiKey: s.googleApiKey || '' };
  await Promise.all([
    AsyncStorage.removeItem(KEYS.suppliers),
    AsyncStorage.removeItem(KEYS.bills),
    AsyncStorage.removeItem(KEYS.sales),
    AsyncStorage.removeItem(KEYS.payments),
    AsyncStorage.removeItem(KEYS.inventoryChecks),
    AsyncStorage.removeItem(KEYS.periods),
  ]);
  await writeSettings({ ...keep, managerCommissionPct: 0, currentPeriodStart: '1970-01-01', openingInventory: 0, openingCash: 0 });
  return { ok: true };
}
