import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';

async function setup() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, { book: { id: 'project_creator_book', name: 'Project Creator Book', style: 'standard', basis: 'accrual' }, personas: ['developer', 'content_creator'], period: { startDate: '2026-07-01', endDate: '2026-07-31' } });
  return { ...node, service: new V2AppService(node.runner) };
}

describe('project and creator vertical domain', () => {
  it('records project time and costs with a profitability view while posting costs to V2', async () => {
    const { runner, close, service } = await setup();
    try {
      const project = await service.createProject({ name: 'Mobile App Build', budget: 1000 });
      await service.addProjectTime({ projectId: project.id, date: '2026-07-10', hours: 10, rate: 80 });
      const cost = await service.recordProjectCost({ projectId: project.id, date: '2026-07-11', amount: 120, description: 'Cloud and subcontractor cost' });
      expect(cost.amount).toBe(120);
      const rows = await service.listProjects();
      expect(rows[0]).toMatchObject({ id: project.id, time_value: 800, costs: 120 });
      expect(await runner.first('SELECT COUNT(*) AS count FROM v2_journal_entries WHERE source_id=?', [cost.sourceId])).toEqual({ count: 1 });
    } finally { close(); }
  });

  it('posts creator payouts and marks a contract paid once its agreed amount is met', async () => {
    const { runner, close, service } = await setup();
    try {
      const contract = await service.createCreatorContract({ brand: 'Northstar Media', campaign: 'Launch Series', agreedAmount: 500 });
      await service.recordCreatorPayout({ contractId: contract.id, date: '2026-07-12', amount: 300, method: 'bank' });
      await service.recordCreatorPayout({ contractId: contract.id, date: '2026-07-20', amount: 200, method: 'bank' });
      const rows = await service.listCreatorContracts();
      expect(rows[0]).toMatchObject({ id: contract.id, paid: 500, status: 'paid' });
      const balance = await runner.first<{ difference: number }>('SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) AS difference FROM v2_journal_entries j JOIN v2_journal_lines l ON l.journal_id=j.id WHERE j.book_id=?', ['project_creator_book']);
      expect(balance?.difference).toBe(0);
    } finally { close(); }
  });
});
