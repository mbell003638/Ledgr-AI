import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { isOptionalModuleEnabled, requireOptionalModule } from '../optionalModules';
import { V2_ACCOUNT_CODES } from '../types';
import { mulMoney, round2 } from '../../money';

type ActiveContext = { bookId: string; periodId: string };
type ProductRow = {
  id: string;
  book_id: string;
  sku: string | null;
  name: string;
  unit: string | null;
  cost: number;
  price: number;
  qty: number;
  archived: number;
};

export type ProductRecord = {
  id: string;
  bookId: string;
  sku: string | null;
  name: string;
  unit: string | null;
  cost: number;
  price: number;
  qty: number;
  archived: boolean;
};

export type UpsertProductInput = {
  id?: string;
  sku?: string;
  name: string;
  unit?: string;
  cost: number;
  price: number;
  openingQty?: number;
};

export type PurchaseProductLine = { productId: string; qty: number; unitCost: number };
export type SaleProductLine = { productId: string; qty: number };
export type AdjustQtyInput = { productId: string; date: string; qtyDelta: number; notes?: string };

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const acct = (bookId: string, code: string) => `${bookId}:account:${code}`;

function mapProduct(row: ProductRow): ProductRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    cost: Number(row.cost),
    price: Number(row.price),
    qty: Number(row.qty),
    archived: Boolean(row.archived),
  };
}

export class ProductDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    private readonly getActiveContext: (date?: string) => Promise<ActiveContext | null>,
  ) {}

  async listProducts(): Promise<ProductRecord[]> {
    const c = await this.requireContext();
    const rows = await this.db.all<ProductRow>(
      'SELECT id,book_id,sku,name,unit,cost,price,qty,archived FROM v2_products WHERE book_id=? AND archived=0 ORDER BY name,id',
      [c.bookId],
    );
    return rows.map(mapProduct);
  }

  async upsertProduct(input: UpsertProductInput): Promise<ProductRecord> {
    await this.requireModule();
    const c = await this.requireContext();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Product name is required');
    const cost = Number(input.cost);
    const price = Number(input.price);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Product cost must be a non-negative number');
    if (!Number.isFinite(price) || price < 0) throw new Error('Product price must be a non-negative number');
    const sku = input.sku != null && String(input.sku).trim() ? String(input.sku).trim() : null;
    const unit = input.unit != null && String(input.unit).trim() ? String(input.unit).trim() : null;
    const openingQty = input.openingQty == null ? undefined : Number(input.openingQty);
    if (openingQty != null && !Number.isFinite(openingQty)) throw new Error('Opening quantity must be a number');

    return this.repo.runInTransaction(async () => {
      const existing = input.id
        ? await this.db.first<ProductRow>('SELECT id,book_id,sku,name,unit,cost,price,qty,archived FROM v2_products WHERE id=? AND book_id=?', [input.id, c.bookId])
        : null;
      if (existing) {
        await this.db.run(
          'UPDATE v2_products SET sku=?,name=?,unit=?,cost=?,price=? WHERE id=? AND book_id=?',
          [sku, name, unit, cost, price, existing.id, c.bookId],
        );
        return this.getProduct(c.bookId, existing.id);
      }

      const id = input.id || uid('prod');
      const qty = openingQty ? openingQty : 0;
      await this.db.run(
        'INSERT INTO v2_products(id,book_id,sku,name,unit,cost,price,qty,archived) VALUES(?,?,?,?,?,?,?,?,0)',
        [id, c.bookId, sku, name, unit, cost, price, qty],
      );

      if (openingQty) {
        let sourceId: string | null = null;
        const openingValue = openingQty > 0 && cost > 0 ? mulMoney(cost, openingQty) : 0;
        if (openingValue > 0) {
          const period = await this.db.first<{ start_date: string }>('SELECT start_date FROM v2_periods WHERE id=? AND book_id=?', [c.periodId, c.bookId]);
          const date = period?.start_date || new Date().toISOString().slice(0, 10);
          const source = {
            id: uid('opening_stock'),
            bookId: c.bookId,
            type: 'opening_stock',
            date,
            metadata: { productId: id, qty: openingQty, unitCost: cost, total: openingValue },
          };
          await this.repo.ensureDefaultAccounts(c.bookId);
          await this.repo.postSourceJournal(source, {
            bookId: c.bookId,
            periodId: c.periodId,
            date,
            memo: 'Opening stock',
            lines: [
              { accountId: acct(c.bookId, V2_ACCOUNT_CODES.INVENTORY), debit: openingValue, credit: 0 },
              { accountId: acct(c.bookId, V2_ACCOUNT_CODES.OWNER_CONTRIBUTIONS), debit: 0, credit: openingValue },
            ],
          });
          sourceId = source.id;
        }
        await this.insertMove({
          bookId: c.bookId,
          productId: id,
          date: (await this.db.first<{ start_date: string }>('SELECT start_date FROM v2_periods WHERE id=? AND book_id=?', [c.periodId, c.bookId]))?.start_date || new Date().toISOString().slice(0, 10),
          qty: openingQty,
          unitCost: cost,
          kind: 'adjust',
          sourceId,
        });
      }

      return this.getProduct(c.bookId, id);
    });
  }

  async archiveProduct(id: string): Promise<ProductRecord> {
    await this.requireModule();
    const c = await this.requireContext();
    const product = await this.db.first<ProductRow>('SELECT id FROM v2_products WHERE id=? AND book_id=?', [id, c.bookId]);
    if (!product) throw new Error('Product not found');
    await this.db.run('UPDATE v2_products SET archived=1 WHERE id=? AND book_id=?', [id, c.bookId]);
    return this.getProduct(c.bookId, id);
  }

  async applyPurchaseLines(
    bookId: string,
    _periodId: string,
    date: string,
    sourceId: string,
    lines: PurchaseProductLine[],
  ): Promise<void> {
    if (!(await this.moduleEnabled())) return;
    if (!Array.isArray(lines) || !lines.length) return;
    await this.repo.runInTransaction(async () => {
      for (const line of lines) {
        const qty = Number(line.qty);
        const unitCost = Number(line.unitCost);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Purchase quantity must be positive');
        if (!Number.isFinite(unitCost) || unitCost < 0) throw new Error('Purchase unit cost must be a non-negative number');
        const product = await this.loadProduct(bookId, line.productId);
        await this.db.run('UPDATE v2_products SET qty=? WHERE id=? AND book_id=?', [Number(product.qty) + qty, product.id, bookId]);
        await this.insertMove({
          bookId,
          productId: product.id,
          date,
          qty,
          unitCost,
          kind: 'purchase',
          sourceId,
        });
      }
    });
  }

  async applySaleLines(
    bookId: string,
    periodId: string,
    date: string,
    sourceId: string,
    lines: SaleProductLine[],
  ): Promise<void> {
    if (!(await this.moduleEnabled())) return;
    if (!Array.isArray(lines) || !lines.length) return;
    await this.repo.runInTransaction(async () => {
      const demand = new Map<string, number>();
      for (const line of lines) {
        const qty = Number(line.qty);
        if (!Number.isFinite(qty) || qty <= 0) throw new Error('Sale quantity must be positive');
        demand.set(line.productId, (demand.get(line.productId) || 0) + qty);
      }
      for (const [productId, needed] of demand) {
        const product = await this.loadProduct(bookId, productId);
        if (needed > Number(product.qty)) throw new Error('Insufficient stock');
      }

      let totalCogs = 0;
      for (const line of lines) {
        const qty = Number(line.qty);
        const product = await this.loadProduct(bookId, line.productId);
        const cogs = mulMoney(Number(product.cost), qty);
        totalCogs = round2(totalCogs + cogs);
        await this.db.run('UPDATE v2_products SET qty=? WHERE id=? AND book_id=?', [Number(product.qty) - qty, product.id, bookId]);
        await this.insertMove({
          bookId,
          productId: product.id,
          date,
          qty,
          unitCost: Number(product.cost),
          kind: 'sale',
          sourceId,
        });
      }

      if (totalCogs > 0) {
        await this.postCogs(bookId, periodId, date, sourceId, totalCogs);
      }
    });
  }

  async adjustQty(input: AdjustQtyInput): Promise<ProductRecord> {
    await this.requireModule();
    const qtyDelta = Number(input.qtyDelta);
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) throw new Error('Quantity adjustment must be a non-zero number');
    const c = await this.requireContext(input.date);
    return this.repo.runInTransaction(async () => {
      const product = await this.loadProduct(c.bookId, input.productId);
      const nextQty = Number(product.qty) + qtyDelta;
      await this.db.run('UPDATE v2_products SET qty=? WHERE id=? AND book_id=?', [nextQty, product.id, c.bookId]);
      const value = mulMoney(Number(product.cost), Math.abs(qtyDelta));
      let sourceId: string | null = null;
      if (value !== 0) {
        const source = {
          id: uid('stock_adjust'),
          bookId: c.bookId,
          type: 'stock_adjust',
          date: input.date,
          metadata: { productId: product.id, qtyDelta, notes: input.notes || '', total: value },
        };
        const inventoryId = acct(c.bookId, V2_ACCOUNT_CODES.INVENTORY);
        const expenseId = acct(c.bookId, V2_ACCOUNT_CODES.EXPENSES);
        const lines = qtyDelta > 0
          ? [{ accountId: inventoryId, debit: value, credit: 0 }, { accountId: expenseId, debit: 0, credit: value }]
          : [{ accountId: expenseId, debit: value, credit: 0 }, { accountId: inventoryId, debit: 0, credit: value }];
        await this.repo.ensureDefaultAccounts(c.bookId);
        await this.repo.postSourceJournal(source, {
          bookId: c.bookId,
          periodId: c.periodId,
          date: input.date,
          memo: input.notes?.trim() || 'Stock adjustment',
          lines,
        });
        sourceId = source.id;
      }
      await this.insertMove({
        bookId: c.bookId,
        productId: product.id,
        date: input.date,
        qty: qtyDelta,
        unitCost: Number(product.cost),
        kind: 'adjust',
        sourceId,
      });
      return this.getProduct(c.bookId, product.id);
    });
  }

  private async postCogs(bookId: string, periodId: string, date: string, sourceId: string, totalCogs: number) {
    await this.repo.ensureDefaultAccounts(bookId);
    const lines = [
      { accountId: acct(bookId, V2_ACCOUNT_CODES.COGS), debit: totalCogs, credit: 0 },
      { accountId: acct(bookId, V2_ACCOUNT_CODES.INVENTORY), debit: 0, credit: totalCogs },
    ];
    const existing = sourceId
      ? await this.db.first('SELECT id FROM v2_sources WHERE id=? AND book_id=?', [sourceId, bookId])
      : null;
    if (existing) {
      await this.repo.postJournal({ bookId, periodId, sourceId, date, memo: 'Stock COGS', lines });
      return;
    }
    await this.repo.postSourceJournal({
      id: uid('stock_cogs'),
      bookId,
      type: 'stock_cogs',
      date,
      metadata: { saleSourceId: sourceId, sourceId, total: totalCogs },
    }, { bookId, periodId, date, memo: 'Stock COGS', lines });
  }

  private async insertMove(input: {
    bookId: string;
    productId: string;
    date: string;
    qty: number;
    unitCost: number;
    kind: 'purchase' | 'sale' | 'adjust';
    sourceId?: string | null;
  }) {
    await this.db.run(
      'INSERT INTO v2_stock_moves(id,book_id,product_id,date,qty,unit_cost,kind,source_id) VALUES(?,?,?,?,?,?,?,?)',
      [uid('move'), input.bookId, input.productId, input.date, input.qty, input.unitCost, input.kind, input.sourceId || null],
    );
  }

  private async loadProduct(bookId: string, productId: string): Promise<ProductRow> {
    const row = await this.db.first<ProductRow>(
      'SELECT id,book_id,sku,name,unit,cost,price,qty,archived FROM v2_products WHERE id=? AND book_id=?',
      [productId, bookId],
    );
    if (!row) throw new Error('Product not found');
    return row;
  }

  private async getProduct(bookId: string, id: string): Promise<ProductRecord> {
    return mapProduct(await this.loadProduct(bookId, id));
  }

  private async moduleEnabled() {
    return isOptionalModuleEnabled(this.db, 'perpetualInventory');
  }

  private async requireModule() {
    requireOptionalModule(await this.moduleEnabled(), 'perpetualInventory');
  }

  private async requireContext(date?: string): Promise<ActiveContext> {
    const c = await this.getActiveContext(date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return c;
  }
}
