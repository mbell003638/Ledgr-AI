import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';

async function setup() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, { book: { id: 'manufacturing_trade_book', name: 'Manufacturing Trade Book', style: 'standard', basis: 'accrual' }, personas: ['manufacturer', 'import_export'], period: { startDate: '2026-07-01', endDate: '2026-07-31' } });
  return { ...node, service: new V2AppService(node.runner) };
}

describe('manufacturing and trade vertical domains', () => {
  it('consumes components, moves cost through WIP, and receives finished goods', async () => {
    const { runner, close, service } = await setup();
    try {
      await runner.run('INSERT INTO v2_products(id,book_id,sku,name,unit,cost,price,qty,archived) VALUES(?,?,?,?,?,?,?,?,0)', ['raw-1', 'manufacturing_trade_book', 'RAW-1', 'Raw Material', 'unit', 3, 5, 10]);
      await runner.run('INSERT INTO v2_products(id,book_id,sku,name,unit,cost,price,qty,archived) VALUES(?,?,?,?,?,?,?,?,0)', ['fg-1', 'manufacturing_trade_book', 'FG-1', 'Finished Product', 'unit', 0, 12, 0]);
      const bom = await service.createBom({ productId: 'fg-1', name: 'Finished Product BOM', version: '1' });
      await service.addBomLine({ bomId: bom.id, componentProductId: 'raw-1', quantity: 1, unitCost: 3 });
      const order = await service.createProductionOrder({ bomId: bom.id, date: '2026-07-10', quantity: 2 });
      expect(order.totalCost).toBe(6);
      expect((await runner.first<{ qty: number; cost: number }>('SELECT qty,cost FROM v2_products WHERE id=?', ['raw-1']))).toEqual({ qty: 8, cost: 3 });
      expect((await runner.first<{ qty: number; cost: number }>('SELECT qty,cost FROM v2_products WHERE id=?', ['fg-1']))).toEqual({ qty: 2, cost: 3 });
      expect((await runner.first<{ difference: number }>(`SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) AS difference FROM v2_journal_entries j JOIN v2_journal_lines l ON l.journal_id=j.id WHERE j.book_id=?`, ['manufacturing_trade_book']))?.difference).toBe(0);
    } finally { close(); }
  });

  it('capitalizes landed cost and posts explicit FX remeasurement', async () => {
    const { runner, close, service } = await setup();
    try {
      const shipment = await service.createTradeShipment({ reference: 'IMP-1', date: '2026-07-10', direction: 'import', currency: 'EUR', exchangeRate: 1.1, goodsValue: 100 });
      const landed = await service.addTradeLandedCost({ shipmentId: shipment.id, date: '2026-07-11', kind: 'freight', amount: 10, currency: 'EUR', exchangeRate: 1.1, capitalized: true, method: 'bank' });
      expect(landed.functionalAmount).toBe(11);
      expect((await runner.first<{ landed_cost: number }>('SELECT landed_cost FROM v2_trade_shipments WHERE id=?', [shipment.id]))?.landed_cost).toBe(11);
      const fx = await service.recordFxRemeasurement({ date: '2026-07-12', accountCode: '2000', amount: 5, currency: 'EUR', exchangeRate: 1.1, gainLoss: 'loss', reference: 'IMP-1' });
      expect(fx.gainLoss).toBe('loss');
      expect((await runner.first<{ difference: number }>(`SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) AS difference FROM v2_journal_entries j JOIN v2_journal_lines l ON l.journal_id=j.id WHERE j.book_id=?`, ['manufacturing_trade_book']))?.difference).toBe(0);
    } finally { close(); }
  });
});
