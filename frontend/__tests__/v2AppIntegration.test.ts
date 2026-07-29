import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService, createAppWriteRouter, createAppMutationRouter } from '../src/accountingV2/appService';

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
      expect(legacy.createSale).toHaveBeenCalledTimes(1);
      await runner.run("DELETE FROM meta WHERE key='v2_active_book_id'");
      await expect(router.createSale({ date: '2026-07-01', amount: 9 })).resolves.toEqual({ legacy: { date: '2026-07-01', amount: 9 } });
      expect(legacy.createSale).toHaveBeenCalledTimes(2);
    } finally { close(); }
  });

  it('routes receipt delete and edit through the V2 document service at the app boundary', async () => {
    const { runner, close, service } = await setup();
    const legacy = { updateReceipt: jest.fn(), deleteReceipt: jest.fn(), markInvoicePaid: jest.fn() };
    const router = createAppMutationRouter(service, legacy);
    try {
      const receipt = await service.createReceipt({ date: '2026-07-03', amount: 15, debtorId: 'customer', clientName: 'Customer', method: 'cash' });
      const edited = await router.updateReceipt(receipt.source.id, { date: '2026-07-04', amount: 20, debtorId: 'customer', method: 'bank' });
      expect(edited.replacement.source.metadata.method).toBe('bank');
      expect(legacy.updateReceipt).toHaveBeenCalledTimes(1);
      await router.deleteReceipt(edited.replacement.source.id);
      expect(legacy.deleteReceipt).toHaveBeenCalledTimes(1);
      expect(await runner.first("SELECT json_extract(metadata,'$.deleted') AS deleted FROM v2_sources WHERE id=?", [edited.replacement.source.id])).toEqual({ deleted: 1 });
    } finally { close(); }
  });

  it('routes invoice mark-paid through V2 and posts the remaining balance', async () => {
    const { close, service } = await setup();
    const legacy = { markInvoicePaid: jest.fn() };
    const router = createAppMutationRouter(service, legacy);
    try {
      const invoice = await service.createInvoice({ date: '2026-07-02', total: 40, clientName: 'Customer', debtorId: 'customer' });
      const result = await router.markInvoicePaid(invoice.source.id, { date: '2026-07-05', method: 'bank' });
      expect(result.source.type).toBe('receipt');
      expect(legacy.markInvoicePaid).toHaveBeenCalledTimes(1);
      expect(await service.repo.invoiceOpen(invoice.source.id)).toBe(0);
    } finally { close(); }
  });

  it('routes cash sale edit/delete through V2 reversal and repost without legacy calls', async () => {
    const { runner, close, service } = await setup();
    const legacy = { updateSale: jest.fn(), deleteSale: jest.fn() };
    const router = createAppMutationRouter(service, legacy);
    try {
      const sale = await service.createSale({ date: '2026-07-10', amount: 25, method: 'card', notes: 'old' });
      const edited = await router.updateSale(sale.source.id, { date: '2026-07-11', amount: 40, method: 'bank', notes: 'new' });
      expect(edited.source.type).toBe('cash_sale');
      expect(edited.source.metadata).toMatchObject({ total: 40, method: 'bank', notes: 'new' });
      expect(legacy.updateSale).toHaveBeenCalledTimes(1);
      expect(await runner.first("SELECT json_extract(metadata,'$.reversed') AS reversed FROM v2_sources WHERE id=?", [sale.source.id])).toEqual({ reversed: 1 });
      await router.deleteSale(edited.source.id);
      expect(legacy.deleteSale).toHaveBeenCalledTimes(1);
      expect(await runner.first("SELECT json_extract(metadata,'$.deleted') AS deleted FROM v2_sources WHERE id=?", [edited.source.id])).toEqual({ deleted: 1 });
    } finally { close(); }
  });

  it('routes purchase/bill edit/delete through V2 reversal and repost', async () => {
    const { runner, close, service } = await setup();
    const legacy = { updateBill: jest.fn(), deleteBill: jest.fn() };
    const router = createAppMutationRouter(service, legacy);
    try {
      const bill = await service.createBill({ date: '2026-07-10', amount: 25, supplierId: 'supplier-1', supplierName: 'Supply Co', paymentType: 'cash', method: 'cash', invoiceNo: 'A', notes: 'old' });
      const edited = await router.updateBill(bill.source.id, { date: '2026-07-11', amount: 40, supplierId: 'supplier-1', supplierName: 'Supply Co', paymentType: 'credit', invoiceNo: 'B', notes: 'new' });
      expect(edited.source.type).toBe('credit_purchase');
      expect(edited.source.metadata).toMatchObject({ total: 40, invoiceNo: 'B', notes: 'new' });
      expect(legacy.updateBill).toHaveBeenCalledTimes(1);
      await router.deleteBill(edited.source.id);
      expect(legacy.deleteBill).toHaveBeenCalledTimes(1);
      expect(await runner.first("SELECT json_extract(metadata,'$.deleted') AS deleted FROM v2_sources WHERE id=?", [edited.source.id])).toEqual({ deleted: 1 });
    } finally { close(); }
  });
});
