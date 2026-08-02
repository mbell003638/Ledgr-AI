import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { runConfirmedV2Command } from '../src/accountingV2/commandBridge';

describe('validated V2 AI/voice command bridge', () => {
  async function setup() {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: 'active-v2', name: 'Active V2' },
      period: { id: 'open-2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    return { ...node, service: new V2AppService(node.runner) };
  }

  it('executes canonical invoice and received/paid payment intents through V2AppService', async () => {
    const { runner, close, service } = await setup();
    try {
      const invoice = await runConfirmedV2Command('ai', {
        intent: 'create_invoice', partyId: 'customer-1', date: '2026-07-01',
        lines: [{ description: 'Design', quantity: 2, unitPrice: 25 }],
      }, true, { service });
      expect(invoice.executed).toBe(true);
      expect((invoice.result as any).source.type).toBe('invoice');

      const received = await runConfirmedV2Command('voice', {
        intent: 'create_payment', partyId: 'customer-1', date: '2026-07-02', amount: 20,
        method: 'bank', direction: 'received', invoiceId: (invoice.result as any).source.id,
      }, true, { service });
      const paid = await runConfirmedV2Command('voice', {
        intent: 'create_payment', partyId: 'supplier-1', date: '2026-07-03', amount: 10,
        method: 'cash', direction: 'paid',
      }, true, { service });
      expect((received.result as any).source.type).toBe('receipt');
      expect((paid.result as any).source.type).toBe('supplier_payment');
      expect(await runner.all('SELECT type FROM v2_sources ORDER BY date')).toEqual([
        { type: 'invoice' }, { type: 'receipt' }, { type: 'supplier_payment' },
      ]);
    } finally { close(); }
  });

  it('executes report, party, and inventory-profit reads from authoritative V2 data', async () => {
    const { close, service } = await setup();
    try {
      await service.createInvoice({ date: '2026-07-01', total: 50, debtorId: 'acme', clientName: 'Acme Ltd' });
      const report = await runConfirmedV2Command('ai', {
        intent: 'report_query', report: 'profit_and_loss', from: '2026-01-01', to: '2026-12-31',
      }, false, { service });
      const party = await runConfirmedV2Command('ai', { intent: 'party_lookup', query: 'acme', role: 'customer' }, false, { service });
      const inventory = await runConfirmedV2Command('voice', {
        intent: 'inventory_profit', from: '2026-01-01', to: '2026-12-31',
      }, false, { service });
      expect(report.executed).toBe(true);
      expect(report.result).toEqual({ revenue: 50, expenses: 0, netProfit: 50 });
      expect(party.result).toEqual([expect.objectContaining({ name: 'Acme Ltd' })]);
      expect(inventory.result).toEqual(expect.objectContaining({ revenue: 50, expenses: 0, netProfit: 50 }));
    } finally { close(); }
  });

  it('rejects unconfirmed writes before calling the service', async () => {
    const service = { createInvoice: jest.fn() } as any;
    await expect(runConfirmedV2Command('ai', {
      intent: 'create_invoice', partyId: 'p', date: '2026-07-01',
      lines: [{ description: 'Work', quantity: 1, unitPrice: 1 }],
    }, false, { service })).rejects.toThrow(/explicit confirmation/i);
    expect(service.createInvoice).not.toHaveBeenCalled();
  });
});
