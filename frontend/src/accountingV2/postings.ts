import { V2_ACCOUNT_CODES, type V2PaymentMethod, type V2Source } from './types';
import { V2SqlRepository } from './repository';

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cents = (n: number) => Math.round(Number(n) * 100) / 100;
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

export async function postCashSale(repo: V2SqlRepository, input: { bookId: string; periodId: string; date: string; amount: number; method?: V2PaymentMethod; reference?: string }) {
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  const method = input.method || 'cash';
  const source: V2Source = { id: uid('cash_sale'), bookId: input.bookId, type: 'cash_sale', date: input.date, reference: input.reference, metadata: { total: amount, method } };
  const journal = await repo.postSourceJournal(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Cash sale', lines: [
    { accountId: `${input.bookId}:account:${paymentCode(method)}`, debit: amount, credit: 0 },
    { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: amount },
  ] });
  return { source, journal };
}

export async function postInvoice(repo: V2SqlRepository, input: { bookId: string; periodId: string; partyId: string; date: string; amount: number; reference?: string }) {
  const amount = cents(input.amount); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  await customer(repo, input.bookId, input.partyId);
  const source: V2Source = { id: uid('invoice'), bookId: input.bookId, type: 'invoice', date: input.date, reference: input.reference, metadata: { partyId: input.partyId, total: amount, status: 'unpaid' } };
  const journal = await repo.postSourceJournal(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Credit sale invoice', lines: [
    { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: amount, credit: 0 },
    { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: amount },
  ] });
  return { source, journal };
}

export async function postReceipt(repo: V2SqlRepository, input: { bookId: string; periodId: string; partyId: string; date: string; amount: number; method: V2PaymentMethod; reference?: string; allocations?: { invoiceSourceId: string; amount: number }[] }) {
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
  const advance = cents(amount - allocated); const source: V2Source = { id: uid('receipt'), bookId: input.bookId, type: 'receipt', date: input.date, reference: input.reference, metadata: { partyId: input.partyId, total: amount, method: input.method, allocated, advance } };
  const lines: any[] = [{ accountId: `${input.bookId}:account:${paymentCode(input.method)}`, partyId: input.partyId, debit: amount, credit: 0 }];
  if (allocated) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: 0, credit: allocated });
  if (advance) lines.push({ accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.CUSTOMER_ADVANCES}`, partyId: input.partyId, debit: 0, credit: advance });
  const allocations = requested.map((a) => ({ id: uid('alloc'), bookId: input.bookId, invoiceSourceId: a.invoiceSourceId, receiptSourceId: source.id, amount: cents(a.amount), allocatedAt: input.date }));
  const journal = await repo.postSourceJournalWithAllocations(source, { bookId: input.bookId, periodId: input.periodId, date: input.date, memo: 'Customer receipt', lines }, allocations);
  return { source, journal, allocated, advance };
}

export async function postPurchase(repo: V2SqlRepository, input: { bookId:string; periodId:string; partyId:string; date:string; amount:number; method?:V2PaymentMethod }) {
  const amount=cents(input.amount); if(!Number.isFinite(amount)||amount<=0) throw new Error('Amount must be positive'); await partyWithRole(repo,input.bookId,input.partyId,'supplier');
  const source:V2Source={id:uid(input.method?'cash_purchase':'credit_purchase'),bookId:input.bookId,type:input.method?'cash_purchase':'credit_purchase',date:input.date,metadata:{partyId:input.partyId,total:amount,method:input.method}};
  const journal=await repo.postSourceJournal(source,{bookId:input.bookId,periodId:input.periodId,date:input.date,memo:'Purchase',lines:[{accountId:`${input.bookId}:account:${V2_ACCOUNT_CODES.INVENTORY}`,partyId:input.partyId,debit:amount,credit:0},{accountId:`${input.bookId}:account:${input.method?paymentCode(input.method):V2_ACCOUNT_CODES.AP}`,partyId:input.partyId,debit:0,credit:amount}]}); return {source,journal};
}
export async function postSupplierPayment(repo:V2SqlRepository,input:{bookId:string;periodId:string;partyId:string;date:string;amount:number;method:V2PaymentMethod}){
 const amount=cents(input.amount);if(!Number.isFinite(amount)||amount<=0)throw new Error('Amount must be positive');await partyWithRole(repo,input.bookId,input.partyId,'supplier');const source:V2Source={id:uid('supplier_payment'),bookId:input.bookId,type:'supplier_payment',date:input.date,metadata:{partyId:input.partyId,total:amount,method:input.method}};const journal=await repo.postSourceJournal(source,{bookId:input.bookId,periodId:input.periodId,date:input.date,memo:'Supplier payment',lines:[{accountId:`${input.bookId}:account:${V2_ACCOUNT_CODES.AP}`,partyId:input.partyId,debit:amount,credit:0},{accountId:`${input.bookId}:account:${paymentCode(input.method)}`,debit:0,credit:amount}]});return{source,journal};
}
export async function postExpense(repo:V2SqlRepository,input:{bookId:string;periodId:string;date:string;amount:number;method:V2PaymentMethod}){const amount=cents(input.amount);if(!Number.isFinite(amount)||amount<=0)throw new Error('Amount must be positive');const source:V2Source={id:uid('expense'),bookId:input.bookId,type:'expense',date:input.date,metadata:{total:amount,method:input.method}};const journal=await repo.postSourceJournal(source,{bookId:input.bookId,periodId:input.periodId,date:input.date,memo:'Expense',lines:[{accountId:`${input.bookId}:account:${V2_ACCOUNT_CODES.EXPENSES}`,debit:amount,credit:0},{accountId:`${input.bookId}:account:${paymentCode(input.method)}`,debit:0,credit:amount}]});return{source,journal};}
async function note(repo: V2SqlRepository, input: { bookId:string; periodId:string; partyId:string; invoiceSourceId:string; date:string; amount:number }, kind: 'credit_note'|'debit_note') {
  const amount = cents(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be positive');
  await customer(repo, input.bookId, input.partyId);
  const inv = await repo.db.first<{ metadata:string }>("SELECT metadata FROM v2_sources WHERE id=? AND book_id=? AND type='invoice'", [input.invoiceSourceId, input.bookId]);
  const meta = inv ? JSON.parse(inv.metadata) : {};
  if (meta.partyId !== input.partyId) throw new Error('Invoice does not belong to customer');
  const source: V2Source = { id: uid(kind), bookId: input.bookId, type: kind, date: input.date, metadata: { partyId: input.partyId, invoiceSourceId: input.invoiceSourceId, total: amount } };
  const credit = kind === 'credit_note';
  const journal = await repo.postSourceJournal(source, {
    bookId: input.bookId, periodId: input.periodId, date: input.date, memo: kind,
    lines: credit ? [
      { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES_RETURNS}`, debit: amount, credit: 0 },
      { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: 0, credit: amount },
    ] : [
      { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.AR}`, partyId: input.partyId, debit: amount, credit: 0 },
      { accountId: `${input.bookId}:account:${V2_ACCOUNT_CODES.SALES}`, debit: 0, credit: amount },
    ],
  });
  return { source, journal };
}
export const postCreditNote = (repo: V2SqlRepository, input: any) => note(repo, input, 'credit_note');
export const postDebitNote = (repo: V2SqlRepository, input: any) => note(repo, input, 'debit_note');
