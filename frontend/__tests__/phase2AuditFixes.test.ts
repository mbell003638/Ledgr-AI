import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { getPersonaBaselineFeatures } from '../src/utils/featureFlags';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';

describe('Audit Phase 2 Forensic Fixes', () => {
  async function setupBook(bookId: string = 'phase2_book', basis: 'accrual' | 'cash' = 'accrual') {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: bookId, name: `Book ${bookId}`, basis },
      period: { id: `${bookId}:period:2026`, startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    return {
      ...node,
      service: new V2AppService(node.runner),
      repo: new V2SqlRepository(node.runner),
    };
  }

  it('ACC-05: Unnamed cash receipt routes to createSale without creating dummy customer', async () => {
    const { runner, service } = await setupBook('book_acc05');

    // Create unnamed receipt
    const receipt = await service.createReceipt({
      date: '2026-07-10',
      amount: 75,
      mode: 'cash_sale',
      notes: 'POS walk-in',
    });

    expect(receipt.source.type).toEqual('cash_sale');
    const parties = await runner.all<any>('SELECT * FROM v2_parties WHERE book_id=?', ['book_acc05']);
    expect(parties).toHaveLength(0);
  });

  it('ACC-08: Tax Payable (2300) correctly separated from sales revenue', async () => {
    const { runner, service } = await setupBook('book_acc08');

    // Create an invoice with subtotal $100 and tax $10 (total $110)
    const inv = await service.createInvoice({
      date: '2026-08-01',
      clientName: 'Taxable Client',
      amount: 110,
      subtotal: 100,
      tax: 10,
      taxRate: 10,
    });

    const lines = await runner.all<any>(
      `SELECT l.*, a.code FROM v2_journal_lines l
       JOIN v2_accounts a ON a.id = l.account_id
       JOIN v2_journal_entries j ON j.id = l.journal_id
       WHERE j.source_id = ?`,
      [inv.source.id],
    );

    const arLine = lines.find((l) => l.code === '1100');
    const salesLine = lines.find((l) => l.code === '4000');
    const taxLine = lines.find((l) => l.code === '2300');

    expect(arLine).toBeDefined();
    expect(Number(arLine.debit)).toEqual(110);

    expect(salesLine).toBeDefined();
    expect(Number(salesLine.credit)).toEqual(100);

    expect(taxLine).toBeDefined();
    expect(Number(taxLine.credit)).toEqual(10);
  });

  it('ACC-06 / ACC-07: Cash-basis P&L accurately captures unallocated advance receipts and returns', async () => {
    const { service, runner } = await setupBook('book_cash_pnl', 'cash');

    // 1. Direct cash sale of $200
    await service.createSale({ date: '2026-03-01', amount: 200 });

    // 2. Unallocated advance receipt of $150
    await service.createReceipt({
      date: '2026-03-05',
      clientName: 'Advance Debtor',
      amount: 150,
    });

    // 3. Customer credit note refund of $30
    await service.createCreditNote({
      date: '2026-03-10',
      clientName: 'Advance Debtor',
      amount: 30,
      reason: 'Cash refund',
    });

    // 4. Cash operating expense of $50
    await service.createExpense({
      date: '2026-03-15',
      amount: 50,
      method: 'cash',
    });

    const reports = await buildPersistentV2Reports(runner, {
      bookId: 'book_cash_pnl',
      from: '2026-03-01',
      to: '2026-03-31',
    });

    // Cash revenue: $200 (sale) + $150 (advance) - $30 (return) = $320
    expect(reports.profitAndLoss.revenue).toEqual(320);
    expect(reports.profitAndLoss.expenses).toEqual(50);
    expect(reports.profitAndLoss.netProfit).toEqual(270);
  });

  it('PROD-01 / PROD-03: Personal persona baseline features hide B2B supply and include budget/net-worth essentials', () => {
    const features = getPersonaBaselineFeatures({ activePersona: 'personal' });

    expect(features).toContain('expenses');
    expect(features).toContain('cashbook');
    expect(features).toContain('reports');
    expect(features).toContain('monthly');
    expect(features).not.toContain('inventory');
    expect(features).not.toContain('bills');
    expect(features).not.toContain('delivery_notes');
  });
});
