import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2BookConfigRepository } from '../src/accountingV2/bookConfigRepository';
import type { AccountingPeriodPolicy } from '../src/accountingV2/config';

const BOOK = 'period-policy-book';

async function setup(startDate = '2026-01-01', endDate = '2026-12-31') {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: BOOK, name: 'Flexible Period Shop' },
    period: { id: `${BOOK}:initial`, startDate, endDate },
  });
  return {
    ...node,
    service: new V2AppService(node.runner),
    config: new V2BookConfigRepository(node.runner),
  };
}

async function setPolicy(repo: V2BookConfigRepository, policy: AccountingPeriodPolicy) {
  const current = await repo.getBookConfig(BOOK);
  return repo.updateBookConfig(BOOK, {
    style: current.style,
    basis: current.basis,
    selectedPersonas: current.selectedPersonas,
    activePersona: current.activePersona,
    retailPartnership: current.retailPartnership,
    periodPolicy: policy,
  });
}

const period = (runner: any) =>
  runner.first('SELECT id,start_date,end_date,status,close_snapshot FROM v2_periods WHERE book_id=? ORDER BY start_date LIMIT 1', [BOOK]);

describe('V2 accounting-period policy', () => {
  it('defaults old/new books to flexible and lets opening evidence expand both provisional boundaries', async () => {
    const { runner, close, service, config } = await setup();
    try {
      await expect(config.getBookConfig(BOOK)).resolves.toMatchObject({ periodPolicy: { mode: 'flexible' } });

      await service.postOpeningBalances({ date: '2025-06-30', cash: 50, inventory: 0 });
      expect(await period(runner)).toMatchObject({ start_date: '2025-06-30', end_date: '2026-12-31', status: 'open' });

      await service.importClosingBalances({
        date: '2027-02-01', cash: 100, inventory: 0, ownerCapital: 100, partnerCapitals: [],
      });
      expect(await period(runner)).toMatchObject({ start_date: '2025-06-30', end_date: '2027-02-01', status: 'open' });
      const live = await runner.all("SELECT id FROM v2_sources WHERE book_id=? AND type='opening_balance' AND json_extract(metadata,'$.reversed') IS NULL", [BOOK]);
      expect(live).toHaveLength(1);
      expect(await service.repo.accountBalance(BOOK, `${BOOK}:account:1000`)).toBe(100);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('persists optional fixed bounds and rejects an out-of-bound closing import without any write', async () => {
    const { runner, close, service, config } = await setup();
    try {
      await expect(setPolicy(config, { mode: 'fixed', startDate: '2026-01-01', endDate: '2026-12-31' }))
        .resolves.toMatchObject({ periodPolicy: { mode: 'fixed', startDate: '2026-01-01', endDate: '2026-12-31' } });
      await expect(service.importClosingBalances({
        date: '2027-01-01', cash: 100, inventory: 0, ownerCapital: 100, partnerCapitals: [],
      })).rejects.toThrow('Opening balance date 2027-01-01 is outside the fixed accounting period 2026-01-01 to 2026-12-31');
      expect(await period(runner)).toMatchObject({ start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' });
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(0);
    } finally { close(); }
  });

  it('does not let fixed-mode configuration exclude existing dated activity', async () => {
    const { runner, close, service, config } = await setup();
    try {
      await service.createSale({ date: '2026-06-15', amount: 25, method: 'cash' });
      await expect(setPolicy(config, { mode: 'fixed', startDate: '2026-01-01', endDate: '2026-05-31' }))
        .rejects.toThrow('Fixed accounting period cannot exclude existing activity dated 2026-06-15');
      await expect(config.getBookConfig(BOOK)).resolves.toMatchObject({ periodPolicy: { mode: 'flexible' } });
      expect(await period(runner)).toMatchObject({ start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' });
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('rejects closing before later activity, then closes on a later chosen date and makes the closed period immutable', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.createSale({ date: '2026-03-20', amount: 100, method: 'cash' });
      await expect(service.closeBooks({ date: '2026-03-15', actualStock: 0, openingInventory: 0, commissionPct: 0 }))
        .rejects.toThrow('Accounting period cannot close on 2026-03-15 because it contains activity dated 2026-03-20');
      expect(await period(runner)).toMatchObject({ end_date: '2026-12-31', status: 'open', close_snapshot: null });
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_inventory_counts WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_close_books WHERE book_id=?', [BOOK]))?.n)).toBe(0);

      await service.closeBooks({ date: '2026-03-31', actualStock: 0, openingInventory: 0, commissionPct: 0 });
      expect(await runner.first('SELECT start_date,end_date,status FROM v2_periods WHERE id=?', [`${BOOK}:initial`]))
        .toEqual({ start_date: '2026-01-01', end_date: '2026-03-31', status: 'closed' });
      expect(await runner.first('SELECT start_date,end_date,status FROM v2_periods WHERE book_id=? AND status=?', [BOOK, 'open']))
        .toEqual({ start_date: '2026-04-01', end_date: '9999-12-31', status: 'open' });
      await expect(service.createSale({ date: '2026-03-20', amount: 1, method: 'cash' })).rejects.toThrow(/closed period/i);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('rolls back boundary resizing, counts, rollover, and close state when a flexible close fails late', async () => {
    const { runner, close, service } = await setup();
    try {
      await runner.exec(`CREATE TRIGGER fail_flexible_close BEFORE INSERT ON v2_close_books
        BEGIN SELECT RAISE(FAIL, 'injected flexible close failure'); END;`);
      await expect(service.closeBooks({ date: '2026-02-28', actualStock: 0, openingInventory: 0, commissionPct: 0 }))
        .rejects.toThrow(/injected flexible close failure/);
      expect(await runner.all('SELECT start_date,end_date,status,close_snapshot FROM v2_periods WHERE book_id=?', [BOOK])).toEqual([
        { start_date: '2026-01-01', end_date: '2026-12-31', status: 'open', close_snapshot: null },
      ]);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_inventory_counts WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_close_books WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(0);
    } finally { close(); }
  });

  it('fixed mode closes only on its configured boundary, preserves its calendar span, and keeps the closed range immutable', async () => {
    const { runner, close, service, config } = await setup('2026-01-01', '2026-01-31');
    try {
      await setPolicy(config, { mode: 'fixed', startDate: '2026-01-01', endDate: '2026-01-31' });
      await expect(service.closeBooks({ date: '2026-01-20', actualStock: 0, openingInventory: 0, commissionPct: 0 }))
        .rejects.toThrow('Fixed accounting period must close on 2026-01-31');
      expect(await period(runner)).toMatchObject({ end_date: '2026-01-31', status: 'open', close_snapshot: null });

      await service.closeBooks({ date: '2026-01-31', actualStock: 0, openingInventory: 0, commissionPct: 0 });
      expect(await runner.first('SELECT start_date,end_date,status FROM v2_periods WHERE book_id=? AND status=?', [BOOK, 'open']))
        .toEqual({ start_date: '2026-02-01', end_date: '2026-02-28', status: 'open' });
      await expect(config.getBookConfig(BOOK)).resolves.toMatchObject({
        periodPolicy: { mode: 'fixed', startDate: '2026-02-01', endDate: '2026-02-28' },
      });
      await expect(service.postOpeningBalances({ date: '2026-01-15', cash: 1, inventory: 0 })).rejects.toThrow(/closed period/i);
    } finally { close(); }
  });
});
