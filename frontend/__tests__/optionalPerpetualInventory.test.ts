import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
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
});
