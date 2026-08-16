import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';

describe('local ERP control domain', () => {
  it('supports idempotent draft, approval, posting, and audit history', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, { book: { id: 'control_book', name: 'Control Book', style: 'standard', basis: 'accrual' }, personas: ['small_business'], period: { startDate: '2026-01-01', endDate: '2026-12-31' } });
      const service = new V2AppService(runner);
      const input = { actionType: 'add_expense', idempotencyKey: 'expense:abc', payload: { amount: 25, category: 'Software' }, preview: 'Record software expense of 25', requestedBy: 'ai', confidence: 0.92 };
      const first = await service.createWorkflowDraft(input);
      const second = await service.createWorkflowDraft(input);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('draft');
      await service.submitWorkflow(first.id, 'user');
      await service.approveWorkflow(first.id, 'user');
      const posted = await service.markWorkflowPosted(first.id, undefined, 'system');
      expect(posted.status).toBe('posted');
      expect((await service.listAuditEvents(first.id)).map((row: any) => row.event_type)).toEqual(['workflow_draft_created', 'workflow_submitted', 'workflow_approved', 'workflow_posted']);
      await expect(service.approveWorkflow(first.id, 'user')).rejects.toThrow(/current status is posted/i);
    } finally { close(); }
  });

  it('supports local budgets, variance reporting, and recurring templates', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, { book: { id: 'planning_book', name: 'Planning Book', style: 'standard', basis: 'accrual' }, personas: ['small_business'], period: { startDate: '2026-01-01', endDate: '2026-12-31' } });
      const service = new V2AppService(runner);
      const budget = await service.createBudget({ name: 'January plan', periodStart: '2026-01-01', periodEnd: '2026-01-31' });
      await service.addBudgetLine({ budgetId: budget.id, accountCode: '6000', amount: 500 });
      expect((await service.listBudgets())[0].budget_total).toBe(500);
      expect((await service.budgetVariance(budget.id))[0]).toMatchObject({ account_code: '6000', budget_amount: 500 });
      const recurring = await service.createRecurringTemplate({ actionType: 'invoice', frequency: 'monthly', nextDate: '2026-02-01', payload: { customerId: 'customer-1' } });
      expect((await service.listRecurringTemplates())[0].id).toBe(recurring.id);
    } finally { close(); }
  });

  it('stages direct integrations, sync work, tax profiles, and bank feed rows locally', async () => {
    const { close } = makeNodeRunner();
    const node = makeNodeRunner();
    try {
      await initializeV2Book(node.runner, { book: { id: 'control_book_2', name: 'Control Book 2', style: 'standard', basis: 'accrual' }, personas: ['small_business'], period: { startDate: '2026-01-01', endDate: '2026-12-31' } });
      const service = new V2AppService(node.runner);
      await service.upsertIntegration({ provider: 'csv', kind: 'bank_feed', displayName: 'Local CSV import', enabled: true, config: { mode: 'file_picker' } });
      await service.enqueueSync({ provider: 'csv', kind: 'bank_feed_import', idempotencyKey: 'csv:1', payload: { filename: 'bank.csv' } });
      await service.upsertTaxProfile({ countryCode: 'IN', taxLabel: 'GST', defaultRate: 18 });
      const feed = await service.importBankFeedRows('csv', [{ externalId: 'row-1', date: '2026-01-10', amount: -42, currency: 'INR', description: 'Office supplies' }]);
      expect(feed.inserted).toBe(1);
      expect((await service.listIntegrations()).length).toBe(1);
      expect((await service.listPendingSync()).length).toBe(1);
      expect((await service.listTaxProfiles())[0].country_code).toBe('IN');
      expect((await service.listBankFeedEntries())[0].external_id).toBe('row-1');
    } finally { node.close(); close(); }
  });
});
