import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import { buildPersistentV2Reports } from '../src/accountingV2/persistentReports';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { ProductDomainService } from '../src/accountingV2/services/productDomainService';

const BOOK = 'active-v2';
const PERIOD = 'open-2026';
const DATE = '2026-07-01';

async function setup(enabled: boolean) {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: BOOK, name: 'Stock Shop' },
    period: { id: PERIOD, startDate: '2026-01-01', endDate: '2026-12-31' },
  });
  if (enabled) {
    await node.runner.run(
      "INSERT INTO settings(key,value) VALUES('main',?)",
      [JSON.stringify({ enabledFeatures: ['perpetualInventory'] })],
    );
  }
  const repo = new V2SqlRepository(node.runner);
  const products = new ProductDomainService(node.runner, repo, async () => ({ bookId: BOOK, periodId: PERIOD }));
  return { ...node, repo, products };
}

async function dummySource(runner: { run: (sql: string, params?: any[]) => Promise<void> }, id = 'src-sale') {
  await runner.run(
    'INSERT INTO v2_sources(id,book_id,type,date,reference,metadata) VALUES(?,?,?,?,?,?)',
    [id, BOOK, 'cash_sale', DATE, null, '{}'],
  );
  return id;
}

async function seedProduct(
  runner: { run: (sql: string, params?: any[]) => Promise<void> },
  opts: { id?: string; qty: number; cost: number },
) {
  const id = opts.id || 'prod-widget';
  await runner.run(
    'INSERT INTO v2_products(id,book_id,sku,name,unit,cost,price,qty,archived) VALUES(?,?,?,?,?,?,?,?,0)',
    [id, BOOK, 'SKU-1', 'Widget', 'ea', opts.cost, 10, opts.qty],
  );
  return id;
}

async function productQty(runner: { first: <T>(sql: string, params?: any[]) => Promise<T | null> }, id: string) {
  const row = await runner.first<{ qty: number }>('SELECT qty FROM v2_products WHERE id=?', [id]);
  return Number(row?.qty);
}

async function cogsLines(runner: { all: <T>(sql: string, params?: any[]) => Promise<T[]> }, sourceId: string) {
  return runner.all<{ code: string; debit: number; credit: number }>(
    `SELECT a.code, l.debit, l.credit
     FROM v2_journal_lines l
     JOIN v2_journal_entries j ON j.id = l.journal_id
     JOIN v2_accounts a ON a.id = l.account_id
     WHERE j.source_id=? AND a.code IN ('5000','1200')
     ORDER BY a.code`,
    [sourceId],
  );
}

describe('optional perpetual inventory', () => {
  it('applySaleLines is a no-op when the module is off, even if a product exists', async () => {
    const { runner, close, products } = await setup(false);
    try {
      const productId = await seedProduct(runner, { qty: 10, cost: 5 });
      const sourceId = await dummySource(runner);
      await products.applySaleLines(BOOK, PERIOD, DATE, sourceId, [{ productId, qty: 3 }]);
      expect(await productQty(runner, productId)).toBe(10);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_stock_moves'))?.n)).toBe(0);
      expect(await cogsLines(runner, sourceId)).toEqual([]);
    } finally { close(); }
  });

  it('sale of qty 3 from 10 at cost 5 leaves qty 7 and posts COGS 15 on 5000/1200', async () => {
    const { runner, close, products } = await setup(true);
    try {
      const created = await products.upsertProduct({ name: 'Widget', cost: 5, price: 10, openingQty: 10 });
      const sourceId = await dummySource(runner);
      await products.applySaleLines(BOOK, PERIOD, DATE, sourceId, [{ productId: created.id, qty: 3 }]);
      expect(await productQty(runner, created.id)).toBe(7);
      expect(await cogsLines(runner, sourceId)).toEqual([
        { code: '1200', debit: 0, credit: 15 },
        { code: '5000', debit: 15, credit: 0 },
      ]);
    } finally { close(); }
  });

  it('sale qty 20 throws insufficient stock', async () => {
    const { runner, close, products } = await setup(true);
    try {
      const created = await products.upsertProduct({ name: 'Widget', cost: 5, price: 10, openingQty: 10 });
      const sourceId = await dummySource(runner);
      await expect(products.applySaleLines(BOOK, PERIOD, DATE, sourceId, [{ productId: created.id, qty: 20 }]))
        .rejects.toThrow(/insufficient/i);
      expect(await productQty(runner, created.id)).toBe(10);
    } finally { close(); }
  });

  it('reports use posted perpetual COGS only and do not inject extra periodic COGS', async () => {
    const { runner, close, products } = await setup(true);
    try {
      const created = await products.upsertProduct({ name: 'Widget', cost: 5, price: 10, openingQty: 10 });
      const sourceId = await dummySource(runner);
      await products.applySaleLines(BOOK, PERIOD, DATE, sourceId, [{ productId: created.id, qty: 3 }]);
      // Count that would make periodic COGS > 0 (0 + 35 net 1200 − 0 = 35) if injected.
      const closeRepo = new V2CloseBooksRepository(runner);
      await closeRepo.recordInventoryCount({ id: 'count-1', bookId: BOOK, periodId: PERIOD, date: DATE, value: 0 });
      const reports = await buildPersistentV2Reports(runner, { bookId: BOOK });
      expect(reports.profitAndLoss.cogs).toBe(15);
      expect(reports.profitAndLoss.expenses).toBe(15);
      expect(reports.profitAndLoss.netProfit).toBe(-15);
      expect(reports.details.some((row) => row.journalId === 'periodic-cogs')).toBe(false);
    } finally { close(); }
  });

  it('closeBooks with a count does not post a second periodic 5000 for the same sale', async () => {
    const { runner, close, repo, products } = await setup(true);
    try {
      const created = await products.upsertProduct({ name: 'Widget', cost: 5, price: 10, openingQty: 10 });
      const sourceId = await dummySource(runner);
      await products.applySaleLines(BOOK, PERIOD, DATE, sourceId, [{ productId: created.id, qty: 3 }]);
      await repo.createPeriod({ id: 'next-2027', bookId: BOOK, startDate: '2027-01-01', endDate: '2027-12-31', status: 'open' });
      const closeRepo = new V2CloseBooksRepository(runner);
      await closeRepo.recordInventoryCount({ id: 'count-1', bookId: BOOK, periodId: PERIOD, date: DATE, value: 0 });
      const result = await closeRepo.closeBooks({
        id: 'close-p', bookId: BOOK, periodId: PERIOD, nextPeriodId: 'next-2027', date: '2026-12-31', commissionPct: 0,
      });
      expect(result.snapshot.cogs).toBe(15);
      const periodic = await runner.all<{ id: string }>(
        "SELECT id FROM v2_journal_entries WHERE memo='Cost of goods sold (periodic)'",
      );
      expect(periodic).toHaveLength(0);
      const cogsPosts = await runner.all<{ memo: string; debit: number; credit: number }>(
        `SELECT j.memo, l.debit, l.credit
         FROM v2_journal_lines l
         JOIN v2_journal_entries j ON j.id = l.journal_id
         JOIN v2_accounts a ON a.id = l.account_id
         WHERE a.code='5000'
         ORDER BY j.memo`,
      );
      expect(cogsPosts).toEqual([
        { memo: 'Period close', debit: 0, credit: 15 },
        { memo: 'Stock COGS', debit: 15, credit: 0 },
      ]);
    } finally { close(); }
  });

  it('applyPurchaseLines qty 4 cost 5 after a qty-3 sale leaves qty 11', async () => {
    const { runner, close, products } = await setup(true);
    try {
      const created = await products.upsertProduct({ name: 'Widget', cost: 5, price: 10, openingQty: 10 });
      const saleSource = await dummySource(runner, 'src-sale');
      await products.applySaleLines(BOOK, PERIOD, DATE, saleSource, [{ productId: created.id, qty: 3 }]);
      const buySource = await dummySource(runner, 'src-buy');
      await products.applyPurchaseLines(BOOK, PERIOD, DATE, buySource, [{ productId: created.id, qty: 4, unitCost: 5 }]);
      expect(await productQty(runner, created.id)).toBe(11);
    } finally { close(); }
  });

  it('reverseMovesForSource restores sale qty and deletes the sale moves', async () => {
    const { runner, close, products } = await setup(true);
    try {
      const productId = await seedProduct(runner, { qty: 10, cost: 5 });
      const sourceId = await dummySource(runner);
      await products.applySaleLines(BOOK, PERIOD, DATE, sourceId, [{ productId, qty: 3 }]);
      expect(await productQty(runner, productId)).toBe(7);
      await products.reverseMovesForSource(BOOK, sourceId);
      expect(await productQty(runner, productId)).toBe(10);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_stock_moves'))?.n)).toBe(0);
    } finally { close(); }
  });

  it('reverseMovesForSource restores purchase qty and deletes the purchase moves', async () => {
    const { runner, close, products } = await setup(true);
    try {
      const productId = await seedProduct(runner, { qty: 10, cost: 5 });
      const sourceId = await dummySource(runner, 'src-buy');
      await products.applyPurchaseLines(BOOK, PERIOD, DATE, sourceId, [{ productId, qty: 4, unitCost: 5 }]);
      expect(await productQty(runner, productId)).toBe(14);
      await products.reverseMovesForSource(BOOK, sourceId);
      expect(await productQty(runner, productId)).toBe(10);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_stock_moves'))?.n)).toBe(0);
    } finally { close(); }
  });
});
