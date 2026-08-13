import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book, ensureDefaultAccounts } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';
import { mapAnalyzedDocument } from '../src/accountingV2/scanImport';
import { api } from '../src/api';

describe('2nd Audit Comprehensive Fixes', () => {
  async function setupBook(bookId: string = 'audit2_book', basis: 'accrual' | 'cash' = 'accrual') {
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

  it('Section 6.1: Customer advance later consumed by invoice does not double-count in cash-basis P&L', async () => {
    const { runner, service } = await setupBook('book_advance_alloc', 'cash');

    // 1. Advance receipt of $150 in March
    await service.createReceipt({
      date: '2026-03-05',
      clientName: 'Advancing Debtor',
      amount: 150,
      mode: 'advance',
    });

    // 2. Invoice of $80 in April (auto-consumes $80 from 2100 advance)
    await service.createInvoice({
      date: '2026-04-01',
      clientName: 'Advancing Debtor',
      amount: 80,
    });

    // Verify March reports: $150 collected
    const marchReports = await buildPersistentV2Reports(runner, {
      bookId: 'book_advance_alloc',
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(marchReports.profitAndLoss.revenue).toEqual(150);

    // Verify April reports: $0 new cash received in April
    const aprilReports = await buildPersistentV2Reports(runner, {
      bookId: 'book_advance_alloc',
      from: '2026-04-01',
      to: '2026-04-30',
    });
    expect(aprilReports.profitAndLoss.revenue).toEqual(0);

    // Verify full period: total cash collected is $150 (not $230!)
    const allReports = await buildPersistentV2Reports(runner, {
      bookId: 'book_advance_alloc',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(allReports.profitAndLoss.revenue).toEqual(150);
  });

  it('Section 6.2: Non-cash credit note (Dr 4010 / Cr AR) does not reduce cash P&L revenue', async () => {
    const { runner, service } = await setupBook('book_credit_return', 'cash');

    // 1. Cash sale of $100
    await service.createSale({ date: '2026-05-01', amount: 100 });

    // 2. Credit note issued on account (no cash movement, method = 'credit')
    await service.createCreditNote({
      date: '2026-05-10',
      clientName: 'Some Customer',
      amount: 30,
      method: 'credit',
      reason: 'Credit adjustment',
    });

    const reports = await buildPersistentV2Reports(runner, {
      bookId: 'book_credit_return',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    // Cash revenue remains $100 because no cash was refunded
    expect(reports.profitAndLoss.revenue).toEqual(100);
  });

  it('ACC-07: Supplier payment with advance (1210) does not inflate cash-basis operating expenses', async () => {
    const { runner, service } = await setupBook('book_supplier_exp', 'cash');

    // Bill of $80
    await service.createBill({
      date: '2026-06-01',
      supplierName: 'Main Supplier',
      amount: 80,
      paymentType: 'credit',
    });

    // Payment of $100 ($80 AP + $20 Supplier Advance)
    await service.createPayment({
      date: '2026-06-05',
      type: 'supplier_payment',
      supplierName: 'Main Supplier',
      amount: 100,
      method: 'cash',
    });

    const reports = await buildPersistentV2Reports(runner, {
      bookId: 'book_supplier_exp',
      from: '2026-06-01',
      to: '2026-06-30',
    });
    // Operating expense settled is $80; the $20 is a balance sheet asset prepayment
    expect(reports.profitAndLoss.expenses).toEqual(80);
  });

  it('Section 6.3: Mixed receipt (part 1100 AR, part 2100 advance) preserved on invoice edit', async () => {
    const { runner, service } = await setupBook('book_mixed_receipt');

    // 1. Invoice of $80
    const inv = await service.createInvoice({
      date: '2026-07-01',
      clientName: 'Mixed Client',
      amount: 80,
    });

    // 2. Receipt of $100: $80 allocated to invoice, $20 to customer advance (2100)
    await service.createReceipt({
      date: '2026-07-02',
      clientName: 'Mixed Client',
      amount: 100,
      mode: 'against_invoice',
      allocations: [{ invoiceId: inv.source.id, amountApplied: 80 }],
    });

    // 3. Edit the invoice from $80 to $120
    const edited = await service.updateInvoice(inv.source.id, {
      date: '2026-07-01',
      clientName: 'Mixed Client',
      amount: 120,
    });

    // Verify that the $80 direct receipt allocation was preserved and the $20 advance was applied
    const allocs = await runner.all<any>(
      'SELECT * FROM v2_invoice_allocations WHERE invoice_source_id=? ORDER BY amount DESC',
      [edited.source.id],
    );
    expect(allocs).toHaveLength(2);
    expect(Number(allocs[0].amount)).toEqual(80);
    expect(Number(allocs[1].amount)).toEqual(20);
  });

  it('Section 6.4: ensureDefaultAccounts adds 2300 Tax Payable to existing books dynamically', async () => {
    const { runner } = await setupBook('book_legacy_accs');

    // Simulate an older book that had account 2300 deleted
    await runner.run("DELETE FROM v2_accounts WHERE id='book_legacy_accs:account:2300'");
    let check = await runner.first("SELECT id FROM v2_accounts WHERE id='book_legacy_accs:account:2300'");
    expect(check).toBeNull();

    // Call ensureDefaultAccounts
    await ensureDefaultAccounts(runner, 'book_legacy_accs');

    check = await runner.first<{ id: string }>("SELECT id FROM v2_accounts WHERE id='book_legacy_accs:account:2300'");
    expect(check?.id).toEqual('book_legacy_accs:account:2300');
  });

  it('ACC-18: Expense bill debits Account 6000 instead of Inventory 1200', async () => {
    const { runner, service } = await setupBook('book_expense_bill');

    const bill = await service.createBill({
      date: '2026-08-01',
      supplierName: 'Electric Utility',
      amount: 250,
      category: 'Utilities',
      isExpense: true,
      paymentType: 'credit',
    });

    const lines = await runner.all<any>(
      `SELECT l.*, a.code FROM v2_journal_lines l
       JOIN v2_accounts a ON a.id = l.account_id
       JOIN v2_journal_entries j ON j.id = l.journal_id
       WHERE j.source_id = ?`,
      [bill.source.id],
    );

    const expenseLine = lines.find((l) => l.code === '6000');
    const apLine = lines.find((l) => l.code === '2000');
    const inventoryLine = lines.find((l) => l.code === '1200');

    expect(expenseLine).toBeDefined();
    expect(Number(expenseLine.debit)).toEqual(250);
    expect(apLine).toBeDefined();
    expect(Number(apLine.credit)).toEqual(250);
    expect(inventoryLine).toBeUndefined();
  });

  it('ACC-03 remainder: Debit note increases invoiceOpen balance', async () => {
    const { service, repo } = await setupBook('book_debit_note');

    // 1. Invoice of $100
    const inv = await service.createInvoice({
      date: '2026-09-01',
      clientName: 'Debtor Corp',
      amount: 100,
    });

    expect(await repo.invoiceOpen(inv.source.id)).toEqual(100);

    // 2. Issue a $25 debit note on this invoice (e.g. price adjustment)
    await service.createDebitNote({
      date: '2026-09-05',
      clientName: 'Debtor Corp',
      amount: 25,
      invoiceSourceId: inv.source.id,
      reason: 'Underbilled correction',
    });

    // invoiceOpen should now be $125
    expect(await repo.invoiceOpen(inv.source.id)).toEqual(125);
  });

  it('PROD-04: mapAnalyzedDocument ignores transaction entries when docType is closing_report', () => {
    const result = mapAnalyzedDocument({
      docType: 'closing_report',
      summary: 'Annual P&L summary',
      entries: [
        { type: 'sale', amount: 5000, date: '2026-12-31' },
        { type: 'expense', amount: 2000, date: '2026-12-31' },
      ],
      setup: {
        extraAssets: [{ name: 'Cash', amount: 1000 }],
      },
    });

    // validRows should not contain the sale/expense transactions
    const transactionRows = result.validRows.filter((r) => r.kind === 'transaction');
    expect(transactionRows).toHaveLength(0);
    expect(result.flaggedRows.some((f) => f.label.includes('Closing Report'))).toBe(true);
  });
});
