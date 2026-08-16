import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';

async function setup() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, { book: { id: 'marketplace_book', name: 'Marketplace Book', style: 'standard', basis: 'accrual' }, personas: ['dropshipper'], period: { startDate: '2026-07-01', endDate: '2026-07-31' } });
  return { ...node, service: new V2AppService(node.runner) };
}

describe('marketplace vertical domain', () => {
  it('posts an order, refund, RTO fee, settlement, and reconciliation variance through V2 journals', async () => {
    const { runner, close, service } = await setup();
    try {
      const order = await service.createMarketplaceOrder({ platform: 'Shopify', externalOrderId: 'ORD-1', date: '2026-07-10', gross: 100, tax: 10, marketplaceFee: 8, shippingFee: 5, currency: 'USD', settlementId: 'SET-1' });
      expect(order.net).toBe(87);
      expect(await runner.first('SELECT COUNT(*) AS count FROM v2_journal_entries WHERE source_id=?', [order.id])).toEqual({ count: 1 });
      const refund = await service.recordMarketplaceRefund({ orderId: order.id, date: '2026-07-11', amount: 20 });
      expect(refund.kind).toBe('refund');
      const rto = await service.recordMarketplaceRto({ orderId: order.id, date: '2026-07-12', fee: 4 });
      expect(rto.kind).toBe('rto');
      const settlement = await service.createMarketplaceSettlement({ platform: 'Shopify', settlementId: 'SET-1', date: '2026-07-13', payout: 63, currency: 'USD' });
      expect(settlement.payout).toBe(63);
      const reconciliation = await service.reconcileMarketplaceSettlement('Shopify', 'SET-1');
      expect(reconciliation.orderCount).toBe(1);
      expect(reconciliation.expectedPayout).toBe(63);
      expect(reconciliation.variance).toBe(0);
      expect((await runner.first<{ difference: number }>(`SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) AS difference FROM v2_journal_entries j JOIN v2_journal_lines l ON l.journal_id=j.id WHERE j.book_id=?`, ['marketplace_book']))?.difference).toBe(0);
    } finally { close(); }
  });

  it('rejects duplicate external order IDs and duplicate settlement IDs', async () => {
    const { close, service } = await setup();
    try {
      await service.createMarketplaceOrder({ platform: 'Amazon', externalOrderId: 'ORD-1', date: '2026-07-10', gross: 50 });
      await expect(service.createMarketplaceOrder({ platform: 'Amazon', externalOrderId: 'ORD-1', date: '2026-07-10', gross: 50 })).rejects.toThrow(/already exists/i);
      await service.createMarketplaceSettlement({ platform: 'Amazon', settlementId: 'SET-1', date: '2026-07-13', payout: 50 });
      await expect(service.createMarketplaceSettlement({ platform: 'Amazon', settlementId: 'SET-1', date: '2026-07-13', payout: 50 })).rejects.toThrow(/already exists/i);
    } finally { close(); }
  });
});
