import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { makeNodeRunner } from './helpers/nodeRunner';

describe('Phase 7 shared AR/AP location views', () => {
  it('filters party statements by location without duplicating AR or AP control accounts', async () => {
    const bookId = 'phase7-ar-ap-book';
    const periodId = 'phase7-ar-ap-period';
    const node = makeNodeRunner();
    try {
      await initializeV2Book(node.runner, {
        book: { id: bookId, name: 'AR AP locations' },
        period: { id: periodId, startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(node.runner);

      const legacyInvoice = await service.createInvoice({ date: '2026-01-02', clientName: 'Mixed Customer', amount: 25 });
      const legacyCustomerId = String((legacyInvoice.source.metadata as any)?.partyId);
      const legacyBill = await service.createBill({ date: '2026-01-03', supplierName: 'Mixed Supplier', amount: 15, paymentType: 'credit' });
      const legacySupplierId = String((legacyBill.source.metadata as any)?.partyId);

      const persona = await node.runner.first<{ id: string }>('SELECT id FROM v2_personas WHERE book_id=? AND active=1', [bookId]);
      await node.runner.run('UPDATE v2_personas SET config=? WHERE id=?', [JSON.stringify({ enabledCapabilities: ['multi_location', 'customers', 'procurement', 'invoicing'] }), persona!.id]);
      const shopA = await service.createLocation({ name: 'Shop A' });
      const shopB = await service.createLocation({ name: 'Shop B' });

      const shopAInvoice = await service.createInvoice({ date: '2026-01-04', clientName: 'Mixed Customer', amount: 100, locationId: shopA.id });
      await service.createInvoice({ date: '2026-01-05', clientName: 'Mixed Customer', amount: 200, locationId: shopB.id });
      await service.createBill({ date: '2026-01-06', supplierName: 'Mixed Supplier', amount: 40, paymentType: 'credit', locationId: shopA.id });
      await service.createBill({ date: '2026-01-07', supplierName: 'Mixed Supplier', amount: 60, paymentType: 'credit', locationId: shopB.id });

      const customerAll: any = await service.getPartyDetail(legacyCustomerId, 'customer');
      const customerA: any = await service.getPartyDetail(legacyCustomerId, 'customer', shopA.id);
      expect(customerAll.totalInvoiced).toBe(325);
      expect(customerA.totalInvoiced).toBe(100);
      expect(customerA.statement.ledger).toHaveLength(1);
      expect(customerA.statement.ledger[0].locationId).toBe(shopA.id);

      const supplierAll: any = await service.getPartyDetail(legacySupplierId, 'supplier');
      const supplierA: any = await service.getPartyDetail(legacySupplierId, 'supplier', shopA.id);
      expect(supplierAll.billsTotal).toBe(115);
      expect(supplierA.billsTotal).toBe(40);
      expect(supplierA.bills).toHaveLength(1);

      const arAccounts = await node.runner.all<any>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [bookId, '1100']);
      const apAccounts = await node.runner.all<any>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [bookId, '2000']);
      expect(arAccounts).toHaveLength(1);
      expect(apAccounts).toHaveLength(1);
    } finally {
      node.close();
    }
  });
});
