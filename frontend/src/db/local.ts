import { computeCogs, grossProfit as calcGross, commission as calcCommission, netProfit as calcNet, computeCash } from '../accounting';
import { pctOf, subMoney, addMoney, round2 } from '../money';
import {
  readColl as backendReadColl,
  writeColl as backendWriteColl,
  readSettings as backendReadSettings,
  writeSettings as backendWriteSettings,
  clearColl as backendClearColl,
  readLogo as backendReadLogo,
  writeLogo as backendWriteLogo,
  clearLogo as backendClearLogo,
  storageMode as backendStorageMode,
  activeSqlRunner as backendActiveSqlRunner,
  activeBookIsDefault,
  snapshotKeys,
  restoreKeys,
  readBooksIndexRaw,
  writeBooksIndexRaw,
  readSecondaryBookPayload,
  writeSecondaryBookPayload,
} from './backend';
import { COLLECTIONS as SQL_COLLECTIONS } from './schema';
import {
  withImportTransaction,
  writeCollInTxn,
  writeSettingsInTxn,
} from './sqliteStore';
import { exportV2Data, importV2Data, hasV2Payload, type V2ImportResult } from './v2Backup';

/**
 * Ledgr local database (single-user, on-device).
 * Persistence is delegated to ./backend, which routes to SQLite when active
 * (see initStorage) or AsyncStorage otherwise. All report/accounting logic
 * below is storage-agnostic.
 */

export type Collection = (typeof SQL_COLLECTIONS)[number] | 'settings';

// ---------- write serialization (prevents lost-update races) ----------
// All mutating create/update/delete ops chain onto this promise so that
// two rapid actions can't interleave read-modify-write and drop an entry.
let writeChain: Promise<any> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // keep the chain alive even if a op rejects
  writeChain = run.catch(() => { });
  return run;
}

// Storage primitives delegate to the active backend (SQLite or AsyncStorage).
async function readColl<T = any>(c: Collection): Promise<T[]> {
  return backendReadColl<T>(c as any);
}
async function writeColl<T = any>(c: Collection, arr: T[]) {
  await backendWriteColl(c as any, arr);
}
async function readSettings(): Promise<any> {
  return backendReadSettings();
}
async function writeSettings(s: any) {
  await backendWriteSettings(s);
}

const uuid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const nowIso = () => new Date().toISOString();

// ---------- currency / tax helpers ----------
export { CURRENCIES, TAX_LABELS, type TaxLabel, getCurrencySymbol } from '../utils/currency';

function toUsd(amount: number) {
  return Number(amount) || 0;
}

// ---------- Settings ----------
// Detects a base64/inline image data-URI selected by the current logo picker.
function isDataUri(v: any): v is string {
  return typeof v === 'string' && v.startsWith('data:');
}

/** Resolve the business logo from its dedicated per-book storage key. */
async function resolveLogo(): Promise<string> {
  try { return await backendReadLogo(); } catch { return ''; }
}

export async function getSettings(): Promise<Record<string, any>> {
  const s = await readSettings();
  const logo = await resolveLogo();
  return {
    // Security: hashed device-lock preference for destructive actions.
    lockEnabled: s.lockEnabled ?? false,
    currency: s.currency ?? 'USD',
    taxLabel: s.taxLabel ?? 'None',
    taxLabelCustom: s.taxLabelCustom ?? '',
    taxRate: s.taxRate ?? 0,
    businessName: s.businessName ?? '',
    businessAddress: s.businessAddress ?? '',
    businessPhone: s.businessPhone ?? '',
    businessEmail: s.businessEmail ?? '',
    taxRegNo: s.taxRegNo ?? '',
    bankAccount: s.bankAccount ?? '',
    upiId: s.upiId ?? '',
    paymentDetails: s.paymentDetails ?? '',
    // Logo is stored in a dedicated key (not the settings blob) but is still
    // surfaced here as `logo` so every consumer (invoices/PDF/receipts) is
    // unchanged. `hasLogo` is the lightweight marker kept in the settings doc.
    logo,
    hasLogo: !!logo,
    hasOnboarded: s.hasOnboarded ?? false,
    businessType: s.businessType ?? '',
    invoiceTheme: s.invoiceTheme ?? 'navy_gold',
    invoiceTerms: s.invoiceTerms ?? '',
    themeMode: s.themeMode ?? 'system',
    enabledFeatures: Array.isArray(s.enabledFeatures) ? s.enabledFeatures : null,
  };
}

const ACCOUNTING_SETTING_KEYS = new Set([
  'managerCommissionPct', 'currentPeriodStart', 'openingInventory', 'openingCash',
  'openingCapital', 'investors', 'partnerNames', 'extraAssets', 'extraLiabilities',
  'accountingStyle', 'accountingBasis', 'selectedPersonas', 'activePersona',
]);

export async function updateSettings(partial: Record<string, any>) {
  const s = await readSettings();
  const preferences = Object.fromEntries(Object.entries(partial).filter(([key]) => !ACCOUNTING_SETTING_KEYS.has(key)));
  const next: Record<string, any> = { ...s, ...preferences };
  // Route the logo to its dedicated key; never persist the data-URI in the
  // settings blob (would risk the CursorWindow overflow this fix prevents). [H4]
  if ('logo' in preferences) {
    const logoVal = preferences.logo;
    await backendWriteLogo(isDataUri(logoVal) ? logoVal : '');
    delete next.logo;
    next.hasLogo = isDataUri(logoVal);
  }
  await writeSettings(next);
  return next;
}

// ---------- Suppliers ----------
export async function listSuppliers() {
  const [suppliers, bills, payments] = await Promise.all([
    readColl<any>('suppliers'), readColl<any>('bills'), readColl<any>('payments'),
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
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const name = (body.name || '').trim();
    if (!name) throw new Error('Supplier name is required');
    const arr = await readColl<any>('suppliers');
    const debtors = await readColl<any>('debtors');
    if ([...arr, ...debtors].some((x: any) => norm(x.name) === norm(name))) {
      throw new Error(`A party or supplier named '${name}' already exists in this account.`);
    }
    const item = { id: uuid(), name, phone: body.phone || '', notes: body.notes || '', created_at: nowIso() };
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
    const arr = await readColl<any>('suppliers');
    const supplier = arr.find((x: any) => x.id === id);
    if (!supplier) throw new Error('Supplier not found');

    const bills = await readColl<any>('bills');
    const payments = await readColl<any>('payments');
    
    if (bills.some((x: any) => x.supplierId === id)) {
      throw new Error(`Cannot delete ${supplier.name} because they have existing bills.`);
    }
    if (payments.some((x: any) => x.supplierId === id && x.type === 'supplier_payment')) {
      throw new Error(`Cannot delete ${supplier.name} because they have existing payments.`);
    }

    await writeColl('suppliers', arr.filter((x: any) => x.id !== id));
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
// Collections whose records carry a monetary `amount` that must be validated.
const AMOUNT_COLLECTIONS = new Set<Collection>(['bills', 'sales', 'payments', 'expenses']);

function assertValidEntry(coll: Collection, body: any) {
  if (!AMOUNT_COLLECTIONS.has(coll)) return;
  if (body == null || !('amount' in body)) return;
  const amt = Number(body.amount);
  if (!Number.isFinite(amt)) {
    throw new Error('Amount must be a valid number.');
  }
  if (amt < 0) {
    throw new Error('Amount cannot be negative.');
  }
}

function makeCrud(coll: Collection) {
  return {
    list: async () => {
      const arr = await readColl<any>(coll);
      return arr.sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
    },
    create: async (body: any) => serialize(async () => {
      assertValidEntry(coll, body);
      const arr = await readColl<any>(coll);
      const item = { id: uuid(), ...body, created_at: nowIso() };
      arr.push(item);
      await writeColl(coll, arr);
      return item;
    }),
    update: async (id: string, body: any) => serialize(async () => {
      assertValidEntry(coll, body);
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

export async function listSales() {
  const sales = await readColl<any>('sales');
  const invoices = await readColl<any>('invoices');
  const invoiceSales = invoices.map((inv: any) => ({
    id: inv.id,
    date: inv.date,
    amount: Number(inv.total || inv.amount || 0),
    currency: inv.currency || 'USD',
    notes: inv.notes || `Credit Sale (${inv.clientName || 'Debtor'})`,
    type: 'invoice',
    clientName: inv.clientName,
    status: inv.status,
  }));
  const combined = [...sales, ...invoiceSales];
  return combined.sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
}
export const createSale = salesCrud.create;

export async function updateSale(id: string, payload: any) {
  const salesArr = await readColl<any>('sales');
  if (salesArr.some((s: any) => s.id === id)) {
    return salesCrud.update(id, payload);
  }
  const invoicesArr = await readColl<any>('invoices');
  if (invoicesArr.some((i: any) => i.id === id)) {
    return updateInvoice(id, payload);
  }
  return salesCrud.update(id, payload);
}

export async function deleteSale(id: string) {
  const salesArr = await readColl<any>('sales');
  if (salesArr.some((s: any) => s.id === id)) {
    return salesCrud.remove(id);
  }
  const invoicesArr = await readColl<any>('invoices');
  if (invoicesArr.some((i: any) => i.id === id)) {
    return deleteInvoice(id);
  }
  return salesCrud.remove(id);
}

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
  return { expected, lastAudit: last, purchasesSince: +purchasesSince.toFixed(2), salesSince: +salesSince.toFixed(2), openingInventory: +(s.openingInventory || 0).toFixed(2) };
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

// ---------- Cash Book (manual cash in/out ledger) ----------
// A running ledger of manual cash movements the user records directly, on top
// of the cash implied by sales/payments. direction: 'in' (capital injection,
// owner deposit, cash received) or 'out' (cash withdrawn, petty spend).
export type CashDirection = 'in' | 'out';

export async function listCashEntries() {
  return (await readColl<any>('cashEntries')).sort((a: any, b: any) =>
    (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
}
export async function createCashEntry(e: { id?: string; amount: number; direction: CashDirection; date: string; notes?: string; type?: string; investorId?: string; partnerName?: string; v2SourceId?: string }) {
  return serialize(async () => {
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt < 0) throw new Error('Amount must be a valid non-negative number.');
    if (e.direction !== 'in' && e.direction !== 'out') throw new Error('Direction must be in or out.');
    const items = await readColl<any>('cashEntries');
    // v2SourceId (additive, optional): set when this entry MIRRORS a V2-journaled
    // movement, linking back to the V2 source so merged listings can dedupe.
    const item = { id: e.id || uuid(), amount: amt, direction: e.direction, date: e.date, notes: e.notes || '', type: e.type || '', investorId: e.investorId || '', partnerName: e.partnerName || '', ...(e.v2SourceId ? { v2SourceId: e.v2SourceId } : {}), created_at: nowIso() };
    items.push(item);
    await writeColl('cashEntries', items);
    return item;
  });
}
export async function updateCashEntry(id: string, e: any) {
  return serialize(async () => {
    if (e && 'amount' in e) {
      const amt = Number(e.amount);
      if (!Number.isFinite(amt) || amt < 0) throw new Error('Amount must be a valid non-negative number.');
    }
    const items = await readColl<any>('cashEntries');
    const idx = items.findIndex((x: any) => x.id === id);
    if (idx === -1) throw new Error('Cash entry not found');
    items[idx] = { ...items[idx], ...e };
    await writeColl('cashEntries', items);
    return items[idx];
  });
}
export async function deleteCashEntry(id: string) {
  return serialize(async () => {
    const items = (await readColl<any>('cashEntries')).filter((x: any) => x.id !== id);
    await writeColl('cashEntries', items);
    return { ok: true };
  });
}
/** Net manual cash adjustment (sum of ins − sum of outs) on/after periodStart. */
export async function manualCashNet(periodStart: string): Promise<number> {
  const entries = (await readColl<any>('cashEntries')).filter((e: any) => (e.date || '') >= periodStart);
  const ins = entries.filter((e: any) => e.direction === 'in').reduce((s: number, e: any) => s + toUsd(e.amount), 0);
  const outs = entries.filter((e: any) => e.direction === 'out').reduce((s: number, e: any) => s + toUsd(e.amount), 0);
  return +(ins - outs).toFixed(2);
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
  const invoicesAll = (await readColl<any>('invoices')).filter((i: any) => (i.date || '') >= periodStart);
  const receiptsAll = (await readColl<any>('receipts')).filter((r: any) => (r.date || '') >= periodStart);
  const creditNotesAll = (await readColl<any>('creditNotes')).filter((c: any) => (c.date || '') >= periodStart);
  const debitNotesAll = (await readColl<any>('debitNotes')).filter((c: any) => (c.date || '') >= periodStart);
  const invHistory = (await readColl<any>('inventoryChecks')).filter((i: any) => (i.date || '') >= periodStart).sort((a: any, b: any) => (a.date && b.date ? (a.date > b.date ? -1 : a.date < b.date ? 1 : 0) : 0));
  const suppliersCount = (await readColl<any>('suppliers')).length;

  const totalPurchases = bills.reduce((sum: number, b: any) => sum + toUsd(b.amount), 0);
  // Cash sales = the `sales` collection (walk-in / cash-sale receipts). This drives
  // the literal cash-on-hand calc and must NOT include credit/invoice revenue.
  const cashSalesTotal = sales.reduce((sum: number, x: any) => sum + toUsd(x.amount), 0);
  // Revenue for P&L depends on the accounting basis:
  //   accrual → cash sales + invoices raised (billed, regardless of collection)
  //   cash    → cash sales + amounts actually received against invoices (receipts)
  const invoiceRevenue = invoicesAll.reduce((sum: number, i: any) => sum + toUsd(i.total ?? i.amount ?? 0), 0);
  const receiptInvoiceRevenue = receiptsAll
    .filter((r: any) => r.mode === 'against_invoice')
    .reduce((sum: number, r: any) => sum + toUsd(r.amount), 0);
  const isAccrual = s.accountingBasis !== 'cash';
  // Credit notes reduce revenue (returns/discounts); debit notes add to it.
  // These are receivable adjustments so they only affect ACCRUAL revenue.
  const creditNoteTotal = creditNotesAll.reduce((sum: number, c: any) => sum + toUsd(c.amount), 0);
  const debitNoteTotal = debitNotesAll.reduce((sum: number, c: any) => sum + toUsd(c.amount), 0);
  const accrualRevenue = cashSalesTotal + invoiceRevenue - creditNoteTotal + debitNoteTotal;
  const cashRevenue = cashSalesTotal + receiptInvoiceRevenue;
  const totalSales = +(isAccrual ? accrualRevenue : cashRevenue).toFixed(2);
  const supplierPayments = payments.filter((p: any) => p.type === 'supplier_payment')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);
  const drawings = payments.filter((p: any) => p.type === 'drawing')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);
  const commissionPayments = payments.filter((p: any) => p.type === 'commission_payment')
    .reduce((sum: number, p: any) => sum + toUsd(p.amount), 0);

  // Manual cash book adjustments (in − out) recorded directly by the user.
  // Note: receipts against invoices/advances write cash-IN rows here, so money
  // received on credit sales flows into cash without touching cashSalesTotal.
  const cashEntriesAll = (await readColl<any>('cashEntries')).filter((e: any) => (e.date || '') >= periodStart);
  const cashInTotal = cashEntriesAll.filter((e: any) => e.direction === 'in').reduce((sum: number, e: any) => sum + toUsd(e.amount), 0);
  const cashOutTotal = cashEntriesAll.filter((e: any) => e.direction === 'out').reduce((sum: number, e: any) => sum + toUsd(e.amount), 0);
  const manualCash = +(cashInTotal - cashOutTotal).toFixed(2);

  // Route through the shared accounting.ts helpers (drift-safe integer-cent math)
  // so dashboard(), pnlRange() and monthlySummary() report byte-identical figures.
  // Historically these used raw `+(x−y).toFixed(2)` float math that could diverge
  // by a cent from pnlRange (which already uses these helpers). [Penny C1]
  const grossProfit = calcGross(totalSales, totalPurchases);
  const commission = calcCommission(grossProfit, pct);
  // Dashboard net profit is gross − commission (expenses/drawings excluded here,
  // unlike pnlRange). Pass 0 for those so the formula is unchanged but drift-safe.
  const netProfit = calcNet(grossProfit, commission, 0, 0);

  // Accrued commission is a liability until paid; commission payments settle it.
  const liabilities = +(totalPurchases - supplierPayments + commission - commissionPayments).toFixed(2);
  const lastAudit = invHistory[0];
  const auditBase = lastAudit ? Number(lastAudit.actualStock) : openingInv;
  const auditSinceDate = lastAudit ? (lastAudit.date || '') : periodStart;
  const purchasesSinceAudit = bills.filter((b: any) => (b.date || '') > auditSinceDate).reduce((sum: number, b: any) => sum + toUsd(b.amount), 0);
  const salesSinceAudit = sales.filter((x: any) => (x.date || '') > auditSinceDate).reduce((sum: number, x: any) => sum + toUsd(x.amount), 0);
  const inventoryValue = +(auditBase + (lastAudit ? purchasesSinceAudit : totalPurchases) - salesSinceAudit).toFixed(2);
  // Cash on hand uses ONLY literal cash sales (not accrual revenue); receipts
  // against invoices already contribute via the manualCash (cashEntries) term.
  const cash = +(computeCash(openingCash, cashSalesTotal, supplierPayments, drawings, commissionPayments) + manualCash).toFixed(2);

  // custom (dynamic) assets & liabilities from settings
  const extraAssets = Array.isArray(s.extraAssets) ? s.extraAssets : [];
  const extraLiabilities = Array.isArray(s.extraLiabilities) ? s.extraLiabilities : [];
  const extraAssetsTotal = +extraAssets.reduce((sum: number, a: any) => sum + (Number(a.amount) || 0), 0).toFixed(2);
  const extraLiabTotal = +extraLiabilities.reduce((sum: number, l: any) => sum + (Number(l.amount) || 0), 0).toFixed(2);

  const accountsReceivable = +(invoiceRevenue - receiptInvoiceRevenue - creditNoteTotal).toFixed(2);
  const assets = +(cash + inventoryValue + accountsReceivable + extraAssetsTotal).toFixed(2);
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
    assets, liabilities, netWorth, cash, inventoryValue, accountsReceivable,
    openingBalance, openingInventory: openingInv, openingCash, closingBalance,
    totalPurchases: +totalPurchases.toFixed(2), totalSales: +totalSales.toFixed(2),
    grossProfit, managerCommissionPct: pct, commission, netProfit,
    commissionPayments: +commissionPayments.toFixed(2),
    outstandingCommission: +(commission - commissionPayments).toFixed(2),
    drawings: +drawings.toFixed(2), supplierPayments: +supplierPayments.toFixed(2),
    suppliers: suppliersCount, periodStart, salesTrend,
    manualCashIn: +cashInTotal.toFixed(2), manualCashOut: +cashOutTotal.toFixed(2), manualCash,
    extraAssets, extraLiabilities, extraAssetsTotal, extraLiabTotal, totalLiabilities,
    openingCapital: Number(s.openingCapital || 0),
    accountingBasis: isAccrual ? 'accrual' : 'cash',
    cashSalesTotal: +cashSalesTotal.toFixed(2), invoiceRevenue: +invoiceRevenue.toFixed(2),
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

  const partnerNames: string[] = Array.isArray(s.partnerNames) && s.partnerNames.length ? s.partnerNames : [];
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

  // Per-investor capital: sum of individual contributions. Falls back to the
  // legacy combined openingCapital when no investors are defined.
  const investorsRaw: any[] = Array.isArray((s as any).investors) ? (s as any).investors : [];
  const investorContribTotal = investorsRaw.reduce((sum: number, inv: any) => sum + toUsd(inv?.amount), 0);
  const totalCapital = investorsRaw.length ? +investorContribTotal.toFixed(2) : +openingCapital.toFixed(2);

  // Attribute drawings to investors by name (case-insensitive), like partners.
  const perInvestorDrawings: Record<string, number> = {};
  for (const inv of investorsRaw) perInvestorDrawings[(inv?.name || '').trim().toLowerCase()] = 0;
  for (const p of drawingPayments) {
    const pn = (p.partnerName || '').trim().toLowerCase();
    if (pn in perInvestorDrawings) perInvestorDrawings[pn] += toUsd(p.amount);
  }
  // Profit share per member. If ANY member has an explicit profitSharePct set,
  // we honour those percentages (and split the remaining % equally among the
  // members who left theirs blank). If NONE set a %, we fall back to an equal
  // split across all members — i.e. behaviour is unchanged when no % entered.
  const shareCount = investorsRaw.length || partnerNames.length || 1;

  const explicitPctTotal = investorsRaw.reduce(
    (sum: number, inv: any) => sum + (Number(inv?.profitSharePct) > 0 ? Number(inv.profitSharePct) : 0),
    0
  );
  const anyExplicitPct = investorsRaw.some((inv: any) => Number(inv?.profitSharePct) > 0);
  const membersWithoutPct = investorsRaw.filter((inv: any) => !(Number(inv?.profitSharePct) > 0)).length;
  const remainderPctEach = anyExplicitPct && membersWithoutPct > 0
    ? Math.max(0, (100 - explicitPctTotal)) / membersWithoutPct
    : 0;

  // Per-member share via drift-safe money math (pctOf / integer-cent division).
  // The LAST member absorbs the rounding remainder so the shares ALWAYS sum
  // EXACTLY to netProfit (e.g. a 3-way equal split of $100 → 33.33/33.33/33.34)
  // rather than leaving/creating a stray cent. [Penny H2/M3]
  const rawShareFor = (inv: any): number => {
    if (!anyExplicitPct) return round2(netProfit / shareCount); // equal split, drift-safe round
    const pct = Number(inv?.profitSharePct) > 0 ? Number(inv.profitSharePct) : remainderPctEach;
    return pctOf(netProfit, pct);
  };
  // Compute every member's share, then reconcile the final member to the exact
  // remainder so Σ profitShare === netProfit to the cent.
  const profitShares: number[] = investorsRaw.map(rawShareFor);
  if (profitShares.length > 0) {
    const sumOthers = addMoney(...profitShares.slice(0, -1)); // exact sum of all but the last
    profitShares[profitShares.length - 1] = subMoney(netProfit, sumOthers);
  }

  const investors = investorsRaw.map((inv: any, idx: number) => {
    const name = (inv?.name || '').trim();
    const contributed = +toUsd(inv?.amount).toFixed(2);
    const drawings = +(perInvestorDrawings[name.toLowerCase()] || 0).toFixed(2);
    const profitShare = profitShares[idx];
    return {
      id: inv?.id || name,
      name,
      contributed,
      date: inv?.date || '',
      profitSharePct: Number(inv?.profitSharePct) > 0 ? Number(inv.profitSharePct) : null,
      profitShare,
      // Each investor's standing balance = their capital + their profit share − their drawings.
      balance: subMoney(contributed + profitShare, drawings),
    };
  });

  const closingCapital = +(totalCapital + netProfit - totalDrawings).toFixed(2);

  return {
    openingCapital: +totalCapital.toFixed(2),
    combinedOpeningCapital: +openingCapital.toFixed(2),
    netProfit,
    totalDrawings,
    closingCapital,
    investors,
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

export type InvestorLedgerTransaction = {
  id: string; date: string; type: 'opening_capital' | 'capital_injection' | 'drawing' | 'profit_allocation';
  notes: string; amount: number;
};
export type InvestorLedgerDetail = {
  id: string; name: string; profitSharePct: number; periodStart: string; periodEnd: string;
  openingCapital: number; currentCapitalBalance: number; totalInjected: number;
  totalDrawings: number; profitShare: number; transactions: InvestorLedgerTransaction[];
};

function legacyInvestor(settings: any, rawId: string) {
  if (settings.accountingStyle !== 'retail_partnership') throw new Error('Investor ledgers are available only in Partnership Mode');
  const id = decodeURIComponent(String(rawId || ''));
  const investors = Array.isArray(settings.investors) ? settings.investors : [];
  const found = investors.find((item: any) => String(item?.id || item?.name) === id || String(item?.name || '').toLowerCase() === id.toLowerCase());
  if (!found) throw new Error('Investor not found');
  return { ...found, id: String(found.id || found.name), name: String(found.name || '').trim() };
}

/** Partnership-only legacy fallback used when the active book is not V2-backed. */
export async function investorLedgerDetail(rawId: string): Promise<InvestorLedgerDetail> {
  const [settings, cashEntries, payments, periods, capital] = await Promise.all([
    getSettings(), readColl<any>('cashEntries'), readColl<any>('payments'), readColl<any>('periods'), capitalStatement(),
  ]);
  const investor = legacyInvestor(settings, rawId);
  const periodStart = settings.currentPeriodStart || '1970-01-01';
  const periodEnd = new Date().toISOString().slice(0, 10);
  const sameInvestor = (item: any) => {
    const itemId = String(item?.investorId || '');
    const itemName = String(item?.partnerName || '').trim().toLowerCase();
    if (itemId && (itemId === investor.id || itemId === investor.name)) return true;
    if (itemName && itemName === investor.name.toLowerCase()) return true;
    const onlyInvestor = (settings.investors || []).length === 1;
    const capitalNote = /capital|owner deposit|investment|injection/i.test(String(item?.type || '') + ' ' + String(item?.notes || ''));
    return onlyInvestor && capitalNote;
  };
  const deposits: InvestorLedgerTransaction[] = cashEntries
    .filter((entry: any) => entry.direction === 'in' && (entry.date || '') >= periodStart && sameInvestor(entry)
      && (entry.type === 'capital_injection' || /capital|owner deposit|investment|injection/i.test(entry.notes || '')))
    .map((entry: any) => ({ id: entry.id, date: entry.date, type: 'capital_injection', notes: entry.notes || 'Capital deposited', amount: +toUsd(entry.amount).toFixed(2) }));
  const drawings: InvestorLedgerTransaction[] = payments
    .filter((payment: any) => payment.type === 'drawing' && (payment.date || '') >= periodStart && sameInvestor(payment))
    .map((payment: any) => ({ id: payment.id, date: payment.date, type: 'drawing', notes: payment.notes || 'Funds drawn', amount: +toUsd(payment.amount).toFixed(2) }));
  const closedAllocations: InvestorLedgerTransaction[] = periods.flatMap((period: any) => {
    const pct = Number(investor.profitSharePct || 0);
    const amount = +(toUsd(period.netProfit) * pct / 100).toFixed(2);
    return amount ? [{ id: `${period.id}:${investor.id}:profit`, date: period.endDate, type: 'profit_allocation' as const, notes: 'Period-close profit allocation', amount }] : [];
  });
  const capitalRow = (capital.investors || []).find((item: any) => item.id === investor.id || String(item.name).toLowerCase() === investor.name.toLowerCase());
  const openingCapital = +toUsd(investor.amount).toFixed(2);
  const totalInjected = +deposits.reduce((sum, item) => sum + item.amount, 0).toFixed(2);
  const totalDrawings = +drawings.reduce((sum, item) => sum + item.amount, 0).toFixed(2);
  const profitShare = +toUsd(Number(capitalRow?.profitShare || 0)).toFixed(2);

  const transactions: InvestorLedgerTransaction[] = [
    ...deposits, ...drawings, ...closedAllocations,
    ...(openingCapital ? [{ id: `${investor.id}:opening`, date: periodStart, type: 'opening_capital' as const, notes: 'Opening capital carried into period', amount: openingCapital }] : []),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return {
    id: investor.id, name: investor.name, profitSharePct: Number(investor.profitSharePct || 0), periodStart, periodEnd,
    openingCapital, currentCapitalBalance: +(openingCapital + totalInjected + profitShare - totalDrawings).toFixed(2),
    totalInjected, totalDrawings, profitShare, transactions,
  };
}

export async function recordInvestorCapital(rawId: string, input: { amount: number; date: string; notes?: string }) {
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('Amount must be greater than zero');
  const settings = await getSettings();
  const investor = legacyInvestor(settings, rawId);
  return createCashEntry({ amount: input.amount, direction: 'in', date: input.date, notes: input.notes || `Capital injection — ${investor.name}`, type: 'capital_injection', investorId: investor.id, partnerName: investor.name });
}

export async function recordInvestorDrawing(rawId: string, input: { amount: number; date: string; notes?: string }) {
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) throw new Error('Amount must be greater than zero');
  const settings = await getSettings();
  const investor = legacyInvestor(settings, rawId);
  return createPayment({ amount: input.amount, date: input.date, notes: input.notes || `Drawing — ${investor.name}`, type: 'drawing', partnerName: investor.name, investorId: investor.id, method: 'cash' });
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
  const pct = Number(s.managerCommissionPct || 0);
  // Use the shared drift-safe accounting helpers so this monthly view never
  // diverges by a cent from dashboard()/pnlRange(). [Penny C1]
  const grossProfit = calcGross(revenue, purchases);
  const commission = calcCommission(grossProfit, pct);
  const netProfit = calcNet(grossProfit, commission, 0, drawings);
  const cashFlow = subMoney(revenue, supplierPayments, drawings, commission);

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

// ---------- Expenses ----------
export async function listExpenses() {
  return (await readColl<any>('expenses')).sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}
export async function createExpense(e: any) {
  return serialize(async () => {
    const items = await readColl<any>('expenses');
    const item = { id: uuid(), created_at: nowIso(), ...e };
    items.push(item);
    await writeColl('expenses', items);
    return item;
  });
}
export async function updateExpense(id: string, e: any) {
  return serialize(async () => {
    const items = await readColl<any>('expenses');
    const idx = items.findIndex((x: any) => x.id === id);
    if (idx === -1) throw new Error('Expense not found');
    items[idx] = { ...items[idx], ...e };
    await writeColl('expenses', items);
    return items[idx];
  });
}
export async function deleteExpense(id: string) {
  return serialize(async () => {
    const items = await readColl<any>('expenses');
    await writeColl('expenses', items.filter((x: any) => x.id !== id));
    return { ok: true };
  });
}

// ---------- Debtors ----------
export async function listDebtors() {
  const [debtors, creditNotes, debitNotes] = await Promise.all([
    readColl<any>('debtors'), readColl<any>('creditNotes'), readColl<any>('debitNotes'),
  ]);
  // Compute real balances: totalInvoiced from the debtor's invoice refs,
  // totalPaid from recorded payments. Credit notes reduce what the customer owes
  // (returns/discounts); debit notes increase it (extra charges). Both are tied
  // to a debtor by debtorId.
  return debtors
    .map((d: any) => {
      const totalInvoiced = (d.invoices || []).reduce((s: number, i: any) => s + toUsd(i.amount), 0);
      const totalPaid = (d.payments || []).reduce((s: number, p: any) => s + toUsd(p.amount), 0);
      const totalCredited = creditNotes.filter((c: any) => c.debtorId === d.id).reduce((s: number, c: any) => s + toUsd(c.amount), 0);
      const totalDebited = debitNotes.filter((c: any) => c.debtorId === d.id).reduce((s: number, c: any) => s + toUsd(c.amount), 0);
      return {
        ...d,
        totalInvoiced: +totalInvoiced.toFixed(2),
        totalPaid: +totalPaid.toFixed(2),
        totalCredited: +totalCredited.toFixed(2),
        totalDebited: +totalDebited.toFixed(2),
        balance: +(totalInvoiced + totalDebited - totalPaid - totalCredited).toFixed(2),
      };
    })
    .sort((a: any, b: any) => (a.name > b.name ? 1 : -1));
}
export async function createDebtor(d: any) {
  return serialize(async () => {
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const name = (d.name || '').trim();
    if (!name) throw new Error('Customer / Party name is required');
    const items = await readColl<any>('debtors');
    const suppliers = await readColl<any>('suppliers');
    if ([...items, ...suppliers].some((x: any) => norm(x.name) === norm(name))) {
      throw new Error(`A party or customer named '${name}' already exists in this account.`);
    }
    const item = { id: uuid(), created_at: nowIso(), payments: [], ...d, name };
    items.push(item);
    await writeColl('debtors', items);
    return item;
  });
}
export async function updateDebtor(id: string, d: any) {
  return serialize(async () => {
    const items = await readColl<any>('debtors');
    const idx = items.findIndex((x: any) => x.id === id);
    if (idx === -1) throw new Error('Debtor not found');
    items[idx] = { ...items[idx], ...d };
    await writeColl('debtors', items);
    return items[idx];
  });
}
export async function deleteDebtor(id: string) {
  return serialize(async () => {
    const items = await readColl<any>('debtors');
    const debtor = items.find((x: any) => x.id === id);
    if (!debtor) throw new Error('Customer not found');

    if ((debtor.invoices && debtor.invoices.length > 0) || (debtor.payments && debtor.payments.length > 0)) {
      throw new Error(`Cannot delete ${debtor.name} because they have existing invoices or payments.`);
    }

    const sales = await readColl<any>('sales');
    const norm = (s: string) => (s || '').trim().toLowerCase();
    if (sales.some((x: any) => norm(x.customerName) === norm(debtor.name))) {
      throw new Error(`Cannot delete ${debtor.name} because they have existing sales records.`);
    }

    await writeColl('debtors', items.filter((x: any) => x.id !== id));
    return { ok: true };
  });
}
export async function addDebtorPayment(debtorId: string, payment: { amount: number; date: string; notes?: string }) {
  // Find the debtor to get their name and open invoices.
  const debtors = await readColl<any>('debtors');
  const debtor = debtors.find((d: any) => d.id === debtorId);
  if (!debtor) throw new Error('Debtor not found');

  // Find open invoices for this customer, oldest first, and auto-allocate.
  const invoices = await readColl<any>('invoices');
  const norm = (s: string) => (s || '').trim().toLowerCase();
  const openInvoices = invoices
    .filter((i: any) =>
      norm(i.clientName) === norm(debtor.name) && i.status !== 'paid'
    )
    .sort((a: any, b: any) => (a.date > b.date ? 1 : -1)); // oldest first

  let remaining = +Number(payment.amount).toFixed(2);
  const allocations: { invoiceId: string; amountApplied: number }[] = [];

  for (const inv of openInvoices) {
    if (remaining <= 0) break;
    const alreadyPaid = await invoicePaidAmount(inv.id);
    const open = +(+Number(inv.total).toFixed(2) - alreadyPaid).toFixed(2);
    if (open <= 0.005) continue;
    const applied = Math.min(remaining, open);
    allocations.push({ invoiceId: inv.id, amountApplied: +applied.toFixed(2) });
    remaining = +(+remaining - applied).toFixed(2);
  }

  // If no open invoices, treat as an advance against the debtor.
  const mode: ReceiptMode = allocations.length > 0 ? 'against_invoice' : 'advance';

  return createReceipt({
    mode,
    date: payment.date,
    amount: +Number(payment.amount).toFixed(2),
    debtorId,
    clientName: debtor.name,
    allocations,
    notes: payment.notes || (mode === 'advance' ? 'Advance payment' : 'Payment received'),
  });
}

/** Delete a payment from a debtor's ledger. If linked to a receipt, cascades
 * to delete receipt + cash entry + sales entry. Legacy payments (no receiptId)
 * are cleaned from the debtor array only. */
export async function deleteDebtorPayment(debtorId: string, paymentId: string) {
  const debtors = await readColl<any>('debtors');
  const debtor = debtors.find((d: any) => d.id === debtorId);
  if (!debtor) throw new Error('Debtor not found');
  const payment = (debtor.payments || []).find((p: any) => p.id === paymentId);
  if (!payment) return { ok: true };

  if (payment.receiptId) {
    const receipts = await readColl<any>('receipts');
    const receipt = receipts.find((r: any) => r.id === payment.receiptId);
    if (!receipt || receipt.debtorId !== debtorId) throw new Error('Linked receipt does not belong to this customer');
    await deleteReceipt(payment.receiptId);
  } else {
    await serialize(async () => {
      const items = await readColl<any>('debtors');
      const idx = items.findIndex((d: any) => d.id === debtorId);
      if (idx !== -1) {
        items[idx].payments = (items[idx].payments || []).filter((p: any) => p.id !== paymentId);
        await writeColl('debtors', items);
      }
    });
  }
  return { ok: true };
}

/** Update a debtor payment amount/date/notes by replacing the old receipt with
 * a new one (or updating legacy records in-place). */
export async function updateDebtorPayment(debtorId: string, paymentId: string, update: { amount?: number; date?: string; notes?: string }) {
  const debtors = await readColl<any>('debtors');
  const debtor = debtors.find((d: any) => d.id === debtorId);
  if (!debtor) throw new Error('Debtor not found');
  const payment = (debtor.payments || []).find((p: any) => p.id === paymentId);
  if (!payment) throw new Error('Payment not found');

  if (!payment.receiptId) {
    return serialize(async () => {
      const items = await readColl<any>('debtors');
      const idx = items.findIndex((d: any) => d.id === debtorId);
      const p = (items[idx].payments || []).find((x: any) => x.id === paymentId);
      if (p) Object.assign(p, update);
      await writeColl('debtors', items);
      return items[idx];
    });
  }

  const receipts = await readColl<any>('receipts');
  const receipt = receipts.find((r: any) => r.id === payment.receiptId);
  if (!receipt || receipt.debtorId !== debtorId) throw new Error('Linked receipt does not belong to this customer');

  // Snapshot every collection touched by deleteReceipt/createReceipt. If any
  // persistence step fails, restoring these snapshots removes partial replacement
  // artifacts as well as restoring the original receipt and all side effects.
  const [beforeCash, beforeSales, beforeDebtors, beforeInvoices] = await Promise.all([
    readColl<any>('cashEntries'), readColl<any>('sales'), readColl<any>('debtors'), readColl<any>('invoices'),
  ]);
  const originalState = {
    receipts: receipts.map((x: any) => ({ ...x })),
    cashEntries: beforeCash.map((x: any) => ({ ...x })),
    sales: beforeSales.map((x: any) => ({ ...x })),
    debtors: beforeDebtors.map((x: any) => ({ ...x, payments: Array.isArray(x.payments) ? x.payments.map((p: any) => ({ ...p })) : x.payments, invoices: Array.isArray(x.invoices) ? x.invoices.map((i: any) => ({ ...i })) : x.invoices })),
    invoices: beforeInvoices.map((x: any) => ({ ...x })),
  };

  await deleteReceipt(payment.receiptId);
  const amt = update.amount ?? payment.amount;
  const date = update.date ?? payment.date;
  const notes = update.notes !== undefined ? update.notes : (receipt.notes || payment.notes);
  const amount = +Number(amt).toFixed(2);
  let remaining = amount;
  const allocations: { invoiceId: string; amountApplied: number }[] = [];
  for (const allocation of (receipt.allocations || [])) {
    if (remaining <= 0) break;
    const applied = Math.min(remaining, toUsd(allocation.amountApplied));
    if (applied > 0) allocations.push({ invoiceId: allocation.invoiceId, amountApplied: +applied.toFixed(2) });
    remaining = +(remaining - applied).toFixed(2);
  }

  // If an edited receipt exceeds its preserved invoice allocations, represent the
  // remainder as customer advance credit rather than silently leaving it outside
  // the debtor ledger.
  const allocatedTotal = allocations.reduce((sum, a) => sum + a.amountApplied, 0);
  const replacementMode: ReceiptMode = receipt.mode === 'advance' || amount > allocatedTotal + 0.005 ? 'advance' : receipt.mode;

  // Preserve the original allocation order and receipt metadata. A smaller edit
  // trims allocations in that order; a larger edit keeps the excess as advance
  // credit instead of silently moving it to another invoice.
  try {
    return await createReceipt({
      mode: replacementMode,
      date,
      amount,
      debtorId,
      clientName: receipt.clientName || debtor.name,
      allocations,
      lines: receipt.lines,
      taxRate: receipt.taxRate,
      method: receipt.method,
      notes,
    });
  } catch (error) {
    try {
      await serialize(async () => {
        await writeColl('receipts', originalState.receipts);
        await writeColl('cashEntries', originalState.cashEntries);
        await writeColl('sales', originalState.sales);
        await writeColl('debtors', originalState.debtors);
        await writeColl('invoices', originalState.invoices);
      });
    } catch (rollbackError: any) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`Payment update failed (${originalMessage}); restoring the original posting also failed (${rollbackMessage}).`);
    }
    throw error;
  }
}

/**
 * Full customer statement: invoices + payments merged into one chronological
 * ledger with a running balance. This is what powers the debtor detail screen
 * so the customer's billing history (not just payments) is visible.
 */
export async function getDebtorStatement(debtorId: string) {
  const [debtors, creditNotes, debitNotes, receipts] = await Promise.all([
    readColl<any>('debtors'), readColl<any>('creditNotes'), readColl<any>('debitNotes'), readColl<any>('receipts'),
  ]);
  const d = debtors.find((x: any) => x.id === debtorId);
  if (!d) throw new Error('Debtor not found');
  const invoiceRows = (d.invoices || []).map((i: any) => ({
    kind: 'invoice' as const,
    id: i.id,
    date: (i.date || '').slice(0, 10),
    ref: i.invoiceNumber || '',
    status: i.status || 'unpaid',
    debit: toUsd(i.amount),   // increases what they owe
    credit: 0,
  }));
  const paymentRows = (d.payments || []).map((p: any) => {
    const receipt = p.receiptId ? receipts.find((r: any) => r.id === p.receiptId && r.debtorId === debtorId) : null;
    return {
      kind: 'payment' as const,
      id: p.id,
      receiptId: p.receiptId,
      date: (p.date || '').slice(0, 10),
      ref: receipt?.notes || p.notes || 'Payment',
      method: receipt?.method || 'cash',
      status: 'paid',
      debit: 0,
      credit: toUsd(p.amount),  // reduces what they owe
    };
  });
  // Credit notes (returns/discounts) reduce the balance; debit notes increase it.
  const creditRows = creditNotes.filter((c: any) => c.debtorId === debtorId).map((c: any) => ({
    kind: 'credit_note' as const,
    id: c.id,
    date: (c.date || '').slice(0, 10),
    ref: c.noteNumber || 'Credit Note',
    status: c.reason || 'credit',
    debit: 0,
    credit: toUsd(c.amount),
  }));
  const debitRows = debitNotes.filter((c: any) => c.debtorId === debtorId).map((c: any) => ({
    kind: 'debit_note' as const,
    id: c.id,
    date: (c.date || '').slice(0, 10),
    ref: c.noteNumber || 'Debit Note',
    status: c.reason || 'debit',
    debit: toUsd(c.amount),
    credit: 0,
  }));
  const rows = [...invoiceRows, ...paymentRows, ...creditRows, ...debitRows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let running = 0;
  const ledger = rows.map((r) => {
    running += r.debit - r.credit;
    return { ...r, balance: +running.toFixed(2) };
  });
  const totalInvoiced = invoiceRows.reduce((s: number, r: any) => s + r.debit, 0);
  const totalPaid = paymentRows.reduce((s: number, r: any) => s + r.credit, 0);
  const totalCredited = creditRows.reduce((s: number, r: any) => s + r.credit, 0);
  const totalDebited = debitRows.reduce((s: number, r: any) => s + r.debit, 0);
  return {
    id: d.id,
    name: d.name,
    phone: d.phone || '',
    email: d.email || '',
    ledger,
    totalInvoiced: +totalInvoiced.toFixed(2),
    totalPaid: +totalPaid.toFixed(2),
    totalCredited: +totalCredited.toFixed(2),
    totalDebited: +totalDebited.toFixed(2),
    balance: +(totalInvoiced + totalDebited - totalPaid - totalCredited).toFixed(2),
  };
}

// ---------- Date-range reports ----------
export async function pnlRange(from: string, to: string) {
  const s = await getSettings();
  const pct = Number(s.managerCommissionPct || 0);
  const inRange = (d: string) => (d || '').slice(0, 10) >= from && (d || '').slice(0, 10) <= to;
  const [bills, sales, payments, expenses, invChecks, invoices, receipts] = await Promise.all([
    readColl<any>('bills'), readColl<any>('sales'), readColl<any>('payments'), readColl<any>('expenses'), readColl<any>('inventoryChecks'), readColl<any>('invoices'), readColl<any>('receipts'),
  ]);
  // Revenue basis (mirrors dashboard): accrual = cash sales + invoices raised;
  // cash = cash sales + amounts received against invoices (receipts).
  const cashSales = sales.filter((x: any) => inRange(x.date)).reduce((s: number, x: any) => s + toUsd(x.amount), 0);
  const invoiceRevenue = invoices.filter((i: any) => inRange(i.date)).reduce((s: number, i: any) => s + toUsd(i.total), 0);
  const receiptRevenue = receipts.filter((r: any) => inRange(r.date) && r.mode === 'against_invoice').reduce((s: number, r: any) => s + toUsd(r.amount), 0);
  const revenue = s.accountingBasis === 'accrual' ? cashSales + invoiceRevenue : cashSales + receiptRevenue;
  const purchases = bills.filter((b: any) => inRange(b.date)).reduce((s: number, b: any) => s + toUsd(b.amount), 0);
  const totalExpenses = expenses.filter((e: any) => inRange(e.date)).reduce((s: number, e: any) => s + toUsd(e.amount), 0);
  const drawings = payments.filter((p: any) => inRange(p.date) && p.type === 'drawing').reduce((s: number, p: any) => s + toUsd(p.amount), 0);

  // Periodic inventory: COGS = opening stock + purchases - closing stock.
  // Opening stock = latest physical count strictly BEFORE `from` (else settings.openingInventory).
  // Closing stock = latest physical count on/before `to` (else falls back to opening).
  const sortedChecks = [...invChecks].filter((i: any) => i.date).sort((a: any, b: any) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
  const beforeFrom = sortedChecks.filter((i: any) => i.date < from);
  const openingStock = beforeFrom.length ? Number(beforeFrom[beforeFrom.length - 1].actualStock) : Number(s.openingInventory || 0);
  const upToTo = sortedChecks.filter((i: any) => i.date <= to);
  const hasClosingCount = upToTo.length > 0;
  const closingStock = hasClosingCount ? Number(upToTo[upToTo.length - 1].actualStock) : openingStock;

  // If we have a real closing count, use true COGS; otherwise fall back to purchases as COGS
  // (so profit isn't overstated before the first stock take).
  const cogs = computeCogs(openingStock, purchases, closingStock, hasClosingCount);
  const grossProfit = calcGross(revenue, cogs);
  const commission = calcCommission(grossProfit, pct);
  const netProfit = calcNet(grossProfit, commission, totalExpenses, drawings);
  return {
    from, to, revenue: +revenue.toFixed(2), purchases: +purchases.toFixed(2),
    openingStock: +openingStock.toFixed(2), closingStock: +closingStock.toFixed(2), hasClosingCount,
    cogs, grossProfit, managerCommissionPct: pct, commission,
    expenses: +totalExpenses.toFixed(2), drawings: +drawings.toFixed(2), netProfit,
  };
}

export async function creditorsReport(from?: string, to?: string) {
  const [suppliers, bills, payments] = await Promise.all([
    readColl<any>('suppliers'), readColl<any>('bills'), readColl<any>('payments'),
  ]);
  const inRange = (d: string) => (!from || (d || '').slice(0, 10) >= from) && (!to || (d || '').slice(0, 10) <= to);
  const result: any[] = [];
  for (const sup of suppliers) {
    const supBills = bills.filter((b: any) => b.supplierId === sup.id && inRange(b.date));
    const supPays = payments.filter((p: any) => p.supplierId === sup.id && p.type === 'supplier_payment' && inRange(p.date));
    const totalBilled = supBills.reduce((s: number, b: any) => s + toUsd(b.amount), 0);
    const totalPaid = supPays.reduce((s: number, p: any) => s + toUsd(p.amount), 0);
    const balance = +(totalBilled - totalPaid).toFixed(2);
    result.push({ supplierId: sup.id, name: sup.name, phone: sup.phone || '', email: sup.email || '', totalBilled: +totalBilled.toFixed(2), totalPaid: +totalPaid.toFixed(2), balance, transactions: [...supBills.map((b: any) => ({ ...b, txType: 'bill' })), ...supPays.map((p: any) => ({ ...p, txType: 'payment' }))].sort((a: any, b: any) => (a.date > b.date ? 1 : -1)) });
  }
  return result.sort((a, b) => b.balance - a.balance);
}

export async function debtorsReport(from?: string, to?: string) {
  const debtors = await readColl<any>('debtors');
  const inRange = (d: string) => (!from || (d || '').slice(0, 10) >= from) && (!to || (d || '').slice(0, 10) <= to);
  return debtors.map((d: any) => {
    const invoices = (d.invoices || []).filter((i: any) => inRange(i.date));
    const payments = (d.payments || []).filter((p: any) => inRange(p.date));
    const totalInvoiced = invoices.reduce((s: number, i: any) => s + toUsd(i.amount), 0);
    const totalPaid = payments.reduce((s: number, p: any) => s + toUsd(p.amount), 0);
    const balance = +(totalInvoiced - totalPaid).toFixed(2);
    return { ...d, totalInvoiced: +totalInvoiced.toFixed(2), totalPaid: +totalPaid.toFixed(2), balance };
  }).sort((a: any, b: any) => b.balance - a.balance);
}
export async function listPeriods() {
  return (await readColl<any>('periods')).sort((a: any, b: any) => (a.closed_at && b.closed_at ? (a.closed_at > b.closed_at ? -1 : a.closed_at < b.closed_at ? 1 : 0) : 0));
}
export async function closePeriod(actualStock: number, notes = '', commissionPct = 0, date?: string) {
  return serialize(async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const closeDate = date || today;
    let genuineDate = false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(closeDate)) {
      try { genuineDate = new Date(`${closeDate}T00:00:00.000Z`).toISOString().slice(0, 10) === closeDate; } catch { genuineDate = false; }
    }
    if (!genuineDate) throw new Error('Close date must use a genuine YYYY-MM-DD date');
    const settingsBeforeClose = await getSettings();
    const periodStart = String(settingsBeforeClose.currentPeriodStart || '1970-01-01');
    if (closeDate < periodStart) throw new Error(`Close date ${closeDate} cannot be before the period start ${periodStart}`);
    const datedCollections = ['bills', 'sales', 'payments', 'invoices', 'receipts', 'creditNotes', 'debitNotes', 'inventoryChecks', 'expenses', 'cashEntries'] as const;
    const datedRows = (await Promise.all(datedCollections.map((collection) => readColl<any>(collection)))).flat();
    const later = datedRows.map((row: any) => String(row?.date || '').slice(0, 10)).filter((entryDate) => entryDate > closeDate).sort()[0];
    if (later) throw new Error(`Accounting period cannot close on ${closeDate} because it contains activity dated ${later}`);
    const d = await dashboard();
    const pct = Number.isFinite(Number(commissionPct)) ? Math.max(0, Math.min(100, Number(commissionPct))) : 0;
    const closeCommission = calcCommission(d.grossProfit, pct);
    const period = {
      id: uuid(), startDate: d.periodStart, endDate: closeDate,
      openingInventory: d.openingInventory, openingCash: d.openingCash,
      totalSales: d.totalSales, totalPurchases: d.totalPurchases,
      grossProfit: d.grossProfit, managerCommissionPct: pct,
      commission: closeCommission, drawings: d.drawings, supplierPayments: d.supplierPayments,
      netProfit: +(d.grossProfit - closeCommission).toFixed(2), closingInventory: actualStock, closingCash: d.cash,
      notes, closed_at: nowIso(),
    };
    const periods = await readColl<any>('periods');
    periods.push(period);
    await writeColl('periods', periods);

    const inv = { id: uuid(), date: closeDate, expectedStock: d.inventoryValue, actualStock, variance: +(actualStock - d.inventoryValue).toFixed(2), notes: `Period close: ${d.periodStart} → ${closeDate}`, created_at: nowIso() };
    const invs = await readColl<any>('inventoryChecks');
    invs.push(inv);
    await writeColl('inventoryChecks', invs);

    // The new period starts on the reviewed close date, not the following day.
    // dashboard() filters date >= periodStart with no upper bound, so a transaction
    // entered on that date right after the close is
    // correctly picked up by the new period. Using tomorrow created a "dead zone" where
    // same-day post-close entries were excluded from the new period AND already frozen out
    // of the archived snapshot — silently vanishing from every report.
    const settings = await getSettings();
    let capitalCarry: Record<string, any> = {};
    if (settings.accountingStyle === 'retail_partnership' && Array.isArray(settings.investors) && settings.investors.length) {
      const details = await Promise.all(settings.investors.map((item: any) => investorLedgerDetail(String(item.id || item.name))));
      const investors = details.map((item) => ({ id: item.id, name: item.name, amount: item.currentCapitalBalance, date: closeDate, profitSharePct: item.profitSharePct }));
      capitalCarry = { investors, partnerNames: investors.map((item) => item.name), openingCapital: +investors.reduce((sum, item) => sum + item.amount, 0).toFixed(2) };
    }
    await updateSettings({ currentPeriodStart: closeDate, openingInventory: actualStock, openingCash: d.cash, ...capitalCarry });
    return period;
  });
}

// ---------- Backup / Restore / Reset ----------
// The current document collections captured by a backup (plus the preferences
// document, handled separately). Order is deterministic so wipe
// and restore always touch the same set. [H1]
const BACKUP_COLLECTIONS = SQL_COLLECTIONS; // the 15 data collections (settings is handled separately)
// Current backup format. Older schemas were never released and are intentionally
// unsupported; this clean-install app restores only an exact current-format file.
export const BACKUP_VERSION = 10;

export type ImportBackupResult = {
  ok: true;
  mode: 'replace';
  v2Restored: boolean;
  v2Missing: boolean;
  warnings: string[];
};

export async function exportBackup() {
  const colls = await Promise.all(BACKUP_COLLECTIONS.map((c) => readColl(c)));
  const data: Record<string, any> = {};
  BACKUP_COLLECTIONS.forEach((c, i) => { data[c] = colls[i]; });

  // Settings blob no longer carries the logo (see resolveLogo/[H4]); include the
  // logo separately so a restore rehydrates it into the dedicated key.
  const rawSettings = await readSettings();
  const dedicatedLogo = await backendReadLogo();
  const logo = dedicatedLogo;
  const settings = { ...rawSettings };
  if (isDataUri(settings.logo)) delete settings.logo;
  if (logo) settings.hasLogo = true;

  // V2 authoritative ledger (only when a SQLite runner is active). This is the
  // headline fix: without it a backup silently drops the entire double-entry
  // ledger on a SQLite install. [C1]
  let v2: any = undefined;
  const runner = backendActiveSqlRunner();
  if (runner) {
    v2 = await exportV2Data(runner);
  }

  // [Finding D] Multi-book capture. The top-level data/settings/logo above are
  // the DEFAULT book. Additionally capture:
  //   - `books`:    the raw books index (so every book is listable on restore)
  //   - `bookData`: each SECONDARY book's namespaced document payload
  // The default book is excluded from `bookData` (it is the top-level payload).
  const booksIndex = await readBooksIndexRaw();
  const bookData: Record<string, { collections: Record<string, any[]>; settings: any; logo: string }> = {};
  for (const book of booksIndex) {
    if (!book || !book.id || book.id === 'default') continue;
    try { bookData[book.id] = await readSecondaryBookPayload(book.id); } catch { /* best-effort per book */ }
  }

  return {
    ...data,
    settings,
    logo,
    books: booksIndex,
    bookData,
    ...(v2 ? { v2 } : {}),
    _meta: { app: 'ledgr', version: BACKUP_VERSION, exportedAt: nowIso() },
  };
}

/**
 * Restore a backup. ATOMIC + CLEARING:
 *   - Clears all document collections and V2 tables before applying the backup.
 *   - In SQLite mode the whole restore (all collections + settings + V2) runs
 *     inside ONE transaction and rolls back entirely on any error. [C3]
 * Only exact current-format backups with a normalized V2 payload are accepted.
 */
export async function importBackup(data: any): Promise<ImportBackupResult> {
  const meta = data && typeof data === 'object' ? data._meta : undefined;
  if (!meta || meta.app !== 'ledgr') throw new Error('This file is not a Ledgr backup.');
  const version = Number(meta.version);
  if (version !== BACKUP_VERSION) throw new Error(`Unsupported Ledgr backup format v${Number.isFinite(version) ? version : 'unknown'}. Only format v${BACKUP_VERSION} can be restored.`);
  if (!hasV2Payload(data?.v2)) throw new Error('This backup does not contain the current V2 accounting ledger.');

  const runner = backendActiveSqlRunner();
  const sqliteMode = backendStorageMode() === 'sqlite' && !!runner && activeBookIsDefault();
  if (!runner || !sqliteMode) throw new Error('Current-format backup restore requires SQLite storage on the main account.');
  const warnings: string[] = [];

  // What the restore writes into a collection: the backup's array, or [] when
  // that collection is absent (so it is CLEARED, never left stale). [H1]
  const collValue = (c: Collection): any[] => (Array.isArray(data?.[c]) ? data[c] : []);
  const mergedSettings = (base: any) =>
    (data?.settings && typeof data.settings === 'object') ? { ...base, ...data.settings } : base;
  // Never let a stale inline logo ride along inside the settings blob.
  const stripInlineLogo = (s: any) => { if (s && isDataUri(s.logo)) delete s.logo; return s; };
  const logoValue: string | null = typeof data?.logo === 'string' ? data.logo : null;

  if (sqliteMode && runner) {
    // ----- SQLite: one atomic transaction for EVERYTHING -----
    await withImportTransaction(runner, async () => {
      for (const c of BACKUP_COLLECTIONS) {
        await writeCollInTxn(runner, c, collValue(c)); // DELETE + INSERT clears absent colls too
      }
      const baseSettings = await (async () => {
        const row = await runner.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
        try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
      })();
      const nextSettings = stripInlineLogo(mergedSettings(baseSettings));
      if (logoValue != null) nextSettings.hasLogo = !!logoValue;
      await writeSettingsInTxn(runner, nextSettings);
      // Logo row (separate from the settings doc's CursorWindow).
      if (logoValue != null) {
        if (logoValue) await runner.run("INSERT INTO settings(key,value) VALUES('logo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [logoValue]);
        else await runner.run("DELETE FROM settings WHERE key='logo'");
      }
      const v2Result: V2ImportResult = await importV2Data(runner, data.v2);
      warnings.push(...v2Result.warnings);
    });
  }

  // [Finding D] Restore the books index + every SECONDARY book's namespaced
  // document payload (collections/settings/logo). These live in AsyncStorage for
  // ALL storage modes (only the default book uses the SQLite store), so this
  // runs after the default-book restore above regardless of mode. We snapshot
  // the exact keys first and roll them back on any failure. The shared v2_*
  // ledger for secondary books was already restored with the V2 payload above.
  const backupBooks: any[] = Array.isArray(data?.books) ? data.books : [];
  const backupBookData: Record<string, any> = (data?.bookData && typeof data.bookData === 'object') ? data.bookData : {};
  const secondaryIds = backupBooks.map((b) => b && b.id).filter((id) => id && id !== 'default');
  if (backupBooks.length || secondaryIds.length) {
    // Snapshot: the books index + every secondary book's collection/settings/logo
    // keys (both the ones we are about to write AND any currently-present books,
    // so a book removed by the restore is cleaned up on rollback too).
    const currentBooks = await readBooksIndexRaw();
    const idsToSnapshot = new Set<string>([...secondaryIds, ...currentBooks.map((b) => b.id).filter((id) => id && id !== 'default')]);
    const bookKeys: string[] = ['ledgr:books'];
    for (const id of idsToSnapshot) {
      for (const c of SQL_COLLECTIONS) bookKeys.push(`ledgr:${id}:${c}`);
      bookKeys.push(`ledgr:${id}:settings`, `ledgr:${id}:logo`);
    }
    const bookSnapshot = await snapshotKeys(bookKeys);
    try {
      // Persist the index EXACTLY as backed up (listBooks re-injects default).
      await writeBooksIndexRaw(backupBooks);
      for (const id of secondaryIds) {
        const payload = backupBookData[id] || {};
        await writeSecondaryBookPayload(id, {
          collections: payload.collections,
          settings: payload.settings,
          logo: payload.logo,
        });
      }
    } catch (e) {
      await restoreKeys(bookSnapshot); // best-effort rollback of the multi-book slice
      throw e;
    }
  }

  return {
    ok: true,
    mode: 'replace',
    v2Restored: true,
    v2Missing: false,
    warnings,
  };
}
export async function resetAll() {
  const s = await readSettings();
  await Promise.all([
    backendClearColl('suppliers'),
    backendClearColl('bills'),
    backendClearColl('sales'),
    backendClearColl('payments'),
    backendClearColl('inventoryChecks'),
    backendClearColl('periods'),
    backendClearColl('expenses'),
    backendClearColl('debtors'),
    backendClearColl('invoices'),
    backendClearColl('quotes'),
    backendClearColl('receipts'),
    backendClearColl('creditNotes'),
    backendClearColl('debitNotes'),
    backendClearColl('deliveryNotes'),
    backendClearColl('cashEntries'),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  await writeSettings({
    ...s,
    currentPeriodStart: today,
    openingInventory: 0,
    openingCash: 0,
    openingCapital: 0,
    extraAssets: [],
    extraLiabilities: [],
    investors: [],
    partnerNames: [],
  });
  return { ok: true };
}

/** Full device reset: clear accounting data and the business configuration. */
export async function factoryReset() {
  await resetAll();
  await writeSettings({});
  // The logo lives outside the settings blob now, so clear it explicitly. [H4]
  await backendClearLogo();
  return { ok: true };
}

// ---------- Invoices ----------
export async function listInvoices() {
  return (await readColl<any>('invoices')).sort((a: any, b: any) => (a.date > b.date ? -1 : 1));
}
export async function createInvoice(inv: any) {
  // Step 1: create the invoice record
  const item = await serialize(async () => {
    const items = await readColl<any>('invoices');
    // Numbering: derive next sequence from the max existing INV-#### so deletes/imports never cause a collision.
    // NOTE [M3-doc]: sequences are derived from the current collection's max, NOT a
    // persisted counter. After a backup import the next number therefore restarts
    // from (restored max + 1). This is intended: a restore rebuilds the invoice set,
    // so numbering must track the restored records — never a stale device-local counter
    // that could collide with, or skip past, the numbers present in the restored data.
    const maxSeq = items.reduce((m: number, it: any) => {
      const match = /INV-(\d+)/.exec(it.invoiceNumber || '');
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const num = `INV-${String(maxSeq + 1).padStart(4, '0')}`;
    const newItem = { id: uuid(), invoiceNumber: num, status: 'unpaid', created_at: nowIso(), ...inv };
    items.push(newItem);
    await writeColl('invoices', items);
    return newItem;
  });
  // Step 2: sync to debtor ledger (find-or-create debtor, push invoice ref)
  // This runs as a separate serialize call to avoid deadlock.
  if (inv.clientName) {
    await serialize(async () => {
      const debtors = await readColl<any>('debtors');
      const norm = (s: string) => s.trim().toLowerCase();
      let idx = debtors.findIndex((d: any) => norm(d.name) === norm(inv.clientName));
      if (idx === -1) {
        debtors.push({ id: uuid(), name: inv.clientName.trim(), phone: inv.clientPhone || '', payments: [], invoices: [], autoCreated: true, created_at: nowIso() });
        idx = debtors.length - 1;
      }
      if (!Array.isArray(debtors[idx].invoices)) debtors[idx].invoices = [];
      debtors[idx].invoices.push({ id: item.id, invoiceNumber: item.invoiceNumber, date: item.date, amount: item.total, status: 'unpaid' });
      await writeColl('debtors', debtors);
    });
  }
  return item;
}
export async function updateInvoice(id: string, inv: any) {
  return serialize(async () => {
    const items = await readColl<any>('invoices');
    const idx = items.findIndex((x: any) => x.id === id);
    if (idx !== -1) {
      items[idx] = { ...items[idx], ...inv };
      await writeColl('invoices', items);
    }
    const debtors = await readColl<any>('debtors');
    let debtorChanged = false;
    for (const d of debtors) {
      if (Array.isArray(d.ledger)) {
        for (const entry of d.ledger) {
          if (entry.invoiceId === id || entry.ref === id || entry.id === id) {
            if (inv.date) entry.date = inv.date;
            if (inv.total != null || inv.amount != null) {
              const newAmt = Number(inv.total ?? inv.amount);
              entry.amount = newAmt;
              entry.debit = newAmt;
            }
            debtorChanged = true;
          }
        }
      }
    }
    if (debtorChanged) await writeColl('debtors', debtors);
    return idx !== -1 ? items[idx] : inv;
  });
}
export async function deleteInvoice(id: string) {
  await serialize(async () => {
    const items = await readColl<any>('invoices');
    await writeColl('invoices', items.filter((x: any) => x.id !== id));
  });
  // Remove the invoice reference from any debtor's ledger. If that leaves an
  // auto-created debtor completely empty (no invoices, no payments), remove the
  // stray debtor too — otherwise deleting an invoice left a ghost customer with
  // no entries and no way to delete it.
  await serialize(async () => {
    const debtors = await readColl<any>('debtors');
    let changed = false;
    for (const d of debtors) {
      if (Array.isArray(d.invoices) && d.invoices.some((i: any) => i.id === id)) {
        d.invoices = d.invoices.filter((i: any) => i.id !== id);
        changed = true;
      }
    }
    const pruned = debtors.filter(
      (d: any) => !(d.autoCreated && (d.invoices || []).length === 0 && (d.payments || []).length === 0),
    );
    if (changed || pruned.length !== debtors.length) await writeColl('debtors', pruned);
  });
  return { ok: true };
}
export async function markInvoicePaid(id: string) {
  const invoices = await readColl<any>('invoices');
  const inv = invoices.find((i: any) => i.id === id);
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'paid') return inv;

  // Find the debtor linked to this invoice (by name match).
  const debtors = await readColl<any>('debtors');
  const debtor = debtors.find((d: any) =>
    (d.invoices || []).some((i: any) => i.id === id)
  );

  // Route through createReceipt which handles:
  //   receipt record + cash entry IN + debtor payment + invoice status sync
  return createReceipt({
    mode: 'against_invoice',
    date: new Date().toISOString().slice(0, 10),
    amount: inv.total,
    debtorId: debtor?.id || null,
    clientName: inv.clientName,
    allocations: [{ invoiceId: id, amountApplied: inv.total }],
    notes: `Invoice ${inv.invoiceNumber} paid`,
  });
}
export async function overdueInvoices() {
  const today = new Date().toISOString().slice(0, 10);
  const all = await readColl<any>('invoices');
  return all.filter((inv: any) => inv.status === 'unpaid' && inv.dueDate && inv.dueDate < today);
}

// ---------- Receipts (money actually received) ----------
// A receipt is the settlement counterpart to an invoice. Three modes:
//   cash_sale       — walk-in paid on the spot; no prior invoice. Also creates a
//                     `sales` revenue record so cash sales show in revenue/P&L.
//   against_invoice — settles one or more outstanding invoices (full or partial)
//                     via allocations[]; posts a payment onto the debtor ledger.
//   advance         — money received before an invoice exists; sits as a credit
//                     on the debtor until later allocated.
// EVERY receipt writes a Cash Book IN row, so money received always reaches cash.
export type ReceiptMode = 'cash_sale' | 'against_invoice' | 'advance';

export async function listReceipts() {
  return (await readColl<any>('receipts')).sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

/** Total already received against an invoice, summed across all receipt allocations. */
export async function invoicePaidAmount(invoiceId: string): Promise<number> {
  const receipts = await readColl<any>('receipts');
  let paid = 0;
  for (const r of receipts) {
    for (const a of (r.allocations || [])) {
      if (a.invoiceId === invoiceId) paid += toUsd(a.amountApplied);
    }
  }
  return +paid.toFixed(2);
}

/** Derive an invoice's status from what's been received against it. */
function deriveInvoiceStatus(total: number, paid: number): 'unpaid' | 'partial' | 'paid' {
  const t = +toUsd(total).toFixed(2);
  const p = +toUsd(paid).toFixed(2);
  if (p <= 0) return 'unpaid';
  if (p + 0.005 >= t) return 'paid';
  return 'partial';
}

/** Recompute + persist status for the given invoice ids (and their debtor refs). */
async function syncInvoiceStatuses(invoiceIds: string[]) {
  if (!invoiceIds.length) return;
  const receipts = await readColl<any>('receipts');
  const paidByInv: Record<string, number> = {};
  for (const r of receipts) {
    for (const a of (r.allocations || [])) {
      paidByInv[a.invoiceId] = (paidByInv[a.invoiceId] || 0) + toUsd(a.amountApplied);
    }
  }
  const invoices = await readColl<any>('invoices');
  let invChanged = false;
  for (const inv of invoices) {
    if (!invoiceIds.includes(inv.id)) continue;
    const status = deriveInvoiceStatus(inv.total, paidByInv[inv.id] || 0);
    if (inv.status !== status) {
      inv.status = status;
      inv.paidAt = status === 'paid' ? nowIso() : undefined;
      invChanged = true;
    }
  }
  if (invChanged) await writeColl('invoices', invoices);
  // Mirror status onto the debtor's invoice refs so statements read correctly.
  const debtors = await readColl<any>('debtors');
  let debChanged = false;
  for (const d of debtors) {
    for (const ref of (d.invoices || [])) {
      if (invoiceIds.includes(ref.id)) {
        const status = deriveInvoiceStatus(ref.amount, paidByInv[ref.id] || 0);
        if (ref.status !== status) { ref.status = status; debChanged = true; }
      }
    }
  }
  if (debChanged) await writeColl('debtors', debtors);
}

export async function createReceipt(r: {
  mode: ReceiptMode;
  date: string;
  amount: number;
  debtorId?: string | null;
  clientName?: string;
  allocations?: { invoiceId: string; amountApplied: number }[];
  lines?: { description: string; qty: number; rate: number }[];
  taxRate?: number;
  method?: string;
  notes?: string;
}) {
  const amt = Number(r.amount);
  if (!Number.isFinite(amt) || amt < 0) throw new Error('Receipt amount must be a valid non-negative number.');
  const allocations = Array.isArray(r.allocations) ? r.allocations.filter((a) => a && a.invoiceId) : [];
  const allocTotal = allocations.reduce((s, a) => s + toUsd(a.amountApplied), 0);
  if (allocTotal - amt > 0.005) throw new Error('Allocated amount exceeds the receipt total.');

  // Step 1: create the receipt record with its own RCPT-#### series.
  const receipt = await serialize(async () => {
    const items = await readColl<any>('receipts');
    const maxSeq = items.reduce((m: number, it: any) => {
      const match = /RCPT-(\d+)/.exec(it.receiptNumber || '');
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const taxRate = Number(r.taxRate) || 0;
    const taxAmount = taxRate > 0 ? +(amt - amt / (1 + taxRate / 100)).toFixed(2) : 0;
    const item = {
      id: uuid(),
      receiptNumber: `RCPT-${String(maxSeq + 1).padStart(4, '0')}`,
      mode: r.mode,
      date: r.date,
      amount: +amt.toFixed(2),
      debtorId: r.debtorId || null,
      clientName: (r.clientName || '').trim(),
      allocations,
      lines: Array.isArray(r.lines) ? r.lines : [],
      taxRate,
      taxAmount,
      method: r.method || 'cash',
      notes: r.notes || '',
      created_at: nowIso(),
    };
    items.push(item);
    await writeColl('receipts', items);
    return item;
  });

  // Step 2: record where the money landed in cash.
  //  - cash_sale: handled via the `sales` record in Step 3 (dashboard cash already
  //    derives from sales), so writing a Cash Book row too would double-count.
  //  - against_invoice / advance: invoice revenue isn't in `sales`, so we post a
  //    Cash Book IN row here — this is the bridge that makes received money reach cash.
  if (r.mode !== 'cash_sale') {
    await serialize(async () => {
      const cash = await readColl<any>('cashEntries');
      cash.push({
        id: uuid(), amount: +amt.toFixed(2), direction: 'in', date: r.date,
        notes: `Receipt ${receipt.receiptNumber}${receipt.clientName ? ` — ${receipt.clientName}` : ''}`,
        receiptId: receipt.id, created_at: nowIso(),
      });
      await writeColl('cashEntries', cash);
    });
  }

  // Step 3: cash sale → also record revenue in `sales`.
  if (r.mode === 'cash_sale') {
    await serialize(async () => {
      const sales = await readColl<any>('sales');
      sales.push({ id: uuid(), amount: +amt.toFixed(2), date: r.date, receiptId: receipt.id, notes: `Cash sale ${receipt.receiptNumber}`, created_at: nowIso() });
      await writeColl('sales', sales);
    });
  }

  // Step 4: against_invoice / advance → post payment onto the debtor ledger.
  if ((r.mode === 'against_invoice' || r.mode === 'advance') && r.debtorId) {
    await serialize(async () => {
      const debtors = await readColl<any>('debtors');
      const idx = debtors.findIndex((d: any) => d.id === r.debtorId);
      if (idx !== -1) {
        debtors[idx].payments = [...(debtors[idx].payments || []), {
          id: uuid(), amount: +amt.toFixed(2), date: r.date,
          notes: r.mode === 'advance' ? `Advance ${receipt.receiptNumber}` : `Receipt ${receipt.receiptNumber}`,
          receiptId: receipt.id, created_at: nowIso(),
        }];
        await writeColl('debtors', debtors);
      }
    });
  }

  // Step 5: recompute status of any invoices this receipt settled.
  await syncInvoiceStatuses(allocations.map((a) => a.invoiceId));
  return receipt;
}

export async function updateReceipt(id: string, patch: any) {
  const existing = (await readColl<any>('receipts')).find((item: any) => item.id === id);
  if (!existing) throw new Error('Receipt not found');
  const replacement = {
    ...existing,
    ...patch,
    mode: patch.mode || existing.mode,
    amount: patch.amount ?? existing.amount,
    date: patch.date || existing.date,
    allocations: patch.allocations ?? existing.allocations,
    lines: patch.lines ?? existing.lines,
  };
  await deleteReceipt(id);
  try {
    return await createReceipt(replacement);
  } catch (error) {
    try { await createReceipt(existing); } catch { /* preserve the edit failure */ }
    throw error;
  }
}

export async function deleteReceipt(id: string) {
  const receipts = await readColl<any>('receipts');
  const receipt = receipts.find((x: any) => x.id === id);
  if (!receipt) return { ok: true };
  const affectedInvoices = (receipt.allocations || []).map((a: any) => a.invoiceId);

  await serialize(async () => {
    await writeColl('receipts', (await readColl<any>('receipts')).filter((x: any) => x.id !== id));
  });
  // Reverse the Cash Book row, the cash-sale revenue row, and the debtor payment.
  await serialize(async () => {
    await writeColl('cashEntries', (await readColl<any>('cashEntries')).filter((c: any) => c.receiptId !== id));
  });
  await serialize(async () => {
    await writeColl('sales', (await readColl<any>('sales')).filter((s: any) => s.receiptId !== id));
  });
  await serialize(async () => {
    const debtors = await readColl<any>('debtors');
    let changed = false;
    for (const d of debtors) {
      if (Array.isArray(d.payments) && d.payments.some((p: any) => p.receiptId === id)) {
        d.payments = d.payments.filter((p: any) => p.receiptId !== id);
        changed = true;
      }
    }
    if (changed) await writeColl('debtors', debtors);
  });
  await syncInvoiceStatuses(affectedInvoices);
  return { ok: true };
}

// ---------- Advances / Deposits ----------
// An advance is a receipt with mode 'advance' whose money was already taken in
// (cash row + debtor payment) at receive time, but which is NOT yet tied to any
// invoice. Its allocations[] start empty; the UNALLOCATED remainder is the
// customer's advance CREDIT. Later we "apply" that credit to an invoice by
// appending an allocation to the SAME advance receipt — this does NOT move cash
// again (that already happened); it only ties the money to the invoice so the
// invoice status derives to partial/paid.

/** How much advance credit a customer still has available (received but unallocated). */
export async function getAdvanceCredit(debtorId: string): Promise<number> {
  const receipts = await readColl<any>('receipts');
  let credit = 0;
  for (const r of receipts) {
    if (r.mode !== 'advance' || r.debtorId !== debtorId) continue;
    const allocated = (r.allocations || []).reduce((s: number, a: any) => s + toUsd(a.amountApplied), 0);
    credit += toUsd(r.amount) - allocated;
  }
  return +credit.toFixed(2);
}

/** List a customer's advance receipts with their remaining (unapplied) amount. */
export async function listAdvances(debtorId: string) {
  const receipts = await readColl<any>('receipts');
  return receipts
    .filter((r: any) => r.mode === 'advance' && r.debtorId === debtorId)
    .map((r: any) => {
      const allocated = (r.allocations || []).reduce((s: number, a: any) => s + toUsd(a.amountApplied), 0);
      return { ...r, allocated: +allocated.toFixed(2), remaining: +(toUsd(r.amount) - allocated).toFixed(2) };
    })
    .sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

/**
 * Apply a customer's existing advance credit to an invoice. Draws from that
 * customer's advance receipts (oldest first) up to `amount` (defaults to the
 * lesser of available credit and the invoice's open balance). Appends allocations
 * to the advance receipts — NO new cash/debtor-payment is created (the money was
 * already received when the advance was taken).
 */
export async function applyAdvanceToInvoice(debtorId: string, invoiceId: string, amount?: number) {
  const invoices = await readColl<any>('invoices');
  const inv = invoices.find((i: any) => i.id === invoiceId);
  if (!inv) throw new Error('Invoice not found');
  const alreadyPaid = await invoicePaidAmount(invoiceId);
  const open = +(toUsd(inv.total) - alreadyPaid).toFixed(2);
  if (open <= 0) throw new Error('This invoice is already fully paid.');
  const credit = await getAdvanceCredit(debtorId);
  if (credit <= 0) throw new Error('This customer has no advance credit to apply.');

  let toApply = amount != null ? +Number(amount).toFixed(2) : Math.min(credit, open);
  toApply = Math.min(toApply, credit, open);
  if (toApply <= 0) throw new Error('Nothing to apply.');

  await serialize(async () => {
    const receipts = await readColl<any>('receipts');
    // Advance receipts for this debtor, oldest first, that still have remaining credit.
    const advances = receipts
      .filter((r: any) => r.mode === 'advance' && r.debtorId === debtorId)
      .sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let remaining = toApply;
    for (const r of advances) {
      if (remaining <= 0) break;
      const allocated = (r.allocations || []).reduce((s: number, a: any) => s + toUsd(a.amountApplied), 0);
      const avail = +(toUsd(r.amount) - allocated).toFixed(2);
      if (avail <= 0) continue;
      const take = Math.min(avail, remaining);
      r.allocations = [...(r.allocations || []), { invoiceId, amountApplied: +take.toFixed(2) }];
      remaining = +(remaining - take).toFixed(2);
    }
    await writeColl('receipts', receipts);
  });
  await syncInvoiceStatuses([invoiceId]);
  return { ok: true, applied: toApply };
}


// ---------- Quotes / Estimates ----------
// A quote is a NON-POSTING proposal: it has no ledger effect (no revenue, no
// debtor, no cash) until it is CONVERTED into an invoice. Statuses:
//   draft | sent | accepted | expired | converted
// On convert we call createInvoice (which does all the debtor wiring) and stamp
// the quote with convertedInvoiceId so it can't be converted twice.
export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'expired' | 'converted';

export async function listQuotes() {
  return (await readColl<any>('quotes')).sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

export async function createQuote(q: {
  clientName: string;
  clientPhone?: string;
  date: string;
  validUntil?: string;
  lines: { description: string; qty: number; rate: number }[];
  taxRate?: number;
  taxLabel?: string;
  notes?: string;
  status?: QuoteStatus;
}) {
  return serialize(async () => {
    const items = await readColl<any>('quotes');
    const maxSeq = items.reduce((m: number, it: any) => {
      const match = /QUO-(\d+)/.exec(it.quoteNumber || '');
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const lines = Array.isArray(q.lines) ? q.lines : [];
    const sub = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
    const taxRate = Number(q.taxRate) || 0;
    const total = +(sub + sub * taxRate / 100).toFixed(2);
    const item = {
      id: uuid(),
      quoteNumber: `QUO-${String(maxSeq + 1).padStart(4, '0')}`,
      clientName: (q.clientName || '').trim(),
      clientPhone: q.clientPhone || '',
      date: q.date,
      validUntil: q.validUntil || '',
      lines,
      taxRate,
      taxLabel: q.taxLabel || '',
      notes: q.notes || '',
      total,
      status: q.status || 'draft',
      convertedInvoiceId: null,
      created_at: nowIso(),
    };
    items.push(item);
    await writeColl('quotes', items);
    return item;
  });
}

export async function updateQuote(id: string, q: any) {
  return serialize(async () => {
    const items = await readColl<any>('quotes');
    const idx = items.findIndex((x: any) => x.id === id);
    if (idx === -1) throw new Error('Quote not found');
    // Recompute total if lines/tax changed.
    const merged = { ...items[idx], ...q };
    if (q.lines || q.taxRate !== undefined) {
      const lines = Array.isArray(merged.lines) ? merged.lines : [];
      const sub = lines.reduce((s: number, l: any) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
      const taxRate = Number(merged.taxRate) || 0;
      merged.total = +(sub + sub * taxRate / 100).toFixed(2);
    }
    items[idx] = merged;
    await writeColl('quotes', items);
    return items[idx];
  });
}

export async function deleteQuote(id: string) {
  return serialize(async () => {
    const items = await readColl<any>('quotes');
    await writeColl('quotes', items.filter((x: any) => x.id !== id));
    return { ok: true };
  });
}

/** Set a quote's status (draft/sent/accepted/expired). Convert uses convertQuoteToInvoice. */
export async function setQuoteStatus(id: string, status: QuoteStatus) {
  return updateQuote(id, { status });
}

/**
 * Convert an accepted quote into a real invoice. Idempotent-guarded: a quote that
 * already has convertedInvoiceId throws, so the same quote can't post twice.
 *
 * [Finding B] The invoice MUST be created through the authoritative write path so
 * the converted invoice lands in the V2 ledger (dashboard/reports/party detail),
 * not just the legacy collection. The api layer injects a `createInvoiceFn` that
 * routes through the V2 write router (the same one the invoices screen uses); when
 * omitted (no SQLite runner / legacy-only callers) we fall back to the legacy
 * createInvoice so behavior is unchanged off the V2 path. The returned invoice is
 * normalized to always expose `id` and `total` regardless of which path built it.
 */
export async function convertQuoteToInvoice(
  id: string,
  opts?: { date?: string; dueDate?: string },
  createInvoiceFn?: (payload: any) => Promise<any>,
) {
  const quotes = await readColl<any>('quotes');
  const q = quotes.find((x: any) => x.id === id);
  if (!q) throw new Error('Quote not found');
  if (q.convertedInvoiceId) throw new Error('This quote has already been converted to an invoice.');

  const payload = {
    clientName: q.clientName,
    clientPhone: q.clientPhone,
    date: opts?.date || new Date().toISOString().slice(0, 10),
    dueDate: opts?.dueDate,
    lines: q.lines,
    taxRate: q.taxRate,
    taxLabel: q.taxLabel,
    total: q.total,
    notes: q.notes ? `${q.notes} (from ${q.quoteNumber})` : `From ${q.quoteNumber}`,
  };

  // createInvoiceFn (V2 write router) does the ledger + legacy mirror; the bare
  // legacy createInvoice does the debtor find-or-create + ledger wiring.
  const created = createInvoiceFn ? await createInvoiceFn(payload) : await createInvoice(payload);
  // Normalize: the V2 router returns { source, journal }; legacy returns the invoice row.
  const invoiceId = created?.id || created?.source?.id;
  const total = created?.total ?? Number(created?.source?.metadata?.total ?? q.total);

  await updateQuote(id, { status: 'converted', convertedInvoiceId: invoiceId });
  return { ...created, id: invoiceId, total };
}

// ---------- Credit / Debit Notes ----------
// A CREDIT note reduces what a customer owes (sales return, overcharge, or a
// post-sale DISCOUNT given later). A DEBIT note increases it (extra charge,
// under-billing). Both are tied to a debtor (and optionally a specific invoice).
// They post NO cash — they are pure receivable adjustments — and are folded into
// the debtor balance/statement (see listDebtors / getDebtorStatement) and, for a
// credit note, reduce accrual revenue in dashboard/pnlRange.
export type NoteReason = 'discount' | 'return' | 'correction' | 'other';

async function createNote(coll: 'creditNotes' | 'debitNotes', prefix: string, n: {
  debtorId: string;
  invoiceId?: string | null;
  clientName?: string;
  date: string;
  amount: number;
  taxRate?: number;
  reason?: NoteReason;
  notes?: string;
  role?: 'customer' | 'supplier';
}) {
  const amt = Number(n.amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Note amount must be a valid positive number.');
  // [Finding A] The party field is required; name it correctly per role so the
  // supplier screen no longer surfaces a "customer is required" message.
  if (!n.debtorId) throw new Error(`A ${n.role === 'supplier' ? 'supplier' : 'customer'} is required for the note.`);
  return serialize(async () => {
    const items = await readColl<any>(coll);
    const maxSeq = items.reduce((m: number, it: any) => {
      const match = new RegExp(`${prefix}-(\\d+)`).exec(it.noteNumber || '');
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const taxRate = Number(n.taxRate) || 0;
    const taxAmount = taxRate > 0 ? +(amt - amt / (1 + taxRate / 100)).toFixed(2) : 0;
    const item = {
      id: uuid(),
      noteNumber: `${prefix}-${String(maxSeq + 1).padStart(4, '0')}`,
      debtorId: n.debtorId,
      invoiceId: n.invoiceId || null,
      clientName: (n.clientName || '').trim(),
      date: n.date,
      amount: +amt.toFixed(2),
      taxRate,
      taxAmount,
      reason: n.reason || 'other',
      notes: n.notes || '',
      created_at: nowIso(),
    };
    items.push(item);
    await writeColl(coll, items);
    return item;
  });
}

export async function listCreditNotes(debtorId?: string) {
  const items = await readColl<any>('creditNotes');
  const filtered = debtorId ? items.filter((c: any) => c.debtorId === debtorId) : items;
  return filtered.sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}
export async function listDebitNotes(debtorId?: string) {
  const items = await readColl<any>('debitNotes');
  const filtered = debtorId ? items.filter((c: any) => c.debtorId === debtorId) : items;
  return filtered.sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}
export async function createCreditNote(n: Parameters<typeof createNote>[2]) {
  return createNote('creditNotes', 'CN', n);
}
export async function createDebitNote(n: Parameters<typeof createNote>[2]) {
  return createNote('debitNotes', 'DN', n);
}
export async function deleteCreditNote(id: string) {
  return serialize(async () => {
    await writeColl('creditNotes', (await readColl<any>('creditNotes')).filter((x: any) => x.id !== id));
    return { ok: true };
  });
}
export async function deleteDebitNote(id: string) {
  return serialize(async () => {
    await writeColl('debitNotes', (await readColl<any>('debitNotes')).filter((x: any) => x.id !== id));
    return { ok: true };
  });
}

// ---------- Delivery Notes / Challans ----------
// A delivery note (challan) documents GOODS MOVEMENT — items handed over to a
// customer — when the value/invoice follows separately. It posts NOTHING to the
// ledger (no revenue, no cash, no receivable): it is a movement record only,
// often legally required to transport goods (e.g. under GST). Optionally links
// to an invoice once one is raised. Status: pending | delivered.
export type DeliveryStatus = 'pending' | 'delivered';

export async function listDeliveryNotes() {
  return (await readColl<any>('deliveryNotes')).sort((a: any, b: any) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}
export async function createDeliveryNote(n: {
  clientName: string;
  clientPhone?: string;
  debtorId?: string | null;
  invoiceId?: string | null;
  date: string;
  items: { description: string; qty: number }[];
  vehicleNo?: string;
  status?: DeliveryStatus;
  notes?: string;
}) {
  if (!n.clientName || !n.clientName.trim()) throw new Error('A customer name is required.');
  return serialize(async () => {
    const items = await readColl<any>('deliveryNotes');
    const maxSeq = items.reduce((m: number, it: any) => {
      const match = /DC-(\d+)/.exec(it.noteNumber || '');
      return match ? Math.max(m, parseInt(match[1], 10)) : m;
    }, 0);
    const item = {
      id: uuid(),
      noteNumber: `DC-${String(maxSeq + 1).padStart(4, '0')}`,
      clientName: n.clientName.trim(),
      clientPhone: n.clientPhone || '',
      debtorId: n.debtorId || null,
      invoiceId: n.invoiceId || null,
      date: n.date,
      items: Array.isArray(n.items) ? n.items.filter((i) => i.description || i.qty) : [],
      vehicleNo: n.vehicleNo || '',
      status: n.status || 'pending',
      notes: n.notes || '',
      created_at: nowIso(),
    };
    items.push(item);
    await writeColl('deliveryNotes', items);
    return item;
  });
}
export async function updateDeliveryNote(id: string, n: any) {
  return serialize(async () => {
    const items = await readColl<any>('deliveryNotes');
    const idx = items.findIndex((x: any) => x.id === id);
    if (idx === -1) throw new Error('Delivery note not found');
    items[idx] = { ...items[idx], ...n };
    await writeColl('deliveryNotes', items);
    return items[idx];
  });
}
export async function deleteDeliveryNote(id: string) {
  return serialize(async () => {
    await writeColl('deliveryNotes', (await readColl<any>('deliveryNotes')).filter((x: any) => x.id !== id));
    return { ok: true };
  });
}

// ---------- Enhanced reports ----------

/**
 * Tax report (GST/VAT) for a date range. Output tax = tax collected on invoices
 * (accrual) or on receipts (cash), plus cash-sale receipt tax, minus tax reversed
 * by credit notes, plus tax added by debit notes. Input tax on purchases is shown
 * separately (bills don't carry a tax split today, so it's a best-effort estimate
 * using the settings taxRate). Net = output − input.
 */
export async function taxReport(from: string, to: string) {
  const s = await getSettings();
  const inRange = (d: string) => (d || '').slice(0, 10) >= from && (d || '').slice(0, 10) <= to;
  const [invoices, receipts, creditNotes, debitNotes, bills] = await Promise.all([
    readColl<any>('invoices'), readColl<any>('receipts'), readColl<any>('creditNotes'), readColl<any>('debitNotes'), readColl<any>('bills'),
  ]);
  const taxOf = (gross: number, rate: number) => rate > 0 ? +(gross - gross / (1 + rate / 100)).toFixed(2) : 0;

  const isAccrual = s.accountingBasis === 'accrual';
  // Output tax source depends on basis.
  let outputBase = 0, outputTax = 0;
  if (isAccrual) {
    for (const i of invoices.filter((x: any) => inRange(x.date))) {
      const rate = Number(i.taxRate) || 0;
      outputBase += toUsd(i.total); outputTax += taxOf(toUsd(i.total), rate);
    }
  } else {
    for (const r of receipts.filter((x: any) => inRange(x.date))) {
      const rate = Number(r.taxRate) || 0;
      outputBase += toUsd(r.amount); outputTax += taxOf(toUsd(r.amount), rate || Number(s.taxRate) || 0);
    }
  }
  // Credit notes reduce output tax; debit notes add to it.
  let cnTax = 0, dnTax = 0;
  for (const c of creditNotes.filter((x: any) => inRange(x.date))) cnTax += toUsd(c.taxAmount) || taxOf(toUsd(c.amount), Number(c.taxRate) || Number(s.taxRate) || 0);
  for (const c of debitNotes.filter((x: any) => inRange(x.date))) dnTax += toUsd(c.taxAmount) || taxOf(toUsd(c.amount), Number(c.taxRate) || Number(s.taxRate) || 0);
  const netOutputTax = +(outputTax - cnTax + dnTax).toFixed(2);

  // Input tax (best-effort): assume bills are tax-inclusive at the standard rate.
  const rate = Number(s.taxRate) || 0;
  let inputBase = 0, inputTax = 0;
  for (const b of bills.filter((x: any) => inRange(x.date))) {
    inputBase += toUsd(b.amount); inputTax += taxOf(toUsd(b.amount), rate);
  }
  return {
    from, to, taxLabel: s.taxLabel || 'Tax', taxRate: rate, basis: isAccrual ? 'accrual' : 'cash',
    outputBase: +outputBase.toFixed(2), outputTax: +outputTax.toFixed(2),
    creditNoteTax: +cnTax.toFixed(2), debitNoteTax: +dnTax.toFixed(2),
    netOutputTax,
    inputBase: +inputBase.toFixed(2), inputTax: +inputTax.toFixed(2),
    netTaxPayable: +(netOutputTax - inputTax).toFixed(2),
  };
}

/**
 * Sales register: every revenue document in the range (cash sales, invoices) with
 * totals, so the user has a line-by-line list of what was sold.
 */
export async function salesRegister(from: string, to: string) {
  const inRange = (d: string) => (d || '').slice(0, 10) >= from && (d || '').slice(0, 10) <= to;
  const [sales, invoices] = await Promise.all([readColl<any>('sales'), readColl<any>('invoices')]);
  const rows: any[] = [];
  for (const x of sales.filter((s: any) => inRange(s.date))) {
    rows.push({ date: (x.date || '').slice(0, 10), type: 'Cash Sale', ref: x.notes || '', party: '', amount: +toUsd(x.amount).toFixed(2) });
  }
  for (const i of invoices.filter((x: any) => inRange(x.date))) {
    rows.push({ date: (i.date || '').slice(0, 10), type: 'Invoice', ref: i.invoiceNumber || '', party: i.clientName || '', amount: +toUsd(i.total).toFixed(2), status: i.status });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const total = +rows.reduce((s, r) => s + r.amount, 0).toFixed(2);
  const cashTotal = +rows.filter((r) => r.type === 'Cash Sale').reduce((s, r) => s + r.amount, 0).toFixed(2);
  const invoiceTotal = +rows.filter((r) => r.type === 'Invoice').reduce((s, r) => s + r.amount, 0).toFixed(2);
  return { from, to, rows, total, cashTotal, invoiceTotal, count: rows.length };
}

/**
 * Receipts register: all money actually received in the range, grouped by method
 * (cash/card/bank/upi) and mode — a simple collections/cash-in view.
 */
export async function receiptsRegister(from: string, to: string) {
  const inRange = (d: string) => (d || '').slice(0, 10) >= from && (d || '').slice(0, 10) <= to;
  const receipts = (await readColl<any>('receipts')).filter((r: any) => inRange(r.date));
  const rows = receipts.map((r: any) => ({
    date: (r.date || '').slice(0, 10), ref: r.receiptNumber || '', party: r.clientName || 'Walk-in',
    mode: r.mode, method: r.method || 'cash', amount: +toUsd(r.amount).toFixed(2),
  })).sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byMethod: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  for (const r of rows) {
    byMethod[r.method] = +((byMethod[r.method] || 0) + r.amount).toFixed(2);
    byMode[r.mode] = +((byMode[r.mode] || 0) + r.amount).toFixed(2);
  }
  const total = +rows.reduce((s: number, r: any) => s + r.amount, 0).toFixed(2);
  return { from, to, rows, byMethod, byMode, total, count: rows.length };
}
