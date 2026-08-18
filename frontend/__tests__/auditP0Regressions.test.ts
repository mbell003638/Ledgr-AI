import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { createAppMutationRouter, V2AppService } from '../src/accountingV2/appService';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';

describe('Audit P0 Forensic Regressions', () => {
  async function setupBook(bookId: string = 'book_a', startDate = '2026-01-01', endDate = '2026-12-31') {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: bookId, name: `Book ${bookId}` },
      period: { id: `${bookId}:period:2026`, startDate, endDate },
    });
    return {
      ...node,
      service: new V2AppService(node.runner),
      repo: new V2SqlRepository(node.runner),
      closeRepo: new V2CloseBooksRepository(node.runner),
    };
  }

  it('ACC-01 / ENG-01: Multi-book allows identical customer names across books without PK collision', async () => {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: 'book_alpha', name: 'Book Alpha' },
      period: { id: 'alpha:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    await initializeV2Book(node.runner, {
      book: { id: 'book_beta', name: 'Book Beta' },
      period: { id: 'beta:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    });

    // Switch to Book Alpha and create customer "Alice"
    await node.runner.run("INSERT OR REPLACE INTO meta(key, value) VALUES('v2_active_book_id', ?)", ['book_alpha']);
    const svcA = new V2AppService(node.runner);
    const invoiceA = await svcA.createInvoice({
      date: '2026-02-01',
      clientName: 'Alice',
      amount: 100,
    });
    expect(invoiceA.source.id).toBeDefined();

    // Switch to Book Beta and create customer "Alice" with the exact same name
    await node.runner.run("INSERT OR REPLACE INTO meta(key, value) VALUES('v2_active_book_id', ?)", ['book_beta']);
    const svcB = new V2AppService(node.runner);
    const invoiceB = await svcB.createInvoice({
      date: '2026-02-01',
      clientName: 'Alice',
      amount: 250,
    });
    expect(invoiceB.source.id).toBeDefined();

    // Verify parties in both books exist independently
    const partyA = await node.runner.first<any>('SELECT * FROM v2_parties WHERE book_id=? AND name=?', ['book_alpha', 'Alice']);
    const partyB = await node.runner.first<any>('SELECT * FROM v2_parties WHERE book_id=? AND name=?', ['book_beta', 'Alice']);
    expect(partyA).toBeDefined();
    expect(partyB).toBeDefined();
    expect(partyA.id).not.toEqual(partyB.id);
  });

  it('ACC-01d: mutation router rejects a source owned by an inactive book', async () => {
    const node = makeNodeRunner();
    try {
      await initializeV2Book(node.runner, {
        book: { id: 'book_source', name: 'Source Book' },
        period: { id: 'source:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      await initializeV2Book(node.runner, {
        book: { id: 'book_active', name: 'Active Book' },
        period: { id: 'active:2026', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      await node.runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", ['book_source']);
      const service = new V2AppService(node.runner);
      const invoice = await service.createInvoice({ date: '2026-02-01', clientName: 'Book A Customer', amount: 100 });

      await node.runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", ['book_active']);
      const mutations = createAppMutationRouter(service);
      await expect(mutations.deleteInvoice(invoice.source.id)).rejects.toThrow(/unknown V2 invoice source/i);
      expect(await service.ownsSource(invoice.source.id, 'invoice')).toBe(false);

      const source = await node.runner.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=?', [invoice.source.id]);
      expect(JSON.parse(source?.metadata || '{}').reversed).toBeFalsy();
      expect(Number((await node.runner.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL',
      ))?.n || 0)).toBe(0);

      await node.runner.run("INSERT OR REPLACE INTO meta(key,value) VALUES('v2_active_book_id',?)", ['book_source']);
      await expect(mutations.deleteInvoice(invoice.source.id)).resolves.toBeDefined();
    } finally {
      node.close();
    }
  });

  it('ACC-01b / ENG-02: Party form and invoices share the exact same party record', async () => {
    const { runner, service } = await setupBook();
    const created = await service.ensureParty('Acme Corp', 'customer', { phone: '555-1234' });
    expect(created.name).toEqual('Acme Corp');

    // Create an invoice using clientName "Acme Corp"
    await service.createInvoice({
      date: '2026-03-01',
      clientName: 'Acme Corp',
      amount: 150,
    });

    const parties = await runner.all<any>("SELECT * FROM v2_parties WHERE name='Acme Corp'");
    expect(parties).toHaveLength(1);
    expect(parties[0].id).toEqual(created.id);
  });

  it('ACC-04: Period close snapshot correctly deducts sales returns (4010) from sales', async () => {
    const { service } = await setupBook('book_close', '2026-01-01', '2026-01-31');
    // Cash sale of $1,000
    await service.createSale({ date: '2026-01-10', amount: 1000 });
    // Customer return / credit note of $50
    await service.createCreditNote({
      date: '2026-01-15',
      clientName: 'Walk-in Customer',
      amount: 50,
      reason: 'Defective item',
    });

    // Record inventory count to enable close
    await service.recordInventoryCount({ date: '2026-01-01', value: 0 });
    await service.recordInventoryCount({ date: '2026-01-31', value: 0 });

    const closeResult = await service.closeBooks({
      actualStock: 0,
      openingInventory: 0,
      commissionPct: 10,
      date: '2026-01-31',
    });

    // Sales must be Net Sales: $1000 - $50 = $950 (NOT $1050)
    expect(closeResult.result.snapshot.sales).toEqual(950);
    expect(closeResult.result.snapshot.grossProfit).toEqual(950);
    expect(closeResult.result.snapshot.commission).toEqual(95);
    expect(closeResult.result.snapshot.netProfit).toEqual(855);
  });

  it('ACC-02 / ENG-03: Receipt edit cleanly deletes old allocations before replacement', async () => {
    const { runner, service, repo } = await setupBook();
    const inv = await service.createInvoice({
      date: '2026-04-01',
      clientName: 'Tech Corp',
      amount: 200,
    });

    const receipt = await service.createReceipt({
      date: '2026-04-05',
      clientName: 'Tech Corp',
      amount: 100,
      allocations: [{ invoiceSourceId: inv.source.id, amount: 100 }],
    });

    let open = await repo.invoiceOpen(inv.source.id);
    expect(open).toEqual(100);

    // Edit receipt amount to $80
    await service.updateReceipt(receipt.source.id, {
      date: '2026-04-05',
      clientName: 'Tech Corp',
      amount: 80,
      allocations: [{ invoiceSourceId: inv.source.id, amount: 80 }],
    });

    open = await repo.invoiceOpen(inv.source.id);
    // Open balance must be 200 - 80 = 120 (NOT 200 - 100 - 80 = 20)
    expect(open).toEqual(120);

    const activeAllocs = await runner.all<any>(
      `SELECT a.* FROM v2_invoice_allocations a
       JOIN v2_sources s ON s.id = a.receipt_source_id
       WHERE a.invoice_source_id = ?
         AND (json_extract(s.metadata,'$.reversed') IS NULL OR json_extract(s.metadata,'$.reversed') = 0)`,
      [inv.source.id],
    );
    expect(activeAllocs).toHaveLength(1);
    expect(Number(activeAllocs[0].amount)).toEqual(80);
  });

  it('ACC-01c: Invoice edit after customer advance preserves unconsumed advances and correct AR', async () => {
    const { runner, service, repo } = await setupBook();
    // 1. Customer pays $100 in advance (no invoice yet)
    await service.createReceipt({
      date: '2026-05-01',
      clientName: 'Advance Customer',
      amount: 100,
    });

    // 2. Post invoice for $80 -> auto-applies $80 advance
    const inv = await service.createInvoice({
      date: '2026-05-05',
      clientName: 'Advance Customer',
      amount: 80,
    });
    expect(await repo.invoiceOpen(inv.source.id)).toEqual(0);

    // 3. Edit the invoice (e.g. adjust notes / total to $80)
    const updated = await service.updateInvoice(inv.source.id, {
      date: '2026-05-05',
      clientName: 'Advance Customer',
      amount: 80,
      notes: 'Updated invoice notes',
    });

    // Verify open balance is still $0
    expect(await repo.invoiceOpen(updated.source.id)).toEqual(0);

    // Total allocations against the new invoice must equal exactly $80
    const allocRows = await runner.all<any>(
      'SELECT SUM(amount) as total FROM v2_invoice_allocations WHERE invoice_source_id=?',
      [updated.source.id],
    );
    expect(Number(allocRows[0].total)).toEqual(80);
  });

  it('ACC-03: Credit notes reduce invoiceOpen and prevent duplicate collection', async () => {
    const { service, repo } = await setupBook();
    const inv = await service.createInvoice({
      date: '2026-06-01',
      clientName: 'Refundable Client',
      amount: 100,
    });
    expect(await repo.invoiceOpen(inv.source.id)).toEqual(100);

    // Raise a credit note for $60 against the invoice
    await service.createCreditNote({
      date: '2026-06-05',
      clientName: 'Refundable Client',
      invoiceId: inv.source.id,
      amount: 60,
      reason: 'Partial discount',
    });

    // invoiceOpen should now be 100 - 60 = 40
    expect(await repo.invoiceOpen(inv.source.id)).toEqual(40);

    // Marking invoice paid should collect remaining $40 only
    const payment = await service.markInvoicePaid(inv.source.id, { date: '2026-06-10', method: 'cash' });
    const paidAmount = (payment as any).source?.metadata?.total || (payment as any).metadata?.total;
    expect(Number(paidAmount)).toEqual(40);
    expect(await repo.invoiceOpen(inv.source.id)).toEqual(0);

    // Attempting to mark paid again should be rejected
    await expect(service.markInvoicePaid(inv.source.id, { date: '2026-06-11', method: 'cash' })).rejects.toThrow(
      'Invoice already settled',
    );
  });

  it('ACC-02b: receipt edit rejects duplicate allocations whose aggregate exceeds invoice open balance', async () => {
    const { runner, close, service, repo } = await setupBook('book_duplicate_allocation');
    try {
      const invoice = await service.createInvoice({ date: '2026-04-01', clientName: 'Duplicate Corp', amount: 100 });
      const receipt = await service.createReceipt({
        date: '2026-04-02', clientName: 'Duplicate Corp', amount: 20,
        allocations: [{ invoiceSourceId: invoice.source.id, amount: 20 }],
      });

      await expect(service.updateReceipt(receipt.source.id, {
        date: '2026-04-02', amount: 120,
        allocations: [
          { invoiceSourceId: invoice.source.id, amount: 60 },
          { invoiceSourceId: invoice.source.id, amount: 60 },
        ],
      })).rejects.toThrow('Invalid invoice allocation');

      expect(await repo.invoiceOpen(invoice.source.id)).toBe(80);
      const allocations = await runner.all<{ amount: number }>(
        'SELECT amount FROM v2_invoice_allocations WHERE invoice_source_id=?',
        [invoice.source.id],
      );
      expect(allocations).toEqual([{ amount: 20 }]);
    } finally {
      close();
    }
  });
});
