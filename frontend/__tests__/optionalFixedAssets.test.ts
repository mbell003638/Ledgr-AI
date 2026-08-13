import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { FixedAssetDomainService } from '../src/accountingV2/services/fixedAssetDomainService';

async function setup(enabled = true) {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('book-assets', 'Asset Shop');
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'period-open', bookId: book.id, startDate: '2026-01-01', endDate: '2027-12-31', status: 'open' });
  if (enabled) {
    await node.runner.run("INSERT INTO settings(key,value) VALUES('main',?)", [JSON.stringify({ enabledFeatures: ['fixedAssets'] })]);
  }
  const assets = new FixedAssetDomainService(node.runner, repo, async () => ({ bookId: book.id, periodId: 'period-open' }));
  return { ...node, repo, book, assets };
}

describe('optional fixed assets domain service', () => {
  it('throws when acquiring an asset without the fixedAssets feature', async () => {
    const { close, assets } = await setup(false);
    try {
      await expect(assets.acquireAsset({
        name: 'Laptop',
        category: 'computer',
        date: '2026-07-01',
        cost: 1200,
        residual: 0,
        usefulLifeMonths: 12,
        funding: 'cash',
      })).rejects.toThrow(/fixedAssets|Customize Features/i);
    } finally { close(); }
  });

  it('buys a computer for cash and posts monthly straight-line depreciation', async () => {
    const { runner, close, book, assets } = await setup(true);
    try {
      const acquired = await assets.acquireAsset({
        name: 'Laptop',
        category: 'computer',
        date: '2026-07-01',
        cost: 1200,
        residual: 0,
        usefulLifeMonths: 12,
        funding: 'cash',
      });
      expect(acquired.source.type).toBe('fixed_asset');
      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [acquired.journal.id])).toEqual([
        { account_id: `${book.id}:account:1400`, debit: 1200, credit: 0 },
        { account_id: `${book.id}:account:1000`, debit: 0, credit: 1200 },
      ]);

      const first = await assets.postDepreciation({ assetId: acquired.asset.id, date: '2026-07-31' });
      expect(first.amount).toBe(100);
      expect(first.source.type).toBe('depreciation');
      expect(await runner.all('SELECT account_id,debit,credit FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [first.journal.id])).toEqual([
        { account_id: `${book.id}:account:6300`, debit: 100, credit: 0 },
        { account_id: `${book.id}:account:1450`, debit: 0, credit: 100 },
      ]);
      const listed = await assets.listAssets();
      expect(listed).toHaveLength(1);
      expect(listed[0].accumulatedDepreciation).toBe(100);
      expect(listed[0].netBookValue).toBe(1100);
    } finally { close(); }
  });

  it('posts the 12th remaining 100 and throws on the 13th month', async () => {
    const { close, assets } = await setup(true);
    try {
      const acquired = await assets.acquireAsset({
        name: 'Laptop',
        category: 'computer',
        date: '2026-01-01',
        cost: 1200,
        residual: 0,
        usefulLifeMonths: 12,
        funding: 'cash',
      });
      for (let month = 0; month < 11; month++) {
        const date = `2026-${String(month + 1).padStart(2, '0')}-28`;
        await assets.postDepreciation({ assetId: acquired.asset.id, date });
      }
      const twelfth = await assets.postDepreciation({ assetId: acquired.asset.id, date: '2026-12-28' });
      expect(twelfth.amount).toBe(100);
      const listed = await assets.listAssets();
      expect(listed[0].accumulatedDepreciation).toBe(1200);
      expect(listed[0].netBookValue).toBe(0);
      await expect(assets.postDepreciation({ assetId: acquired.asset.id, date: '2027-01-28' })).rejects.toThrow(/fully depreciated|remaining/i);
    } finally { close(); }
  });
});
