import { V2_ACCOUNT_CODES, type V2PaymentMethod, type V2Source } from './types';
import { V2SqlRepository } from './repository';
import { round2 } from '../money';
import { accountingRuntimeId as uid } from './runtimeIds';

const cents = round2;
function withLocation<T extends Record<string, unknown>>(metadata: T | undefined, locationId?: string): T & { locationId?: string } {
  return locationId ? { ...(metadata || {} as T), locationId } : (metadata || {} as T);
}

/**
 * Advance receipts a party still has unconsumed credit on, oldest first. A receipt's
 * remaining advance = its total minus every allocation already pointing at it (advance
 * applications add allocations until the receipt is fully consumed).
 */
async function unconsumedAdvances(repo: V2SqlRepository, bookId: string, partyId: string) {
  const rows = await repo.db.all<{ id: string; date: string; total: number; allocated: number }>(
    `SELECT s.id, s.date, CAST(json_extract(s.metadata,'$.total') AS REAL) AS total,
            COALESCE((SELECT SUM(a.amount) FROM v2_invoice_allocations a WHERE a.receipt_source_id = s.id), 0) AS allocated
     FROM v2_sources s
     WHERE s.book_id = ? AND s.type = 'receipt'
       AND json_extract(s.metadata,'$.partyId') = ?
       AND (json_extract(s.metadata,'$.reversed') IS NULL OR json_extract(s.metadata,'$.reversed') = 0)
       AND (json_extract(s.metadata,'$.deleted') IS NULL OR json_extract(s.metadata,'$.deleted') = 0)
     ORDER BY s.date, s.id`,
    [bookId, partyId],
  );
  return rows
    .map((r) => ({ id: r.id, date: r.date, remaining: cents(Number(r.total || 0) - Number(r.allocated || 0)) }))
    .filter((r) => r.remaining > 0.005);
}

/** Party's total unconsumed customer-advance credit (equals the 2100 balance for the party). */
async function customerAdvanceBalance(repo: V2SqlRepository, bookId: string, partyId: string) {
  const advances = await unconsumedAdvances(repo, bookId, partyId);
  return cents(advances.reduce((sum, a) => sum + a.remaining, 0));
}

/** Party's supplier-advance balance held in 1210 (debit-normal asset), by party. */
async function supplierAdvanceBalance(repo: V2SqlRepository, bookId: string, partyId: string) {
  const row = await repo.db.first<{ balance: number }>(
    `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS balance
     FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id = l.journal_id JOIN v2_accounts a ON a.id = l.account_id
     WHERE j.book_id = ? AND l.party_id = ? AND a.code = ?`,
    [bookId, partyId, V2_ACCOUNT_CODES.SUPPLIER_ADVANCES],
  );
  return cents(Number(row?.balance || 0));
}
const paymentCode = (method: V2PaymentMethod) => {
  if (method === 'cash') return V2_ACCOUNT_CODES.CASH;
  if (method === 'bank') return V2_ACCOUNT_CODES.BANK;
  if (method === 'card') return V2_ACCOUNT_CODES.CARD;
  if (method === 'mobile') return V2_ACCOUNT_CODES.MOBILE;
  throw new Error('Unsupported payment method');
};
async function partyWithRole(repo: V2SqlRepository, bookId: string, partyId: string, role: 'customer'|'supplier') {
  const row = await repo.db.first<{ roles: string }>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [partyId, bookId]);
  let roles: string[] = []; try { roles = row ? JSON.parse(row.roles) : []; } catch { roles = []; }
  if (!roles.includes(role)) throw new Error(`${role === 'customer' ? 'Customer' : 'Supplier'} party not found`);
}
async function customer(repo: V2SqlRepository, bookId: string, partyId: string) { return partyWithRole(repo, bookId, partyId, 'customer'); }
async function supplier(repo: V2SqlRepository, bookId: string, partyId: string) { return partyWithRole(repo, bookId, partyId, 'supplier'); }

export async function postCashSale(repo: V2SqlRepository, input: { bookId: string; periodId: string; date: string; amount: number; method?: V2PaymentMethod; reference?: string; metadata?: Record<string, unknown>; locationId?: string }) {
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  const method = input.method || 'cash';
  const tax = cents(Number(input.metadata?.tax || 0));
  const subtotal = tax > 0 && tax < amount ? cents(amount - tax) : amount;
  const source: V2Source = { id: uid('cash_sale'), bookId: input.bookId, type: 'cash_sale', date: input.date, reference: input.reference, locationId: input.locationId, metadata: withLocation({ total: amount, method, ...(input.metadata || {}) }, input.locationId) };
  const lines: any[] = [
    { accountId: `${input.bookId}:account:${paymentCode(method)}`, debit: amount, credit: 0 },
  ];
  if (tax > 0 && subtotal < amount) {
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: subtotal });
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.TAX_PAYABLE}`, debit: 0, credit: tax });
  } else {
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: amount });
  }
  const journal = await repo.postSourceJournal(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Cash sale', lines });
  return { source, journal };
}

export async function postInvoice(repo: V2SqlRepository, input: { bookId: string; periodId: string; partyId: string; date: string; amount: number; reference?: string; metadata?: Record<string, unknown>; locationId?: string }) {
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  await customer(repo, input.bookId, input.partyId);

  // [M1] Auto-apply any customer advance the party holds against this new invoice, so the
  // debtor balance and invoice paid-status are correct without a separate manual step.
  const available = await customerAdvanceBalance(repo, input.bookId, input.partyId);
  const applied = Math.min(available, amount);
  const advanceAllocations: { id: string; bookId: string; invoiceSourceId: string; receiptSourceId: string; amount: number; allocatedAt: string }[] = [];
  const sourceId = uid('invoice');
  if (applied > 0.005) {
    let remaining = applied;
    for (const advance of await unconsumedAdvances(repo, input.bookId, input.partyId)) {
      if (remaining <= 0.005) break;
      const take = cents(Math.min(advance.remaining, remaining));
      advanceAllocations.push({ id: uid('alloc'), bookId: input.bookId, invoiceSourceId: sourceId, receiptSourceId: advance.id, amount: take, allocatedAt: input.date });
      remaining = cents(remaining - take);
    }
  }
  const appliedTotal = cents(advanceAllocations.reduce((sum, a) => sum + a.amount, 0));
  const status = appliedTotal >= amount - 0.005 ? 'paid' : appliedTotal > 0 ? 'partial' : 'unpaid';
  const tax = cents(Number(input.metadata?.tax || 0));
  const subtotal = tax > 0 && tax < amount ? cents(amount - tax) : amount;
  const source: V2Source = { id: sourceId, bookId: input.bookId, type: 'invoice', date: input.date, reference: input.reference, locationId: input.locationId, metadata: withLocation({ ...(input.metadata || {}), partyId: input.partyId, total: amount, status, ...(appliedTotal > 0 ? { advanceApplied: appliedTotal } : {}) }, input.locationId) };
  const lines: any[] = [
    { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: amount, credit: 0 },
  ];
  if (tax > 0 && subtotal < amount) {
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: subtotal });
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.TAX_PAYABLE}`, debit: 0, credit: tax });
  } else {
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: amount });
  }
  if (appliedTotal > 0) {
    // Consume the advance: Dr Customer Advances (2100) / Cr AR (1100) for the applied amount.
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CUSTOMER_ADVANCES}`, partyId: input.partyId, debit: appliedTotal, credit: 0 });
    lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: 0, credit: appliedTotal });
  }
  const journalInput = { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Credit sale invoice', lines };
  const journal = appliedTotal > 0
    ? await repo.postSourceJournalWithAllocations(source, journalInput, advanceAllocations)
    : await repo.postSourceJournal(source, journalInput);
  return { source, journal, advanceApplied: appliedTotal, allocations: advanceAllocations };
}

export async function postReceipt(repo: V2SqlRepository, input: { bookId: string; periodId: string; partyId: string; date: string; amount: number; method: V2PaymentMethod; reference?: string; allocations?: { invoiceSourceId: string; amount: number }[]; metadata?: Record<string, unknown>; locationId?: string }) {
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  await customer(repo, input.bookId, input.partyId);
  const requested = input.allocations || []; const pending: Record<string, number> = {}; let allocated = 0;
  for (const item of requested) {
    const value = cents(item.amount); if (!Number.isFinite(value) || value <= 0) throw new Error('Allocation must be positive');
    const inv = await repo.db.first<{ book_id: string; metadata: string }>("SELECT book_id,metadata FROM v2_sources WHERE id=? AND type='invoice'", [item.invoiceSourceId]);
    let meta: any = {}; try { meta = inv ? JSON.parse(inv.metadata) : {}; } catch { /* invalid metadata rejected below */ }
    if (!inv || inv.book_id !== input.bookId || meta.partyId !== input.partyId) throw new Error('Allocation invoice does not belong to customer');
    pending[item.invoiceSourceId] = cents((pending[item.invoiceSourceId] || 0) + value);
    if (pending[item.invoiceSourceId] > await repo.invoiceOpen(item.invoiceSourceId) + 0.005) throw new Error('Allocation exceeds invoice open balance');
    allocated = cents(allocated + value);
  }
  if (allocated > amount + 0.005) throw new Error('Allocations exceed receipt');
  const advance = cents(amount - allocated); const source: V2Source = { id: uid('receipt'), bookId: input.bookId, type: 'receipt', date: input.date, reference: input.reference, locationId: input.locationId, metadata: withLocation({ ...(input.metadata || {}), partyId: input.partyId, total: amount, method: input.method, allocated, advance }, input.locationId) };
  const lines: any[] = [{ accountId: `${input.bookId}:account:${paymentCode(input.method)}`, partyId: input.partyId, debit: amount, credit: 0 }];
  if (allocated) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: 0, credit: allocated });
  if (advance) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CUSTOMER_ADVANCES}`, partyId: input.partyId, debit: 0, credit: advance });
  const allocations = requested.map((a) => ({ id: uid('alloc'), bookId: input.bookId, invoiceSourceId: a.invoiceSourceId, receiptSourceId: source.id, amount: cents(a.amount), allocatedAt: input.date }));
  const journal = await repo.postSourceJournalWithAllocations(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Customer receipt', lines }, allocations);
  return { source, journal, allocated, advance };
}

export async function postPurchase(repo: V2SqlRepository, input: { bookId:string; periodId:string; partyId:string; date:string; amount:number; method?:V2PaymentMethod; metadata?:Record<string, unknown>; locationId?: string }) {
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  await partyWithRole(repo, input.bookId, input.partyId, 'supplier');
  const type = input.method ? 'cash_purchase' : 'credit_purchase';
  // [M2] For CREDIT bills, apply any supplier advance (1210) the party holds: it settles
  // part of the new payable instead of leaving cash tied up in an advance.
  const applied = input.method ? 0 : Math.min(await supplierAdvanceBalance(repo, input.bookId, input.partyId), amount);
  const isExpense = Boolean(input.metadata?.isExpense === true || input.metadata?.billType === 'expense');
  const source: V2Source = { id: uid(type), bookId: input.bookId, type, date: input.date, locationId: input.locationId, metadata: withLocation({ partyId: input.partyId, total: amount, method: input.method, ...(applied > 0 ? { supplierAdvanceApplied: cents(applied) } : {}), ...(input.metadata || {}) }, input.locationId) };
  const debitCode = isExpense ? V2_ACCOUNT_CODES.EXPENSES : V2_ACCOUNT_CODES.INVENTORY;
  const lines: any[] = [{ accountId: `${input.bookId}:account:${debitCode}`, partyId: input.partyId, debit: amount, credit: 0 }];
  if (input.method) {
    lines.push({ accountId: `${input.bookId}:account:${paymentCode(input.method)}`, partyId: input.partyId, debit: 0, credit: amount });
  } else {
    if (applied > 0.005) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SUPPLIER_ADVANCES}`, partyId: input.partyId, debit: 0, credit: cents(applied) });
    const payable = cents(amount - applied);
    if (payable > 0.005) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AP}`, partyId: input.partyId, debit: 0, credit: payable });
  }
  const journal = await repo.postSourceJournal(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: isExpense ? 'Expense bill' : 'Purchase bill', lines });
  return { source, journal, supplierAdvanceApplied: cents(applied) };
}

export async function postSupplierPayment(repo:V2SqlRepository,input:{bookId:string;periodId:string;partyId:string;date:string;amount:number;method:V2PaymentMethod;metadata?:Record<string, unknown>;locationId?:string}){
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  await partyWithRole(repo, input.bookId, input.partyId, 'supplier');
  // [M2] Only settle up to the party's outstanding payable via AP; route any excess to a
  // supplier advance (1210) rather than driving Accounts Payable into a debit balance.
  const apRow = await repo.db.first<{ balance: number }>(
    `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS balance FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id = l.journal_id JOIN v2_accounts a ON a.id = l.account_id WHERE j.book_id = ? AND l.party_id = ? AND a.code = ?`,
    [input.bookId, input.partyId, V2_ACCOUNT_CODES.AP],
  );
  const payable = Math.max(0, cents(Number(apRow?.balance || 0)));
  const toAP = cents(Math.min(amount, payable));
  const advance = cents(amount - toAP);
  const source: V2Source = { id: uid('supplier_payment'), bookId: input.bookId, type: 'supplier_payment', date: input.date, locationId: input.locationId, metadata: withLocation({ ...(input.metadata || {}), partyId: input.partyId, total: amount, method: input.method, ...(advance > 0 ? { supplierAdvance: advance } : {}) }, input.locationId) };
  const lines: any[] = [];
  if (toAP > 0.005) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AP}`, partyId: input.partyId, debit: toAP, credit: 0 });
  if (advance > 0.005) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SUPPLIER_ADVANCES}`, partyId: input.partyId, debit: advance, credit: 0 });
  lines.push({ accountId: `${input.bookId}:account:${paymentCode(input.method)}`, debit: 0, credit: amount });
  const journal = await repo.postSourceJournal(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Supplier payment', lines });
  return { source, journal, supplierAdvance: advance };
}

const PERSONA_EXPENSE_ACCOUNT_CODES = new Set<string>([V2_ACCOUNT_CODES.EXPENSES, V2_ACCOUNT_CODES.COMMISSION_EXPENSE, V2_ACCOUNT_CODES.WAGES_EXPENSE, V2_ACCOUNT_CODES.DEPRECIATION_EXPENSE, V2_ACCOUNT_CODES.POS_VARIANCE, V2_ACCOUNT_CODES.ADVERTISING_EXPENSE, V2_ACCOUNT_CODES.SHIPPING_EXPENSE, V2_ACCOUNT_CODES.RETURNS_EXPENSE, V2_ACCOUNT_CODES.MARKETPLACE_FEES, V2_ACCOUNT_CODES.SOFTWARE_EXPENSE, V2_ACCOUNT_CODES.CREATOR_EXPENSE, V2_ACCOUNT_CODES.FREIGHT_EXPENSE, V2_ACCOUNT_CODES.DUTIES_EXPENSE, V2_ACCOUNT_CODES.MANUFACTURING_OVERHEAD, V2_ACCOUNT_CODES.FX_GAIN_LOSS]);
const expenseAccountCode = (value: unknown) => { const candidate = String(value || V2_ACCOUNT_CODES.EXPENSES); return PERSONA_EXPENSE_ACCOUNT_CODES.has(candidate) ? candidate : V2_ACCOUNT_CODES.EXPENSES; };

export async function postExpense(repo:V2SqlRepository,input:{bookId:string;periodId:string;date:string;amount:number;method:V2PaymentMethod;metadata?:Record<string, unknown>;locationId?:string}){const amount=cents(input.amount);if(!Number.isFinite(amount)||amount<=0)throw new Error('Amount must be positive');const source:V2Source={id:uid('expense'),bookId:input.bookId,type:'expense',date:input.date,locationId:input.locationId,metadata:withLocation({...(input.metadata||{}),accountCode:expenseAccountCode(input.metadata?.accountCode),total:amount,method:input.method},input.locationId)};const journal=await repo.postSourceJournal(source,{bookId:input.bookId,periodId:input.periodId,date:input.date,memo:String(input.metadata?.notes||input.metadata?.category||'Expense'),lines:[{accountId:`${input.bookId}:account:${expenseAccountCode(input.metadata?.accountCode)}`,debit:amount,credit:0},{accountId:`${input.bookId}:account:${paymentCode(input.method)}`,debit:0,credit:amount}]});return{source,journal};}

/**
 * [Finding A] Post a credit/debit note against a customer (AR) or supplier (AP).
 *
 * The invoice link is OPTIONAL: a note lowers/raises the party balance directly
 * against AR/AP, so a general (unlinked) discount/return still posts and shows on
 * the party statement. When an invoiceSourceId IS provided it is validated to
 * belong to the same party (as before), and recorded on the source metadata.
 *
 * Customer notes (role 'customer', account AR):
 *   - credit note  → DR Sales Returns, CR AR   (customer owes LESS — balance drops)
 *   - debit note   → DR AR, CR Sales           (customer owes MORE)
 * Supplier notes (role 'supplier', account AP):
 *   - credit note  → DR AP, CR Inventory/Expense (we owe the supplier LESS)
 *   - debit note   → DR Inventory/Expense, CR AP (we owe the supplier MORE)
 */
async function note(repo: V2SqlRepository, input: { bookId:string; periodId:string; partyId:string; invoiceSourceId?:string|null; date:string; amount:number; role?: 'customer'|'supplier'; reference?: string; reason?: string; notes?: string; method?: V2PaymentMethod; locationId?: string }, kind: 'credit_note'|'debit_note') {
  const amount = cents(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  const role = input.role === 'supplier' ? 'supplier' : 'customer';
  let isExpenseBill = false;
  if (role === 'supplier') {
    await supplier(repo, input.bookId, input.partyId);
    if (input.invoiceSourceId) {
      const bill = await repo.db.first<{ metadata: string }>("SELECT metadata FROM v2_sources WHERE id=? AND book_id=?", [input.invoiceSourceId, input.bookId]);
      const meta = bill ? JSON.parse(bill.metadata || '{}') : {};
      if (meta.isExpense === true || meta.billType === 'expense') isExpenseBill = true;
    }
  } else {
    await customer(repo, input.bookId, input.partyId);
    if (input.invoiceSourceId) {
      const inv = await repo.db.first<{ metadata:string }>("SELECT metadata FROM v2_sources WHERE id=? AND book_id=? AND type='invoice'", [input.invoiceSourceId, input.bookId]);
      const meta = inv ? JSON.parse(inv.metadata) : {};
      if (meta.partyId !== input.partyId) throw new Error('Invoice does not belong to customer');
    }
  }
  const reference = String(input.reference || '').trim() || undefined;
  const reason = String(input.reason || '').trim();
  const notes = String(input.notes || '').trim();
  const method = input.method;
  const payAccount = method ? paymentCode(method) : (role === 'supplier' ? V2_ACCOUNT_CODES.AP : V2_ACCOUNT_CODES.AR);
  const supplierAccount = isExpenseBill ? V2_ACCOUNT_CODES.EXPENSES : V2_ACCOUNT_CODES.INVENTORY;
  const source: V2Source = {
    id: uid(kind), bookId: input.bookId, type: kind, date: input.date, reference, locationId: input.locationId,
    metadata: withLocation({ partyId: input.partyId, invoiceSourceId: input.invoiceSourceId || null, role, total: amount, reason, notes, ...(method ? { method } : {}) }, input.locationId),
  };
  const credit = kind === 'credit_note';
  const lines = role === 'supplier'
    ? (credit ? [
        { accountId: `${input.bookId}:account:${payAccount}`, partyId: input.partyId, debit: amount, credit: 0 },
        { accountId: `${input.bookId}:account:${supplierAccount}`, debit: 0, credit: amount },
      ] : [
        { accountId: `${input.bookId}:account:${supplierAccount}`, debit: amount, credit: 0 },
        { accountId: `${input.bookId}:account:${payAccount}`, partyId: input.partyId, debit: 0, credit: amount },
      ])
    : (credit ? [
        { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES_RETURNS}`, debit: amount, credit: 0 },
        { accountId: `${input.bookId}:account:${payAccount}`, partyId: input.partyId, debit: 0, credit: amount },
      ] : [
        { accountId: `${input.bookId}:account:${payAccount}`, partyId: input.partyId, debit: amount, credit: 0 },
        { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: amount },
      ]);
  const journal = await repo.postSourceJournal(source, {
    bookId: input.bookId, periodId: input.periodId, date: input.date,
    memo: `${role === 'supplier' ? 'Supplier' : 'Customer'} ${kind.replace('_', ' ')}`, lines,
  });
  return { source, journal };
}
export const postCreditNote = (repo: V2SqlRepository, input: any) => note(repo, input, 'credit_note');
export const postDebitNote = (repo: V2SqlRepository, input: any) => note(repo, input, 'debit_note');
