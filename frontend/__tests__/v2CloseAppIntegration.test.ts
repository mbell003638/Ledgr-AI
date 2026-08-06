import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService, createCloseBooksRouter } from '../src/accountingV2/appService';

describe('V2 close-books application integration', () => {
  async function setup() {
    const node = makeNodeRunner();
    await initializeV2Book(node.runner, {
      book: { id: 'active-v2', name: 'Active V2' },
      period: { id: 'jan-2026', startDate: '2026-01-01', endDate: '2026-01-31' },
      members: [{ name: 'Owner', openingContribution: 100, profitSharePct: 100 }],
    });
    return { ...node, service: new V2AppService(node.runner) };
  }

  it('closes the active V2 period, ensures inventory counts, and creates the next period', async () => {
    const { runner, close, service } = await setup();
    try {
      const result = await service.closeBooks({ actualStock: 125, openingInventory: 80, commissionPct: 7.5 });

      expect(result.source).toBe('v2');
      expect(result.result.snapshot).toEqual(expect.objectContaining({
        openingInventory: 80,
        closingInventory: 125,
        commission: 3.38,
      }));
      expect(await runner.first('SELECT status FROM v2_periods WHERE id=?', ['jan-2026'])).toEqual({ status: 'closed' });
      expect(await runner.first('SELECT start_date,end_date,status FROM v2_periods WHERE book_id=? AND start_date=?', ['active-v2', '2026-02-01']))
        .toEqual({ start_date: '2026-02-01', end_date: '2026-02-28', status: 'open' });
      expect(await runner.all('SELECT period_id,date,value FROM v2_inventory_counts ORDER BY date')).toEqual([
        { period_id: 'jan-2026', date: '2026-01-01', value: 80 },
        { period_id: 'jan-2026', date: '2026-01-31', value: 125 },
        { period_id: 'active-v2:period:2026-02-01', date: '2026-02-01', value: 125 },
      ]);
    } finally { close(); }
  });

  it('uses an existing following period and does not duplicate existing opening inventory', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.repo.createPeriod({ id: 'feb', bookId: 'active-v2', startDate: '2026-02-01', endDate: '2026-02-28', status: 'open' });
      await runner.run('INSERT INTO v2_inventory_counts(id,book_id,period_id,date,value) VALUES(?,?,?,?,?)', ['opening', 'active-v2', 'jan-2026', '2026-01-01', 90]);
      const result = await service.closeBooks({ actualStock: 110, openingInventory: 999, commissionPct: 0 });
      expect(result.result.snapshot.openingInventory).toBe(90);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_periods'))?.n)).toBe(2);
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_inventory_counts WHERE period_id='jan-2026' AND date='2026-01-01'"))?.n)).toBe(1);
    } finally { close(); }
  });

  it('settles manager commission payable through a V2 commission payment', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.createSale({ date: '2026-01-10', amount: 100, method: 'cash' });
      const closed = await service.closeBooks({ actualStock: 0, openingInventory: 0, commissionPct: 10 });
      expect(closed.result.snapshot.commission).toBe(10);

      const payment = await service.createPayment({ date: '2026-02-01', amount: 6, type: 'commission_payment', method: 'cash' });
      expect(payment.source.type).toBe('commission_payment');
      expect(-await service.repo.accountBalance('active-v2', 'active-v2:account:2200')).toBe(4);
      await expect(service.createPayment({ date: '2026-02-02', amount: 5, type: 'commission_payment', method: 'cash' }))
        .rejects.toThrow(/exceeds the commission payable/i);

      await service.deletePayment(payment.source.id);
      expect(-await service.repo.accountBalance('active-v2', 'active-v2:account:2200')).toBe(10);
      expect((await service.repo.reconcileBook('active-v2')).balanced).toBe(true);
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_sources WHERE type='commission_payment'"))?.n)).toBe(1);
    } finally { close(); }
  });

  it('falls back to legacy only when no active versioned V2 book exists', async () => {
    const { runner, close, service } = await setup();
    const legacy = jest.fn(async (actualStock: number, notes: string) => ({ legacy: true, actualStock, notes }));
    const closeBooks = createCloseBooksRouter(service, legacy);
    try {
      await closeBooks({ actualStock: 10, openingInventory: 5, commissionPct: 0, notes: 'v2' });
      expect(legacy).not.toHaveBeenCalled();

      await runner.run("DELETE FROM meta WHERE key='v2_active_book_id'");
      await expect(closeBooks({ actualStock: 12, openingInventory: 5, commissionPct: 0, notes: 'legacy' }))
        .resolves.toEqual({ legacy: true, actualStock: 12, notes: 'legacy' });
      expect(legacy).toHaveBeenCalledTimes(1);
    } finally { close(); }
  });
});
