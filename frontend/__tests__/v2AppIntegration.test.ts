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

  it('atomically replaces edited sales and excludes the reversed source from lists and totals', async () => {
    const { runner, close, service } = await setup();
    try {
      const sale = await service.createSale({ date: '2026-07-10', amount: 25, method: 'cash' });
      const edited = await service.updateSale(sale.source.id, { date: '2026-07-11', amount: 40, method: 'bank' });
      expect((await service.listSalesAndInvoices()).map((item: any) => item.id)).toEqual([edited.source.id]);
      const { getV2Dashboard } = await import('../src/accountingV2/v2Dashboard');
      expect((await getV2Dashboard(runner, 'active-v2')).totalSales).toBe(40);
      await expect(service.deleteSale(sale.source.id)).rejects.toThrow(/already been reversed/i);
    } finally { close(); }
  });

  it('rolls back the reversal when an edited replacement is invalid', async () => {
    const { runner, close, service } = await setup();
    try {
      const sale = await service.createSale({ date: '2026-07-10', amount: 25, method: 'cash' });
      await expect(service.updateSale(sale.source.id, { date: '2026-07-11', amount: 0, method: 'cash' })).rejects.toThrow(/positive/i);
      expect(await runner.first("SELECT json_extract(metadata,'$.reversed') AS reversed FROM v2_sources WHERE id=?", [sale.source.id])).toEqual({ reversed: null });
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n)).toBe(0);
      expect((await service.listSalesAndInvoices()).map((item: any) => item.id)).toEqual([sale.source.id]);
    } finally { close(); }
  });

  it('returns display names separately and repairs recursively prefixed V2 party identities', async () => {
    const { runner, close, service } = await setup();
    try {
      const invoice = await service.createInvoice({ date: '2026-07-02', total: 40, clientName: 'Amit' });
      const canonicalId = String(invoice.source.metadata?.partyId);
      const corruptId = 'v2:customer:v2:customer:amit';
      await runner.run('INSERT INTO v2_parties(id,book_id,name,roles,archived) VALUES(?,?,?,?,0)', [corruptId, 'active-v2', corruptId, '["customer"]']);
      await runner.run('UPDATE v2_journal_lines SET party_id=? WHERE party_id=?', [corruptId, canonicalId]);
      await runner.run("UPDATE v2_sources SET metadata=json_set(metadata,'$.partyId',?) WHERE id=?", [corruptId, invoice.source.id]);

      const parties = await service.listParties();
      expect(parties.filter((party: any) => party.name === 'Amit')).toHaveLength(1);
      expect(await runner.first('SELECT id FROM v2_parties WHERE id=?', [corruptId])).toBeNull();
      const listed = await service.listSalesAndInvoices();
      expect(listed[0]).toMatchObject({ partyId: canonicalId, clientName: 'Amit', partyName: 'Amit' });
    } finally { close(); }
  });
  it('routes partnership drawing edits and deletes through V2 while preserving partner balances', async () => {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: 'partnership', name: 'Partnership', style: 'retail_partnership' },
      period: { id: 'partnership-period', startDate: '2026-01-01', endDate: '2026-12-31' },
      members: [{ name: 'Alice', openingContribution: 100, profitSharePct: 100 }],
    });
    const service = new V2AppService(node.runner);
    const legacy = { updatePayment: jest.fn(), deletePayment: jest.fn() };
    const router = createAppMutationRouter(service, legacy);
    try {
      const drawing = await service.createPayment({ date: '2026-07-10', amount: 20, type: 'drawing', investorId: 'partnership:member:1', notes: 'First' });
      expect((await new (await import('../src/accountingV2/investorLedgerService')).V2InvestorLedgerService(node.runner).detail('partnership', 'partnership:member:1')).currentCapitalBalance).toBe(80);

      const edited = await router.updatePayment(drawing.source.id, { date: '2026-07-11', amount: 35, type: 'drawing', notes: 'Edited' });
      const ledger = new (await import('../src/accountingV2/investorLedgerService')).V2InvestorLedgerService(node.runner);
      await expect(ledger.detail('partnership', 'partnership:member:1')).resolves.toMatchObject({ totalDrawings: 35, currentCapitalBalance: 65 });
      expect((await ledger.detail('partnership', 'partnership:member:1')).transactions.filter((item) => item.type === 'drawing')).toHaveLength(1);
      expect(legacy.updatePayment).toHaveBeenCalledTimes(1);

      await router.deletePayment(edited.source.id);
      await expect(ledger.detail('partnership', 'partnership:member:1')).resolves.toMatchObject({ totalDrawings: 0, currentCapitalBalance: 100 });
      expect(legacy.deletePayment).toHaveBeenCalledTimes(1);
      expect((await service.repo.reconcileBook('partnership')).balanced).toBe(true);
    } finally { node.close(); }
  });
  it('rolls back all party identity repair mutations when one reference update fails', async () => {
    const { runner, close, service } = await setup();
    try {
      const invoice = await service.createInvoice({ date: '2026-07-02', total: 40, clientName: 'Amit' });
      const canonicalId = String(invoice.source.metadata?.partyId);
      const corruptId = 'v2:customer:v2:customer:amit';
      await runner.run('INSERT INTO v2_parties(id,book_id,name,roles,archived) VALUES(?,?,?,?,0)', [corruptId, 'active-v2', corruptId, '["customer"]']);
      await runner.run('UPDATE v2_journal_lines SET party_id=? WHERE party_id=?', [corruptId, canonicalId]);
      await runner.run("UPDATE v2_sources SET metadata=json_set(metadata,'$.partyId',?) WHERE id=?", [corruptId, invoice.source.id]);
      await runner.exec("CREATE TRIGGER reject_party_repair BEFORE UPDATE OF party_id ON v2_journal_lines BEGIN SELECT RAISE(ABORT, 'repair rejected'); END;");

      await expect(service.listParties()).rejects.toThrow(/repair rejected/i);
      expect(await runner.first('SELECT id,name FROM v2_parties WHERE id=?', [corruptId])).toEqual({ id: corruptId, name: corruptId });
      expect(await runner.first("SELECT json_extract(metadata,'$.partyId') AS partyId FROM v2_sources WHERE id=?", [invoice.source.id])).toEqual({ partyId: corruptId });
      await runner.exec('DROP TRIGGER reject_party_repair');
      await expect(service.listParties()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: canonicalId, name: 'Amit' })]));
    } finally { close(); }
  });
  it('opens V2 customer and supplier details from party-list IDs with authoritative balances', async () => {
    const { close, service } = await setup();
    try {
      const invoice = await service.createInvoice({ date: '2026-07-02', total: 100, clientName: 'Amit' });
      const customerId = String(invoice.source.metadata?.partyId);
      await service.createReceipt({ date: '2026-07-03', amount: 40, debtorId: customerId, method: 'cash', allocations: [{ invoiceId: invoice.source.id, amountApplied: 40 }] });
      const supplierBill = await service.createBill({ date: '2026-07-04', amount: 75, supplierName: 'Supply Co', paymentType: 'credit' });
      const supplierId = String(supplierBill.source.metadata?.partyId);
      await service.createPayment({ date: '2026-07-05', amount: 25, supplierId, supplierName: 'Supply Co', type: 'supplier_payment', method: 'bank' });

      const parties = await service.listParties();
      expect(parties).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: customerId, name: 'Amit', receivable: 60 }),
        expect.objectContaining({ id: supplierId, name: 'Supply Co', payable: 50 }),
      ]));
      await expect(service.getPartyDetail(customerId, 'customer')).resolves.toMatchObject({
        id: customerId, name: 'Amit', totalInvoiced: 100, totalPaid: 40, balance: 60,
        statement: { balance: 60 },
      });
      await expect(service.getPartyDetail(supplierId, 'supplier')).resolves.toMatchObject({
        id: supplierId, name: 'Supply Co', billsTotal: 75, paymentsTotal: 25, balance: 50,
      });
      await expect(service.getPartyDetail(customerId, 'supplier')).resolves.toBeNull();
    } finally { close(); }
  });
});
