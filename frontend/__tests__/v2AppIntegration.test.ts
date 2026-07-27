import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService, createAppWriteRouter } from '../src/accountingV2/appService';

describe('V2 application write integration', () => {
  async function setup() {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: 'active-v2', name: 'Active V2' },
      period: { id: 'open-2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    return { ...node, service: new V2AppService(node.runner) };
  }

  it('routes normal sale, invoice, receipt, bill, payment, and expense payloads to V2 sources and journals', async () => {
    const { runner, close, service } = await setup();
    try {
      const sale = await service.createSale({ date: '2026-07-01', amount: '12.50', method: 'card', notes: 'counter' });
      const invoice = await service.createInvoice({ date: '2026-07-02', total: 40, clientName: ' Alice  ', clientPhone: '123', invoiceNumber: 'INV-X' });
      const partyId = String(invoice.source.metadata?.partyId);
      const receipt = await service.createReceipt({ date: '2026-07-03', amount: 15, debtorId: partyId, method: 'bank', allocations: [{ invoiceId: invoice.source.id, amountApplied: 15 }] });
      const bill = await service.createBill({ date: '2026-07-04', amount: 30, supplierId: 'supplier-1', supplierName: 'Supply Co', paymentType: 'credit' });
      const payment = await service.createPayment({ date: '2026-07-05', amount: 10, supplierId: 'supplier-1', supplierName: 'Supply Co', type: 'supplier_payment', method: 'mobile' });
      const expense = await service.createExpense({ date: '2026-07-06', amount: 7, method: 'cash', category: 'Travel' });

      expect([sale, invoice, receipt, bill, payment, expense].map((x) => x.source.type)).toEqual([
        'cash_sale', 'invoice', 'receipt', 'credit_purchase', 'supplier_payment', 'expense',
      ]);
      expect(await runner.all('SELECT type FROM v2_sources ORDER BY date')).toEqual([
        { type: 'cash_sale' }, { type: 'invoice' }, { type: 'receipt' },
        { type: 'credit_purchase' }, { type: 'supplier_payment' }, { type: 'expense' },
      ]);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(6);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_invoice_allocations'))?.n)).toBe(1);
      expect(await runner.first('SELECT id,roles FROM v2_parties WHERE id=?', [partyId])).toEqual({ id: partyId, roles: '["customer"]' });
      expect(await runner.first('SELECT id,roles FROM v2_parties WHERE id=?', ['supplier-1'])).toEqual({ id: 'supplier-1', roles: '["supplier"]' });
    } finally { close(); }
  });

  it('selects the active versioned V2 book and its open period for the posting date', async () => {
    const { runner, close, service } = await setup();
    try {
      await expect(service.createSale({ date: '2027-01-01', amount: 1 })).rejects.toThrow(/open accounting period/i);
      await runner.run("UPDATE meta SET value='1' WHERE key='v2_book_version:active-v2'");
      await expect(service.activeContext('2026-07-01')).resolves.toBeNull();
    } finally { close(); }
  });

  it('uses V2 authoritatively when active and calls legacy only when no versioned V2 book is active', async () => {
    const { runner, close, service } = await setup();
    const legacy = { createSale: jest.fn(async (payload) => ({ legacy: payload })) };
    const router = createAppWriteRouter(service, legacy);
    try {
      const result = await router.createSale({ date: '2026-07-01', amount: 9 });
      expect(result.source.type).toBe('cash_sale');
      expect(legacy.createSale).not.toHaveBeenCalled();
      await runner.run("DELETE FROM meta WHERE key='v2_active_book_id'");
      await expect(router.createSale({ date: '2026-07-01', amount: 9 })).resolves.toEqual({ legacy: { date: '2026-07-01', amount: 9 } });
      expect(legacy.createSale).toHaveBeenCalledTimes(1);
    } finally { close(); }
  });
});
