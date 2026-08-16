import type { SqlRunner } from '../../db/schema';
import { round2 } from '../../money';
import { V2SqlRepository } from '../repository';
import { V2_ACCOUNT_CODES } from '../types';
import type { V2ActiveContext } from '../appService';

type MarketplaceOrderInput = {
  platform: string;
  externalOrderId: string;
  date: string;
  status?: 'paid' | 'shipped' | 'delivered' | 'refunded' | 'rto';
  gross: number;
  tax?: number;
  marketplaceFee?: number;
  shippingFee?: number;
  refund?: number;
  rtoFee?: number;
  currency?: string;
  exchangeRate?: number;
  settlementId?: string;
  notes?: string;
};

type MarketplaceAdjustmentInput = {
  orderId: string;
  date: string;
  amount: number;
  fee?: number;
  notes?: string;
};

type SettlementInput = {
  platform: string;
  settlementId: string;
  date: string;
  payout: number;
  currency?: string;
  exchangeRate?: number;
  settlementAccountCode?: string;
  notes?: string;
};

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const amount = (value: unknown) => round2(Number.isFinite(Number(value)) ? Number(value) : 0);
const text = (value: unknown, fallback: string) => String(value || '').trim() || fallback;

export class MarketplaceDomainService {
  constructor(
    private readonly db: SqlRunner,
    private readonly repo: V2SqlRepository,
    private readonly context: (date?: string) => Promise<V2ActiveContext | null>,
  ) {}

  private async account(bookId: string, code: string) {
    const row = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=? AND active=1', [bookId, code]);
    if (!row) throw new Error(`Required marketplace account ${code} is missing from this book`);
    return row.id;
  }

  async createOrder(input: MarketplaceOrderInput) {
    const platform = text(input.platform, 'Marketplace');
    const externalOrderId = text(input.externalOrderId, '');
    if (!externalOrderId) throw new Error('Marketplace order ID is required');
    const gross = amount(input.gross);
    if (gross <= 0) throw new Error('Marketplace order gross amount must be greater than zero');
    const tax = amount(input.tax);
    const fee = amount(input.marketplaceFee);
    const shipping = amount(input.shippingFee);
    const refund = amount(input.refund);
    const rtoFee = amount(input.rtoFee);
    const rate = amount(input.exchangeRate) || 1;
    const currency = text(input.currency, 'USD');
    if (tax > gross) throw new Error('Marketplace tax cannot exceed order gross amount');
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const existing = await this.db.first('SELECT id FROM v2_marketplace_orders WHERE book_id=? AND platform=? AND external_order_id=?', [context.bookId, platform, externalOrderId]);
    if (existing) throw new Error(`Marketplace order ${platform}/${externalOrderId} already exists`);
    const functional = (value: number) => amount(value * rate);
    const sourceId = uid('marketplace_order');
    const lines = [
      { accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.CARD), debit: functional(gross - fee - shipping - refund - rtoFee), credit: 0, memo: 'Marketplace clearing receivable' },
      ...(fee > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.MARKETPLACE_FEES), debit: functional(fee), credit: 0, memo: 'Marketplace commission and platform fees' }] : []),
      ...(shipping > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.SHIPPING_EXPENSE), debit: functional(shipping), credit: 0, memo: 'Marketplace shipping and fulfilment' }] : []),
      ...(refund > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.SALES_RETURNS), debit: functional(refund), credit: 0, memo: 'Marketplace customer refund' }] : []),
      ...(rtoFee > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.RETURNS_EXPENSE), debit: functional(rtoFee), credit: 0, memo: 'Marketplace return-to-origin fee' }] : []),
      { accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.SALES), debit: 0, credit: functional(gross - tax), memo: 'Marketplace merchandise revenue' },
      ...(tax > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.TAX_PAYABLE), debit: 0, credit: functional(tax), memo: 'Marketplace output tax' }] : []),
    ];
    const net = amount(gross - fee - shipping - refund - rtoFee);
    const metadata = { platform, externalOrderId, gross, tax, marketplaceFee: fee, shippingFee: shipping, refund, rtoFee, net, currency, exchangeRate: rate, settlementId: input.settlementId || null, notes: input.notes || null };
    return this.repo.runInTransaction(async () => {
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: 'marketplace_order', date: input.date, reference: externalOrderId, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: `Marketplace order ${platform} ${externalOrderId}`, lines });
      await this.db.run('INSERT INTO v2_marketplace_orders(id,book_id,platform,external_order_id,date,status,gross,tax,marketplace_fee,shipping_fee,refund,rto_fee,net,currency,exchange_rate,source_id,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [sourceId, context.bookId, platform, externalOrderId, input.date, input.status || (input.rtoFee ? 'rto' : 'paid'), gross, tax, fee, shipping, refund, rtoFee, net, currency, rate, sourceId, JSON.stringify(metadata)]);
      return { id: sourceId, journal, ...metadata, status: input.status || (input.rtoFee ? 'rto' : 'paid') };
    });
  }

  private async adjustOrder(input: MarketplaceAdjustmentInput, kind: 'refund' | 'rto') {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const order = await this.db.first<{ id: string; platform: string; external_order_id: string; currency: string; exchange_rate: number; status: string }>('SELECT id,platform,external_order_id,currency,exchange_rate,status FROM v2_marketplace_orders WHERE id=? AND book_id=?', [input.orderId, context.bookId]);
    if (!order) throw new Error('Marketplace order not found');
    if (kind === 'rto' && order.status === 'rto') throw new Error('Marketplace order is already marked RTO');
    const refund = kind === 'refund' ? amount(input.amount) : 0;
    const rtoFee = kind === 'rto' ? amount(input.fee) : 0;
    if (refund <= 0 && rtoFee <= 0) throw new Error('Refund or RTO adjustment must be greater than zero');
    const rate = amount(order.exchange_rate) || 1;
    const sourceId = uid(`marketplace_${kind}`);
    const lines = [
      ...(refund > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.SALES_RETURNS), debit: amount(refund * rate), credit: 0, memo: 'Marketplace order refund' }] : []),
      ...(rtoFee > 0 ? [{ accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.RETURNS_EXPENSE), debit: amount(rtoFee * rate), credit: 0, memo: 'Marketplace RTO fee' }] : []),
      { accountId: await this.account(context.bookId, V2_ACCOUNT_CODES.CARD), debit: 0, credit: amount((refund + rtoFee) * rate), memo: 'Marketplace clearing adjustment' },
    ];
    return this.repo.runInTransaction(async () => {
      const metadata = { orderId: order.id, platform: order.platform, externalOrderId: order.external_order_id, kind, amount: refund, fee: rtoFee, currency: order.currency, exchangeRate: rate, notes: input.notes || null };
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: `marketplace_${kind}`, date: input.date, reference: order.external_order_id, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: `${kind === 'rto' ? 'RTO' : 'Refund'} for marketplace order ${order.external_order_id}`, lines });
      await this.db.run('UPDATE v2_marketplace_orders SET status=?, refund=refund+?, rto_fee=rto_fee+?, net=net-? WHERE id=? AND book_id=?', [kind === 'rto' ? 'rto' : 'refunded', refund, rtoFee, refund + rtoFee, order.id, context.bookId]);
      return { id: sourceId, journal, ...metadata };
    });
  }

  recordRefund(input: MarketplaceAdjustmentInput) { return this.adjustOrder(input, 'refund'); }
  recordRto(input: MarketplaceAdjustmentInput) { return this.adjustOrder(input, 'rto'); }

  async createSettlement(input: SettlementInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const platform = text(input.platform, 'Marketplace');
    const settlementId = text(input.settlementId, '');
    if (!settlementId) throw new Error('Settlement ID is required');
    const payout = amount(input.payout);
    if (payout <= 0) throw new Error('Settlement payout must be greater than zero');
    const existing = await this.db.first('SELECT id FROM v2_marketplace_settlements WHERE book_id=? AND platform=? AND settlement_id=?', [context.bookId, platform, settlementId]);
    if (existing) throw new Error(`Settlement ${platform}/${settlementId} already exists`);
    const rate = amount(input.exchangeRate) || 1;
    const payoutFunctional = amount(payout * rate);
    const bank = await this.account(context.bookId, input.settlementAccountCode || V2_ACCOUNT_CODES.BANK);
    const clearing = await this.account(context.bookId, V2_ACCOUNT_CODES.CARD);
    const sourceId = uid('marketplace_settlement');
    const metadata = { platform, settlementId, payout, currency: text(input.currency, 'USD'), exchangeRate: rate, notes: input.notes || null };
    return this.repo.runInTransaction(async () => {
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: 'marketplace_settlement', date: input.date, reference: settlementId, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: `Marketplace settlement ${platform} ${settlementId}`, lines: [{ accountId: bank, debit: payoutFunctional, credit: 0, memo: 'Settlement payout received' }, { accountId: clearing, debit: 0, credit: payoutFunctional, memo: 'Marketplace clearing released' }] });
      await this.db.run('INSERT INTO v2_marketplace_settlements(id,book_id,platform,settlement_id,date,payout,currency,exchange_rate,settlement_account_id,source_id,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [sourceId, context.bookId, platform, settlementId, input.date, payout, metadata.currency, rate, bank, sourceId, JSON.stringify(metadata)]);
      return { id: sourceId, journal, ...metadata };
    });
  }

  async listOrders() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) return [];
    return this.db.all('SELECT * FROM v2_marketplace_orders WHERE book_id=? ORDER BY date DESC', [active.value]);
  }

  async listSettlements() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) return [];
    return this.db.all('SELECT * FROM v2_marketplace_settlements WHERE book_id=? ORDER BY date DESC', [active.value]);
  }

  async reconcileSettlement(platform: string, settlementId: string) {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) throw new Error('No active versioned V2 book');
    const settlement = await this.db.first<any>('SELECT * FROM v2_marketplace_settlements WHERE book_id=? AND platform=? AND settlement_id=?', [active.value, platform, settlementId]);
    if (!settlement) throw new Error('Marketplace settlement not found');
    const rows = await this.db.all<{ net: number }>("SELECT net FROM v2_marketplace_orders WHERE book_id=? AND platform=? AND json_extract(metadata,'$.settlementId')=?", [active.value, platform, settlementId]);
    const expectedPayout = round2(rows.reduce((sum, row) => sum + Number(row.net || 0), 0));
    return { settlement, orderCount: rows.length, expectedPayout, variance: round2(Number(settlement.payout || 0) - expectedPayout) };
  }
}
