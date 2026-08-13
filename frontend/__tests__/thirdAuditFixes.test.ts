import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2_ACCOUNT_CODES } from '../src/accountingV2/types';
import { postPurchase, postCreditNote } from '../src/accountingV2/postings';
import { validateAssistantProposal } from '../src/accountingV2/aiActions';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';

describe('3rd Audit Fixes Verification Test Suite', () => {
  async function setupBook(bookId: string = 'audit3_book', basis: 'accrual' | 'cash' = 'accrual') {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: bookId, name: `Book ${bookId}`, basis },
      period: { id: `${bookId}:period:2026`, startDate: '2026-01-01', endDate: '2026-12-31' },
    });
    return {
      ...node,
      service: new V2AppService(node.runner),
      repo: new V2SqlRepository(node.runner),
      bookId,
      periodId: `${bookId}:period:2026`,
    };
  }

  describe('1. Tax Report and GL 2300 Reconcile', () => {
    it('correctly posts tax lines to Account 2300', async () => {
      const { runner, service, bookId } = await setupBook('book_tax_gl');
      await service.ensureParty('Acme Corp', 'customer');
      // Post invoice with tax
      await service.createInvoice({
        date: '2026-02-10',
        clientName: 'Acme Corp',
        amount: 110,
        subtotal: 100,
        tax: 10,
        taxRate: 10,
      });

      const reports = await buildPersistentV2Reports(runner, {
        bookId,
        from: '2026-02-01',
        to: '2026-02-28',
      });
      const taxAccount = reports.trialBalance.accounts.find((a) => a.code === '2300');
      expect(taxAccount).toBeDefined();
      expect(taxAccount?.normalBalance).toBe(10);
    });
  });

  describe('2. Vendor Bill Expense Safety & Postings', () => {
    it('debits 1200 Inventory for stock bills even with category metadata', async () => {
      const { repo, service, bookId, periodId } = await setupBook('book_bill_stock');
      const supp = await service.ensureParty('Stock Vendor', 'supplier');
      const result = await postPurchase(repo, {
        bookId,
        periodId,
        partyId: supp.id,
        date: '2026-03-01',
        amount: 500,
        method: 'cash',
        metadata: { category: 'Electronics' }, // arbitrary category should NOT make it 6000
      });

      const invLine = result.journal.lines.find((l: any) => l.accountId.endsWith(V2_ACCOUNT_CODES.INVENTORY));
      const expLine = result.journal.lines.find((l: any) => l.accountId.endsWith(V2_ACCOUNT_CODES.EXPENSES));
      expect(invLine).toBeDefined();
      expect(invLine?.debit).toBe(500);
      expect(expLine).toBeUndefined();
    });

    it('debits 6000 Expenses only when isExpense is explicitly true', async () => {
      const { repo, service, bookId, periodId } = await setupBook('book_bill_expense');
      const supp = await service.ensureParty('Office Landlord', 'supplier');
      const result = await postPurchase(repo, {
        bookId,
        periodId,
        partyId: supp.id,
        date: '2026-03-01',
        amount: 1200,
        method: 'cash',
        metadata: { isExpense: true, category: 'Rent' },
      });

      const expLine = result.journal.lines.find((l: any) => l.accountId.endsWith(V2_ACCOUNT_CODES.EXPENSES));
      expect(expLine).toBeDefined();
      expect(expLine?.debit).toBe(1200);
    });
  });

  describe('3. Supplier Notes Counterparts', () => {
    it('credits Account 1200 Inventory on supplier credit note for stock bills', async () => {
      const { repo, service, bookId, periodId } = await setupBook('book_note_stock');
      const supp = await service.ensureParty('Hardware Supplier', 'supplier');
      const cn = await postCreditNote(repo, {
        bookId,
        periodId,
        partyId: supp.id,
        date: '2026-03-10',
        amount: 150,
        role: 'supplier',
        reason: 'Damaged goods return',
      });

      const apLine = cn.journal.lines.find((l: any) => l.accountId.endsWith(V2_ACCOUNT_CODES.AP));
      const invLine = cn.journal.lines.find((l: any) => l.accountId.endsWith(V2_ACCOUNT_CODES.INVENTORY));
      expect(apLine?.debit).toBe(150);
      expect(invLine?.credit).toBe(150);
    });

    it('credits Account 6000 Expenses on supplier credit note for expense bills', async () => {
      const { repo, service, bookId, periodId } = await setupBook('book_note_expense');
      const supp = await service.ensureParty('Consulting Firm', 'supplier');
      const bill = await service.createBill({
        supplierName: 'Consulting Firm',
        date: '2026-03-05',
        amount: 800,
        paymentType: 'credit',
        isExpense: true,
      });

      const cn = await postCreditNote(repo, {
        bookId,
        periodId,
        partyId: supp.id,
        invoiceSourceId: bill.source.id,
        date: '2026-03-12',
        amount: 200,
        role: 'supplier',
        reason: 'Service discount',
      });

      const expLine = cn.journal.lines.find((l: any) => l.accountId.endsWith(V2_ACCOUNT_CODES.EXPENSES));
      expect(expLine?.credit).toBe(200);
    });
  });

  describe('4. AI Action Validation & UPI Normalization', () => {
    it('normalizes upi payment method to mobile in assistant proposals', () => {
      const proposal = validateAssistantProposal({
        type: 'create_supplier_payment',
        params: {
          supplierName: 'Fast Supplier',
          amount: 250,
          date: '2026-03-15',
          method: 'upi',
        },
      }, 'ai');

      expect(proposal.ok).toBe(true);
      if (proposal.ok) {
        expect(proposal.action.params.method).toBe('mobile');
      }
    });

    it('validates log_personal_expense proposal type', () => {
      const proposal = validateAssistantProposal({
        type: 'log_personal_expense',
        params: {
          amount: 50,
          date: '2026-03-15',
          category: 'Lunch',
        },
      }, 'ai');

      expect(proposal.ok).toBe(true);
    });
  });

  describe('5. Customer Advances in Party Detail (Account 2100)', () => {
    it('includes customer advances in getPartyDetail and reports advance balance', async () => {
      const { service } = await setupBook('book_cust_adv');
      const cust = await service.ensureParty('Advance Customer', 'customer');
      // Receive advance of $300 (no open invoices)
      await service.createReceipt({
        partyId: cust.id,
        clientName: 'Advance Customer',
        date: '2026-04-01',
        amount: 300,
        method: 'cash',
        mode: 'advance',
      });

      const detail = await service.getPartyDetail(cust.id, 'customer');
      expect(detail).not.toBeNull();
      expect(detail?.advanceBalance).toBe(300);
      expect(detail?.balance).toBe(-300); // customer has credit / advance
      expect(detail?.totalPaid).toBe(300);
    });
  });

  describe('6. Cash Movements includes All Payment Methods', () => {
    it('includes Card and Mobile cash movements in listCashMovements', async () => {
      const { service } = await setupBook('book_cash_mv');
      await service.ensureParty('Card Shopper', 'customer');
      // Create card sale
      await service.createSale({
        date: '2026-04-05',
        amount: 80,
        method: 'card',
      });
      // Create mobile receipt
      await service.createReceipt({
        clientName: 'Card Shopper',
        date: '2026-04-06',
        amount: 120,
        method: 'mobile',
        mode: 'cash_sale',
      });

      const movements = await service.listCashMovements();
      const amounts = movements.map((m: any) => m.amount);
      expect(amounts).toContain(80);
      expect(amounts).toContain(120);
    });
  });

  describe('7. Invoice Customer Change Guard', () => {
    it('rejects changing customer on invoice with active receipt allocations', async () => {
      const { service } = await setupBook('book_inv_guard');
      const custA = await service.ensureParty('Customer Alpha', 'customer');
      const custB = await service.ensureParty('Customer Beta', 'customer');

      const inv = await service.createInvoice({
        partyId: custA.id,
        clientName: 'Customer Alpha',
        date: '2026-04-10',
        amount: 400,
      });

      // Allocate receipt from Customer A
      await service.createReceipt({
        partyId: custA.id,
        clientName: 'Customer Alpha',
        date: '2026-04-11',
        amount: 200,
        method: 'cash',
        allocations: [{ invoiceSourceId: inv.source.id, amount: 200 }],
      });

      // Attempt to change customer on the invoice to Customer B
      await expect(
        service.updateInvoice(inv.source.id, {
          partyId: custB.id,
          customerId: custB.id,
          date: '2026-04-10',
          amount: 400,
        })
      ).rejects.toThrow(/Cannot change customer on an invoice that has active receipt allocations/);
    });
  });

  describe('8. Inventory Overview Calculates purchasesSince and salesSince', () => {
    it('calculates non-zero purchases and sales since audit', async () => {
      const { service } = await setupBook('book_inv_overview');
      await service.createBill({
        supplierName: 'Widget Supplier',
        date: '2026-05-01',
        amount: 600,
        paymentType: 'cash',
      });

      await service.createSale({
        date: '2026-05-02',
        amount: 950,
        method: 'cash',
      });

      const overview = await service.inventoryOverview();
      expect(overview).not.toBeNull();
      expect(overview?.purchasesSince).toBe(600);
      expect(overview?.salesSince).toBe(950);
    });
  });
});
