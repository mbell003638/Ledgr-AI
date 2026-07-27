import { makeNodeRunner } from './helpers/nodeRunner';
import { defaultAccounts } from '../src/accountingV2/schema';
import {
  ACCOUNTING_V2_ENABLED,
  V2_BOOK_VERSION,
  accountingBookVersion,
  initializeV2Book,
} from '../src/accountingV2/appBootstrap';

describe('V2 authoritative book bootstrap', () => {
  it('creates a versioned SQLite book with accounts, an open period, personas, and members', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      const result = await initializeV2Book(runner, {
        book: {
          id: 'shop-a', name: 'Shop A', style: 'retail_partnership', basis: 'accrual',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
        period: { startDate: '2026-01-01', endDate: '2026-12-31' },
        personas: ['retail', 'wholesale'],
        members: [
          { name: 'Amit', openingContribution: 600, profitSharePct: 60 },
          { name: 'Sam', openingContribution: 400, profitSharePct: 40 },
        ],
      });

      expect(ACCOUNTING_V2_ENABLED).toBe(true);
      expect(V2_BOOK_VERSION).toBe(2);
      expect(result).toMatchObject({ bookId: 'shop-a', version: 2, periodId: 'shop-a:period:2026-01-01' });
      await expect(accountingBookVersion(runner, 'shop-a')).resolves.toBe(2);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_accounts WHERE book_id=?', ['shop-a']))?.n))
        .toBe(defaultAccounts('shop-a').length);
      expect(await runner.first('SELECT start_date,end_date,status FROM v2_periods WHERE book_id=?', ['shop-a']))
        .toEqual({ start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' });
      expect(await runner.all('SELECT type,active FROM v2_personas WHERE book_id=? ORDER BY rowid', ['shop-a']))
        .toEqual([{ type: 'retail', active: 1 }, { type: 'wholesale', active: 0 }]);
      expect(await runner.all('SELECT name,opening_contribution,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY rowid', ['shop-a']))
        .toEqual([
          { name: 'Amit', opening_contribution: 600, profit_share_pct: 60 },
          { name: 'Sam', opening_contribution: 400, profit_share_pct: 40 },
        ]);
    } finally { close(); }
  });

  it('keeps V2 books isolated in SQLite and never uses legacy secondary-book routing', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'one', name: 'One' },
        period: { startDate: '2026-01-01', endDate: '2026-12-31' },
        personas: ['retail'],
        members: [{ name: 'First', openingContribution: 10, profitSharePct: 100 }],
      });
      await initializeV2Book(runner, {
        book: { id: 'two', name: 'Two' },
        period: { startDate: '2027-01-01', endDate: '2027-12-31' },
        personas: ['professional_service'],
        members: [{ name: 'Second', openingContribution: 20, profitSharePct: 100 }],
      });

      expect(await runner.all('SELECT name FROM v2_members WHERE book_id=?', ['one'])).toEqual([{ name: 'First' }]);
      expect(await runner.all('SELECT name FROM v2_members WHERE book_id=?', ['two'])).toEqual([{ name: 'Second' }]);
      expect(await runner.all('SELECT type FROM v2_personas WHERE book_id=?', ['one'])).toEqual([{ type: 'retail' }]);
      expect(await runner.all('SELECT type FROM v2_personas WHERE book_id=?', ['two'])).toEqual([{ type: 'professional_service' }]);
      expect(await accountingBookVersion(runner, 'one')).toBe(2);
      expect(await accountingBookVersion(runner, 'two')).toBe(2);
    } finally { close(); }
  });
});
