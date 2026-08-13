import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';
import { partnershipDisplayFromReports, partnershipProfitFromReports, postedCommissionFromReports } from '../src/accountingV2/reports';
import { getV2Dashboard } from '../src/accountingV2/v2Dashboard';
import { V2BookConfigRepository } from '../src/accountingV2/bookConfigRepository';

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

  describe('closed-range commission is not overlaid twice', () => {
    it('keeps net 340 / commission 60 after a 15% close on a $400 cash sale', async () => {
      const { runner, close, service, bookId } = await setupBook('book_comm_double');
      try {
        const configRepo = new V2BookConfigRepository(runner);
        const current = await configRepo.getBookConfig(bookId);
        await configRepo.updateBookConfig(bookId, {
          ...current,
          retailPartnership: { ...current.retailPartnership, enabled: true, commissionPct: 15 },
        });

        await service.createSale({ date: '2026-02-15', amount: 400, method: 'cash' });
        await service.closeBooks({ actualStock: 0, openingInventory: 0, commissionPct: 15, date: '2026-02-28' });

        const report = await buildPersistentV2Reports(runner, { bookId, from: '2026-02-01', to: '2026-02-28' });
        expect(report.profitAndLoss).toMatchObject({ revenue: 400, grossProfit: 400, netProfit: 340 });
        const posted = postedCommissionFromReports(report);
        expect(posted).toBe(60);

        const profit = partnershipProfitFromReports(report.profitAndLoss, 15, posted);
        expect(profit.commission).toBe(60);
        expect(profit.netProfit).toBe(340);
        expect(profit.commission).not.toBe(120);
        expect(profit.netProfit).not.toBe(280);

        const naive = partnershipProfitFromReports(report.profitAndLoss, 15);
        expect(naive.netProfit).toBe(280);

        const dash = await getV2Dashboard(runner, bookId);
        expect(dash.commission).toBe(60);
        expect(dash.netProfit).toBe(340);

        const display = partnershipDisplayFromReports(report, 15);
        expect(display.operatingExpenses).toBe(0);
        expect(display.commission).toBe(60);
        expect(display.netProfit).toBe(340);
        expect(display.grossProfit - display.operatingExpenses - display.commission).toBe(display.netProfit);
      } finally { close(); }
    });
  });

  describe('closeBooks requires an explicit physical count', () => {
    it('throws when actualStock is omitted and accepts an explicit count', async () => {
      const { close, service } = await setupBook('book_actual_stock');
      try {
        await expect(
          service.closeBooks({ openingInventory: 10 } as any),
        ).rejects.toThrow(/physical inventory count required/i);

        const closed = await service.closeBooks({ actualStock: 10, openingInventory: 10, commissionPct: 0 });
        expect(closed.source).toBe('v2');
        expect(closed.result.snapshot.closingInventory).toBe(10);
      } finally { close(); }
    });
  });
});
