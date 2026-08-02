import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2AppService } from '../src/accountingV2/appService';
import { postOpeningBalance } from '../src/accountingV2/postings';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';

describe('V2 Opening Balance and Physical Stock Reconciliation', () => {
  it('posts opening cash and opening inventory into V2 journal keeping trial balance balanced', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const repo = new V2SqlRepository(runner);
      const res = await postOpeningBalance(repo, {
        bookId: book.bookId,
        periodId: book.periodId,
        date: '2026-01-01',
        cash: 1000,
        inventory: 5000,
      });

      expect(res).toHaveLength(2);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
      expect(v2Report.trialBalance.totals.debit).toBe(6000);
      expect(v2Report.trialBalance.totals.credit).toBe(6000);
    } finally {
      close();
    }
  });

  it('records physical stock count audit and posts inventory adjustment to COGS', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const book = await initializeV2Book(runner, {
        book: { id: 'test-book', name: 'Test Store', style: 'standard', basis: 'accrual' },
        period: { id: 'test-book:period:2026-01-01', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      const repo = new V2SqlRepository(runner);
      await postOpeningBalance(repo, {
        bookId: book.bookId,
        periodId: book.periodId,
        date: '2026-01-01',
        inventory: 5000,
      });

      const service = new V2AppService(runner);
      const auditRes = await service.createInventory({
        date: '2026-07-01',
        expectedStock: 5000,
        actualStock: 4800,
        notes: 'Mid-year physical stock audit',
      });

      expect(auditRes.countId).toBeDefined();

      const counts = await runner.all('SELECT * FROM v2_inventory_counts WHERE book_id=?', [book.bookId]);
      expect(counts.length).toBeGreaterThanOrEqual(1);

      const v2Report = await buildPersistentV2Reports(runner, { bookId: book.bookId });
      expect(v2Report.reconciliation.ok).toBe(true);
    } finally {
      close();
    }
  });
});
