import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { getV2FeatureDisableBlockers } from '../src/accountingV2/featureDisableGuards';
import { makeNodeRunner } from './helpers/nodeRunner';

describe('feature disable guards', () => {
  it('scopes journal-line activity through the parent journal book', async () => {
    const { runner, close } = makeNodeRunner();
    try {
      await initializeV2Book(runner, {
        book: { id: 'book-1', name: 'Guard Test' },
        period: { id: 'period-1', startDate: '2026-01-01', endDate: '2026-12-31' },
      });
      await runner.run(
        'INSERT INTO v2_locations(id,book_id,name,archived) VALUES(?,?,?,0)',
        ['location-1', 'book-1', 'Main Shop'],
      );
      await runner.run(
        'INSERT INTO v2_journal_entries(id,book_id,period_id,source_id,date,memo,posted_at,reversal_of) VALUES(?,?,?,?,?,?,?,?)',
        ['journal-1', 'book-1', 'period-1', null, '2026-08-20', 'Inventory at shop', '2026-08-20T00:00:00.000Z', null],
      );
      const inventoryAccount = await runner.first<{ id: string }>(
        "SELECT id FROM v2_accounts WHERE book_id=? AND code='1200'",
        ['book-1'],
      );
      await runner.run(
        'INSERT INTO v2_journal_lines(journal_id,account_id,party_id,debit,credit,memo,location_id) VALUES(?,?,?,?,?,?,?)',
        ['journal-1', inventoryAccount!.id, null, 1, 0, 'Inventory at shop', 'location-1'],
      );

      await expect(getV2FeatureDisableBlockers(runner, 'book-1')).resolves.toMatchObject({
        inventory: expect.stringContaining('inventory ledger activity'),
        locations: expect.stringContaining('location-tagged ledger entries'),
      });
    } finally {
      close();
    }
  });
});
