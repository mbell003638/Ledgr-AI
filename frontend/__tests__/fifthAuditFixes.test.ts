import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';

describe('5th Audit leftover fixes', () => {
  async function setupBook(bookId: string = 'audit5_book') {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: bookId, name: `Book ${bookId}` },
      period: { id: `${bookId}:period:2026`, startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    return { ...node, service: new V2AppService(node.runner), bookId };
  }

  describe('ACC-20: invoice customer-change via clientName does not create an orphan', () => {
    it('rejects a new clientName on an allocated invoice without inserting the party', async () => {
      const { runner, close, service, bookId } = await setupBook('book_acc20_orphan');
      try {
        const custA = await service.ensureParty('Customer Alpha', 'customer');
        const inv = await service.createInvoice({
          partyId: custA.id,
          clientName: 'Customer Alpha',
          date: '2026-04-10',
          amount: 400,
        });
        await service.createReceipt({
          partyId: custA.id,
          clientName: 'Customer Alpha',
          date: '2026-04-11',
          amount: 200,
          method: 'cash',
          allocations: [{ invoiceSourceId: inv.source.id, amount: 200 }],
        });

        await expect(
          service.updateInvoice(inv.source.id, {
            clientName: 'Brand New Gamma',
            date: '2026-04-10',
            amount: 400,
          }),
        ).rejects.toThrow(/Cannot change customer/);

        const gamma = Number((await runner.first<{ n: number }>(
          'SELECT COUNT(*) AS n FROM v2_parties WHERE book_id=? AND name=?',
          [bookId, 'Brand New Gamma'],
        ))?.n);
        expect(gamma).toBe(0);
      } finally { close(); }
    });

    it('rejects clientName of an existing other customer on an allocated invoice', async () => {
      const { close, service } = await setupBook('book_acc20_beta');
      try {
        const custA = await service.ensureParty('Customer Alpha', 'customer');
        await service.ensureParty('Customer Beta', 'customer');
        const inv = await service.createInvoice({
          partyId: custA.id,
          clientName: 'Customer Alpha',
          date: '2026-04-10',
          amount: 400,
        });
        await service.createReceipt({
          partyId: custA.id,
          clientName: 'Customer Alpha',
          date: '2026-04-11',
          amount: 200,
          method: 'cash',
          allocations: [{ invoiceSourceId: inv.source.id, amount: 200 }],
        });

        await expect(
          service.updateInvoice(inv.source.id, {
            clientName: 'Customer Beta',
            date: '2026-04-10',
            amount: 400,
          }),
        ).rejects.toThrow(/Cannot change customer on an invoice that has active receipt allocations/);
      } finally { close(); }
    });
  });
});
