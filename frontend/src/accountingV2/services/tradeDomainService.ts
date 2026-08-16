import type { SqlRunner } from '../../db/schema';
import { round2 } from '../../money';
import { V2SqlRepository } from '../repository';
import { V2_ACCOUNT_CODES } from '../types';
import type { V2ActiveContext } from '../appService';

type ShipmentInput = { reference: string; date: string; direction: 'import' | 'export'; supplierId?: string; customerId?: string; currency?: string; exchangeRate?: number; goodsValue?: number; notes?: string };
type LandedCostInput = { shipmentId: string; date: string; kind: string; amount: number; currency?: string; exchangeRate?: number; capitalized?: boolean; method?: 'cash' | 'bank' | 'ap'; notes?: string };
type FxRemeasurementInput = { date: string; accountCode?: string; amount: number; gainLoss: 'gain' | 'loss'; currency?: string; exchangeRate?: number; reference?: string; notes?: string };

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const money = (value: unknown) => round2(Number.isFinite(Number(value)) ? Number(value) : 0);
const required = (value: unknown, label: string) => { const normalized = String(value || '').trim(); if (!normalized) throw new Error(`${label} is required`); return normalized; };
const positive = (value: unknown, label: string) => { const normalized = money(value); if (normalized <= 0) throw new Error(`${label} must be greater than zero`); return normalized; };

export class TradeDomainService {
  constructor(private readonly db: SqlRunner, private readonly repo: V2SqlRepository, private readonly context: (date?: string) => Promise<V2ActiveContext | null>) {}

  private async account(bookId: string, code: string) {
    const row = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=? AND active=1', [bookId, code]);
    if (!row) throw new Error(`Required trade account ${code} is missing from this book`);
    return row.id;
  }

  async createShipment(input: ShipmentInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const reference = required(input.reference, 'Shipment reference');
    const direction = input.direction === 'export' ? 'export' : 'import';
    const goodsValue = money(input.goodsValue);
    if (goodsValue < 0) throw new Error('Shipment goods value cannot be negative');
    const exchangeRate = money(input.exchangeRate) || 1;
    const currency = required(input.currency || 'USD', 'Shipment currency');
    const id = uid('shipment');
    const metadata = { direction, reference, goodsValue, currency, exchangeRate, notes: input.notes || null };
    await this.db.run('INSERT INTO v2_trade_shipments(id,book_id,reference,date,direction,supplier_id,customer_id,currency,exchange_rate,goods_value,landed_cost,status,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, context.bookId, reference, input.date, direction, input.supplierId || null, input.customerId || null, currency, exchangeRate, goodsValue, 0, 'open', JSON.stringify(metadata)]);
    return { id, bookId: context.bookId, reference, date: input.date, direction, currency, exchangeRate, goodsValue, landedCost: 0, status: 'open' };
  }

  async addLandedCost(input: LandedCostInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const shipment = await this.db.first<{ id: string; reference: string; currency: string; exchange_rate: number; status: string }>('SELECT id,reference,currency,exchange_rate,status FROM v2_trade_shipments WHERE id=? AND book_id=?', [input.shipmentId, context.bookId]);
    if (!shipment) throw new Error('Trade shipment was not found');
    if (shipment.status === 'closed') throw new Error('Closed shipments cannot receive landed costs');
    const kind = required(input.kind, 'Landed-cost type');
    const amount = positive(input.amount, 'Landed cost');
    const rate = money(input.exchangeRate) || 1;
    const functionalAmount = money(amount * rate);
    const capitalized = input.capitalized !== false;
    const sourceId = uid('landed_cost');
    const method = input.method || 'cash';
    await this.repo.ensureDefaultAccounts(context.bookId);
    const debitCode = capitalized ? V2_ACCOUNT_CODES.INVENTORY : (kind.toLocaleLowerCase().includes('duty') ? V2_ACCOUNT_CODES.DUTIES_EXPENSE : V2_ACCOUNT_CODES.FREIGHT_EXPENSE);
    const creditCode = method === 'bank' ? V2_ACCOUNT_CODES.BANK : method === 'ap' ? V2_ACCOUNT_CODES.AP : V2_ACCOUNT_CODES.CASH;
    const debit = await this.account(context.bookId, debitCode);
    const credit = await this.account(context.bookId, creditCode);
    const metadata = { shipmentId: shipment.id, reference: shipment.reference, kind, amount, currency: input.currency || shipment.currency, exchangeRate: rate, functionalAmount, capitalized, method, notes: input.notes || null };
    return this.repo.runInTransaction(async () => {
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: capitalized ? 'landed_cost_capitalized' : 'trade_cost', date: input.date, reference: shipment.reference, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: `${capitalized ? 'Capitalized landed cost' : 'Trade cost'}: ${kind}`, lines: [{ accountId: debit, debit: functionalAmount, credit: 0, memo: capitalized ? 'Landed cost added to inventory' : `${kind} expense` }, { accountId: credit, debit: 0, credit: functionalAmount, memo: 'Landed cost settlement' }] });
      const id = uid('trade_cost');
      await this.db.run('INSERT INTO v2_trade_costs(id,shipment_id,book_id,date,kind,amount,currency,exchange_rate,capitalized,source_id,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id, shipment.id, context.bookId, input.date, kind, amount, input.currency || shipment.currency, rate, capitalized ? 1 : 0, sourceId, JSON.stringify(metadata)]);
      await this.db.run('UPDATE v2_trade_shipments SET landed_cost=landed_cost+? WHERE id=? AND book_id=?', [functionalAmount, shipment.id, context.bookId]);
      return { id, sourceId, journal, shipmentId: shipment.id, kind, amount, functionalAmount, capitalized, method };
    });
  }

  async recordFxRemeasurement(input: FxRemeasurementInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const amount = positive(input.amount, 'FX remeasurement');
    const rate = money(input.exchangeRate) || 1;
    const functionalAmount = money(amount * rate);
    const counterCode = required(input.accountCode || V2_ACCOUNT_CODES.AP, 'FX counter-account code');
    const sourceId = uid('fx_remeasurement');
    await this.repo.ensureDefaultAccounts(context.bookId);
    const counter = await this.account(context.bookId, counterCode);
    const fx = await this.account(context.bookId, V2_ACCOUNT_CODES.FX_GAIN_LOSS);
    const gain = input.gainLoss === 'gain';
    const metadata = { accountCode: counterCode, amount, currency: input.currency || 'USD', exchangeRate: rate, functionalAmount, gainLoss: gain ? 'gain' : 'loss', reference: input.reference || null, notes: input.notes || null };
    const lines = gain
      ? [{ accountId: counter, debit: functionalAmount, credit: 0, memo: 'Foreign-currency balance remeasurement' }, { accountId: fx, debit: 0, credit: functionalAmount, memo: 'FX gain' }]
      : [{ accountId: fx, debit: functionalAmount, credit: 0, memo: 'FX loss' }, { accountId: counter, debit: 0, credit: functionalAmount, memo: 'Foreign-currency balance remeasurement' }];
    const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: 'fx_remeasurement', date: input.date, reference: input.reference, metadata }, { bookId: context.bookId, periodId: context.periodId, date: input.date, memo: `FX ${gain ? 'gain' : 'loss'} remeasurement`, lines });
    return { id: sourceId, sourceId, journal, gainLoss: gain ? 'gain' : 'loss', amount, functionalAmount, accountCode: counterCode };
  }

  async listShipments() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) return [];
    return this.db.all('SELECT * FROM v2_trade_shipments WHERE book_id=? ORDER BY date DESC', [active.value]);
  }

  async listTradeCosts(shipmentId?: string) {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) return [];
    return shipmentId
      ? this.db.all('SELECT * FROM v2_trade_costs WHERE book_id=? AND shipment_id=? ORDER BY date DESC', [active.value, shipmentId])
      : this.db.all('SELECT * FROM v2_trade_costs WHERE book_id=? ORDER BY date DESC', [active.value]);
  }
}

export type { ShipmentInput, LandedCostInput, FxRemeasurementInput };
