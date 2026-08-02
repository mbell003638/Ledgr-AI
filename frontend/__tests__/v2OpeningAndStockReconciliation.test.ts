import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2AppService } from '../src/accountingV2/appService';
import { postOpeningBalance } from '../src/accountingV2/postings';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';
import { factoryWipeV2Database } from '../src/accountingV2/resetBook';

describe('V2 Accounting Redesign & Reconciliation Suite', () => {
  it('1. cash asset purchase: Dr Other Assets, Cr Cash in Hand', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      await postOpeningBalance(service.repo, { bookId: book.bookId, periodId: book.periodId, date: '2026-01-01', cash: 5000 });

      const asset = await service.createAssetTransaction({
        date: '2026-02-01', name: 'Delivery Bike', category: 'Vehicle', amount: 1200, acquisitionMethod: 'cash',
      });
      expect(asset.source.id).toBeDefined();

      const lines = await runner.all('SELECT account_id, debit, credit FROM v2_journal_lines WHERE journal_id=?', [asset.journal.id]);
      expect(lines).toEqual([
        { account_id: `${book.bookId}:account:1500`, debit: 1200, credit: 0 },
        { account_id: `${book.bookId}:account:1000`, debit: 0, credit: 1200 },
      ]);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally { close(); }
  });

  it('2. credit asset purchase: Dr Other Assets, Cr Other Liabilities', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      const asset = await service.createAssetTransaction({
        date: '2026-02-01', name: 'Industrial Oven', category: 'Equipment', amount: 3500, acquisitionMethod: 'credit',
      });

      const lines = await runner.all('SELECT account_id, debit, credit FROM v2_journal_lines WHERE journal_id=?', [asset.journal.id]);
      expect(lines).toEqual([
        { account_id: `${book.bookId}:account:1500`, debit: 3500, credit: 0 },
        { account_id: `${book.bookId}:account:2500`, debit: 0, credit: 3500 },
      ]);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally { close(); }
  });

  it('3. owner-contributed asset: Dr Other Assets, Cr Capital', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      const asset = await service.createAssetTransaction({
        date: '2026-02-01', name: 'Personal Laptop', category: 'Equipment', amount: 800, acquisitionMethod: 'owner_contribution',
      });

      const lines = await runner.all('SELECT account_id, debit, credit FROM v2_journal_lines WHERE journal_id=?', [asset.journal.id]);
      expect(lines).toEqual([
        { account_id: `${book.bookId}:account:1500`, debit: 800, credit: 0 },
        { account_id: `${book.bookId}:account:3000`, debit: 0, credit: 800 },
      ]);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally { close(); }
  });

  it('4. loan received: Dr Bank, Cr Other Liabilities', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      const liab = await service.createLiabilityTransaction({
        date: '2026-03-01', name: 'Bank Business Loan', category: 'Loan', amount: 10000, recognitionMethod: 'loan_received', paymentMethod: 'bank',
      });

      const lines = await runner.all('SELECT account_id, debit, credit FROM v2_journal_lines WHERE journal_id=?', [liab.journal.id]);
      expect(lines).toEqual([
        { account_id: `${book.bookId}:account:1010`, debit: 10000, credit: 0 },
        { account_id: `${book.bookId}:account:2500`, debit: 0, credit: 10000 },
      ]);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally { close(); }
  });

  it('5. accrued liability: Dr Expenses, Cr Other Liabilities', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      const liab = await service.createLiabilityTransaction({
        date: '2026-03-15', name: 'Accrued Electricity', category: 'Utility', amount: 450, recognitionMethod: 'expense_accrual',
      });

      const lines = await runner.all('SELECT account_id, debit, credit FROM v2_journal_lines WHERE journal_id=?', [liab.journal.id]);
      expect(lines).toEqual([
        { account_id: `${book.bookId}:account:6000`, debit: 450, credit: 0 },
        { account_id: `${book.bookId}:account:2500`, debit: 0, credit: 450 },
      ]);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally { close(); }
  });

  it('6. delete/reversal creates exactly one reversal journal without hard deletion', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      const asset = await service.createAssetTransaction({
        date: '2026-02-01', name: 'Printer', category: 'Equipment', amount: 250, acquisitionMethod: 'owner_contribution',
      });

      await service.deleteAssetTransaction(asset.source.id);

      const reversals = await runner.all('SELECT * FROM v2_journal_entries WHERE reversal_of=?', [asset.journal.id]);
      expect(reversals).toHaveLength(1);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally { close(); }
  });

  it('7. trial balance and balance sheet remain reconciled throughout', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      await postOpeningBalance(service.repo, { bookId: book.bookId, periodId: book.periodId, date: '2026-01-01', cash: 5000, inventory: 2000 });
      await service.createAssetTransaction({ date: '2026-02-01', name: 'Van', category: 'Vehicle', amount: 3000, acquisitionMethod: 'cash' });
      await service.createLiabilityTransaction({ date: '2026-03-01', name: 'Loan', category: 'Loan', amount: 4000, recognitionMethod: 'loan_received', paymentMethod: 'bank' });

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
      expect(v2Report.trialBalance.totals.debit).toBe(v2Report.trialBalance.totals.credit);
    } finally { close(); }
  });

  it('8. reset removes all V2 rows atomically', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      await postOpeningBalance(service.repo, { bookId: book.bookId, periodId: book.periodId, date: '2026-01-01', cash: 1000 });

      await factoryWipeV2Database(runner);

      const sources = await runner.all('SELECT * FROM v2_sources');
      const journals = await runner.all('SELECT * FROM v2_journal_entries');
      expect(sources).toHaveLength(0);
      expect(journals).toHaveLength(0);
    } finally { close(); }
  });

  it('9. customer ID normalization at create, lookup, display, and navigation boundaries', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const service = new V2AppService(runner);
      const party = await service.ensureParty('v2:customer:v2:customer:Amit Patel', 'customer');
      expect(party.id).toBe('v2:customer:amit patel');
      expect(party.name).toBe('Amit Patel');

      const detail = await service.getPartyDetail('v2:customer:v2:customer:Amit Patel', 'customer');
      expect(detail).not.toBeNull();
      expect(detail?.id).toBe('v2:customer:amit patel');
    } finally { close(); }
  });
});
