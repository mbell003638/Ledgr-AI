import { V2Ledger } from './ledger';
import { V2_ACCOUNT_CODES, type V2PaymentMethod } from './types';

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const m = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const positive = (n: number, label = 'Amount') => { const v = m(n); if (!Number.isFinite(v) || v <= 0) throw new Error(`${label} must be positive`); return v; };

export class V2Documents {
  constructor(readonly ledger: V2Ledger) {}
  private account(bookId: string, code: string) {
    const a = this.ledger.store.accounts.find((x) => x.bookId === bookId && x.code === code);
    if (!a) throw new Error(`Missing account ${code}`); return a.id;
  }
  private paymentCode(method: V2PaymentMethod) { return method === 'cash' ? V2_ACCOUNT_CODES.CASH : method === 'bank' ? V2_ACCOUNT_CODES.BANK : method === 'card' ? V2_ACCOUNT_CODES.CARD : V2_ACCOUNT_CODES.MOBILE; }
  private source(bookId: string, type: string, date: string, metadata: Record<string, unknown> = {}) { const s = { id: uid(type), bookId, type, date, metadata }; this.ledger.store.sources.push(s); return s; }
  private assertParty(bookId: string, partyId: string, role: 'customer'|'supplier') { const p = this.ledger.store.parties.find((x) => x.id === partyId && x.bookId === bookId && x.roles.includes(role)); if (!p) throw new Error(`${role} party not found`); return p; }

  cashSale(bookId: string, periodId: string, date: string, amount: number, method: V2PaymentMethod = 'cash') {
    const total = positive(amount); const s = this.source(bookId, 'cash_sale', date, { total, method });
    const journal = this.ledger.post({ bookId, periodId, sourceId: s.id, date, memo: 'Cash sale', lines: [
      { accountId: this.account(bookId, this.paymentCode(method)), debit: total, credit: 0 },
      { accountId: this.account(bookId, V2_ACCOUNT_CODES.SALES), debit: 0, credit: total },
    ] }); return { source: s, journal };
  }

  invoice(bookId: string, periodId: string, partyId: string, date: string, amount: number) {
    this.assertParty(bookId, partyId, 'customer'); const total = positive(amount); const s = this.source(bookId, 'invoice', date, { total, partyId, status: 'unpaid' });
    const journal = this.ledger.post({ bookId, periodId, sourceId: s.id, date, memo: 'Credit sale invoice', lines: [
      { accountId: this.account(bookId, V2_ACCOUNT_CODES.AR), partyId, debit: total, credit: 0 },
      { accountId: this.account(bookId, V2_ACCOUNT_CODES.SALES), debit: 0, credit: total },
    ] }); return { source: s, journal };
  }

  invoicePaid(invoiceSourceId: string) { return m(this.ledger.store.allocations.filter((a) => a.invoiceSourceId === invoiceSourceId).reduce((s, a) => s + a.amount, 0)); }
  invoiceOpen(invoiceSourceId: string) { const inv = this.ledger.store.sources.find((s) => s.id === invoiceSourceId && s.type === 'invoice'); if (!inv) throw new Error('Invoice not found'); return m(Number(inv.metadata?.total) - this.invoicePaid(invoiceSourceId)); }

  receipt(bookId: string, periodId: string, partyId: string, date: string, amount: number, method: V2PaymentMethod, allocations: { invoiceSourceId: string; amount: number }[] = []) {
    this.assertParty(bookId, partyId, 'customer'); const total = positive(amount);
    let allocated = 0;
    for (const a of allocations) {
      const v = positive(a.amount, 'Allocation'); const inv = this.ledger.store.sources.find((s) => s.id === a.invoiceSourceId && s.bookId === bookId && s.type === 'invoice');
      if (!inv || inv.metadata?.partyId !== partyId) throw new Error('Allocation invoice does not belong to customer');
      if (v > this.invoiceOpen(a.invoiceSourceId) + 0.005) throw new Error('Allocation exceeds invoice open balance'); allocated = m(allocated + v);
    }
    if (allocated > total + 0.005) throw new Error('Allocations exceed receipt');
    const advance = m(total - allocated); const s = this.source(bookId, 'receipt', date, { total, partyId, method, allocated, advance });
    const lines: any[] = [{ accountId: this.account(bookId, this.paymentCode(method)), partyId, debit: total, credit: 0 }];
    if (allocated) lines.push({ accountId: this.account(bookId, V2_ACCOUNT_CODES.AR), partyId, debit: 0, credit: allocated });
    if (advance) lines.push({ accountId: this.account(bookId, V2_ACCOUNT_CODES.CUSTOMER_ADVANCES), partyId, debit: 0, credit: advance });
    const journal = this.ledger.post({ bookId, periodId, sourceId: s.id, date, memo: 'Customer receipt', lines });
    for (const a of allocations) this.ledger.store.allocations.push({ id: uid('alloc'), bookId, invoiceSourceId: a.invoiceSourceId, receiptSourceId: s.id, amount: m(a.amount), allocatedAt: date });
    return { source: s, journal, allocated, advance };
  }

  markInvoicePaid(bookId: string, periodId: string, invoiceSourceId: string, date: string, method: V2PaymentMethod = 'cash') {
    const inv = this.ledger.store.sources.find((s) => s.id === invoiceSourceId && s.bookId === bookId && s.type === 'invoice'); if (!inv) throw new Error('Invoice not found');
    const open = this.invoiceOpen(invoiceSourceId); if (open <= 0) throw new Error('Invoice already settled');
    return this.receipt(bookId, periodId, String(inv.metadata?.partyId), date, open, method, [{ invoiceSourceId, amount: open }]);
  }

  purchase(bookId: string, periodId: string, partyId: string, date: string, amount: number, method?: V2PaymentMethod) {
    this.assertParty(bookId, partyId, 'supplier'); const total = positive(amount); const s = this.source(bookId, method ? 'cash_purchase' : 'credit_purchase', date, { total, partyId, method });
    const creditAccount = method ? this.account(bookId, this.paymentCode(method)) : this.account(bookId, V2_ACCOUNT_CODES.AP);
    const journal = this.ledger.post({ bookId, periodId, sourceId: s.id, date, memo: method ? 'Cash purchase' : 'Credit purchase', lines: [
      { accountId: this.account(bookId, V2_ACCOUNT_CODES.INVENTORY), partyId, debit: total, credit: 0 },
      { accountId: creditAccount, partyId, debit: 0, credit: total },
    ] }); return { source: s, journal };
  }

  expense(bookId: string, periodId: string, date: string, amount: number, method: V2PaymentMethod = 'cash') {
    const total = positive(amount); const s = this.source(bookId, 'expense', date, { total, method });
    return { source: s, journal: this.ledger.post({ bookId, periodId, sourceId: s.id, date, memo: 'Operating expense', lines: [
      { accountId: this.account(bookId, V2_ACCOUNT_CODES.EXPENSES), debit: total, credit: 0 }, { accountId: this.account(bookId, this.paymentCode(method)), debit: 0, credit: total },
    ] }) };
  }

  drawing(bookId: string, periodId: string, partyId: string, date: string, amount: number, method: V2PaymentMethod = 'cash') {
    const total = positive(amount); const s = this.source(bookId, 'drawing', date, { total, partyId, method });
    return { source: s, journal: this.ledger.post({ bookId, periodId, sourceId: s.id, date, memo: 'Member drawing', lines: [
      { accountId: this.account(bookId, V2_ACCOUNT_CODES.DRAWINGS), partyId, debit: total, credit: 0 }, { accountId: this.account(bookId, this.paymentCode(method)), debit: 0, credit: total },
    ] }) };
  }
}
