import type { SqlRunner } from '../../db/schema';
import { round2 } from '../../money';
import { V2SqlRepository } from '../repository';
import { V2_ACCOUNT_CODES } from '../types';
import type { V2ActiveContext } from '../appService';

type BomInput = { productId: string; name: string; version?: string; metadata?: Record<string, unknown> };
type BomLineInput = { bomId: string; componentProductId: string; quantity: number; unitCost?: number; metadata?: Record<string, unknown> };
type ProductionInput = { bomId: string; date: string; quantity: number; status?: 'completed' | 'draft'; notes?: string };

type ProductRow = { id: string; name: string; cost: number; qty: number };
type BomLineRow = { id: string; component_product_id: string; quantity: number; unit_cost: number; component_name: string; component_cost: number; component_qty: number };

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const money = (value: unknown) => round2(Number.isFinite(Number(value)) ? Number(value) : 0);
const positive = (value: unknown, label: string) => {
  const normalized = money(value);
  if (normalized <= 0) throw new Error(`${label} must be greater than zero`);
  return normalized;
};
const required = (value: unknown, label: string) => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
};

export class ManufacturingDomainService {
  constructor(
    private readonly db: SqlRunner,
    private readonly repo: V2SqlRepository,
    private readonly context: (date?: string) => Promise<V2ActiveContext | null>,
  ) {}

  private async product(bookId: string, productId: string, label = 'Product'): Promise<ProductRow> {
    const row = await this.db.first<ProductRow>('SELECT id,name,cost,qty FROM v2_products WHERE id=? AND book_id=? AND archived=0', [productId, bookId]);
    if (!row) throw new Error(`${label} was not found in this book`);
    return row;
  }

  private async account(bookId: string, code: string) {
    const row = await this.db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=? AND active=1', [bookId, code]);
    if (!row) throw new Error(`Required manufacturing account ${code} is missing from this book`);
    return row.id;
  }

  async createBom(input: BomInput) {
    const context = await this.context();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const product = await this.product(context.bookId, required(input.productId, 'Finished product ID'), 'Finished product');
    const name = required(input.name, 'BOM name');
    const id = uid('bom');
    await this.db.run('INSERT INTO v2_boms(id,book_id,product_id,name,version,status,metadata) VALUES(?,?,?,?,?,?,?)', [id, context.bookId, product.id, name, required(input.version || '1', 'BOM version'), 'active', JSON.stringify(input.metadata || {})]);
    return { id, bookId: context.bookId, productId: product.id, productName: product.name, name, version: input.version || '1', status: 'active' };
  }

  async addBomLine(input: BomLineInput) {
    const context = await this.context();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const bom = await this.db.first<{ id: string; product_id: string }>("SELECT id,product_id FROM v2_boms WHERE id=? AND book_id=? AND status='active'", [input.bomId, context.bookId]);
    if (!bom) throw new Error('Active BOM was not found');
    const component = await this.product(context.bookId, required(input.componentProductId, 'Component product ID'), 'Component product');
    if (component.id === bom.product_id) throw new Error('A finished product cannot be its own BOM component');
    const quantity = positive(input.quantity, 'BOM component quantity');
    const unitCost = money(input.unitCost ?? component.cost);
    if (unitCost < 0) throw new Error('BOM unit cost cannot be negative');
    const id = uid('bom_line');
    await this.db.run('INSERT INTO v2_bom_lines(id,bom_id,component_product_id,quantity,unit_cost,metadata) VALUES(?,?,?,?,?,?)', [id, bom.id, component.id, quantity, unitCost, JSON.stringify(input.metadata || {})]);
    return { id, bomId: bom.id, componentProductId: component.id, componentName: component.name, quantity, unitCost };
  }

  async createProductionOrder(input: ProductionInput) {
    const context = await this.context(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const quantity = positive(input.quantity, 'Production quantity');
    const bom = await this.db.first<{ id: string; product_id: string; name: string; version: string }>("SELECT id,product_id,name,version FROM v2_boms WHERE id=? AND book_id=? AND status='active'", [input.bomId, context.bookId]);
    if (!bom) throw new Error('Active BOM was not found');
    const finished = await this.product(context.bookId, bom.product_id, 'Finished product');
    const lines = await this.db.all<BomLineRow>(`SELECT l.id,l.component_product_id,l.quantity,l.unit_cost,p.name AS component_name,p.cost AS component_cost,p.qty AS component_qty
      FROM v2_bom_lines l JOIN v2_products p ON p.id=l.component_product_id
      WHERE l.bom_id=? AND p.book_id=? AND p.archived=0 ORDER BY l.id`, [bom.id, context.bookId]);
    if (!lines.length) throw new Error('Add at least one component to the BOM before producing');
    const requirements = lines.map((line: BomLineRow) => ({ ...line, requiredQty: money(Number(line.quantity) * quantity), unitCost: money(Number(line.unit_cost) || Number(line.component_cost)), value: money(Number(line.quantity) * quantity * (Number(line.unit_cost) || Number(line.component_cost))) }));
    for (const line of requirements) {
      if (Number(line.component_qty) < line.requiredQty) throw new Error(`Insufficient stock for component ${line.component_name}`);
    }
    const totalCost = money(requirements.reduce((sum: number, line: { value: number }) => sum + line.value, 0));
    const outputUnitCost = money(totalCost / quantity);
    const sourceId = uid('production');
    const metadata = { bomId: bom.id, bomName: bom.name, bomVersion: bom.version, finishedProductId: finished.id, finishedProductName: finished.name, quantity, totalCost, outputUnitCost, components: requirements.map((line: { component_product_id: string; component_name: string; requiredQty: number; unitCost: number; value: number }) => ({ productId: line.component_product_id, name: line.component_name, quantity: line.requiredQty, unitCost: line.unitCost, value: line.value })), notes: input.notes || null };
    await this.repo.ensureDefaultAccounts(context.bookId);
    const wip = await this.account(context.bookId, V2_ACCOUNT_CODES.WIP_INVENTORY);
    const inventory = await this.account(context.bookId, V2_ACCOUNT_CODES.INVENTORY);
    const finishedGoods = await this.account(context.bookId, V2_ACCOUNT_CODES.FINISHED_GOODS);
    return this.repo.runInTransaction(async () => {
      const journal = await this.repo.postSourceJournal({ id: sourceId, bookId: context.bookId, type: 'production_order', date: input.date, reference: bom.name, metadata }, {
        bookId: context.bookId,
        periodId: context.periodId,
        date: input.date,
        memo: `Production ${finished.name} x ${quantity}`,
        lines: [
          { accountId: wip, debit: totalCost, credit: 0, memo: 'Raw materials transferred to WIP' },
          { accountId: inventory, debit: 0, credit: totalCost, memo: 'Raw materials consumed' },
          { accountId: finishedGoods, debit: totalCost, credit: 0, memo: 'Finished goods received' },
          { accountId: wip, debit: 0, credit: totalCost, memo: 'WIP transferred to finished goods' },
        ],
      });
      for (const line of requirements) {
        await this.db.run('UPDATE v2_products SET qty=qty-? WHERE id=? AND book_id=?', [line.requiredQty, line.component_product_id, context.bookId]);
        await this.db.run('INSERT INTO v2_stock_moves(id,book_id,product_id,date,qty,unit_cost,kind,source_id,location_id) VALUES(?,?,?,?,?,?,?,?,?)', [uid('production_consume'), context.bookId, line.component_product_id, input.date, -line.requiredQty, line.unitCost, 'production_consume', sourceId, null]);
      }
      await this.db.run('UPDATE v2_products SET qty=qty+?,cost=? WHERE id=? AND book_id=?', [quantity, outputUnitCost, finished.id, context.bookId]);
      await this.db.run('INSERT INTO v2_stock_moves(id,book_id,product_id,date,qty,unit_cost,kind,source_id,location_id) VALUES(?,?,?,?,?,?,?,?,?)', [uid('production_output'), context.bookId, finished.id, input.date, quantity, outputUnitCost, 'production_output', sourceId, null]);
      const orderId = uid('production_order');
      await this.db.run('INSERT INTO v2_production_orders(id,book_id,bom_id,date,quantity,status,total_cost,source_id,metadata) VALUES(?,?,?,?,?,?,?,?,?)', [orderId, context.bookId, bom.id, input.date, quantity, input.status || 'completed', totalCost, sourceId, JSON.stringify(metadata)]);
      return { id: orderId, sourceId, journal, bomId: bom.id, finishedProductId: finished.id, quantity, totalCost, outputUnitCost, status: input.status || 'completed' };
    });
  }

  async listBoms() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) return [];
    return this.db.all(`SELECT b.*,p.name AS product_name,COALESCE((SELECT COUNT(*) FROM v2_bom_lines l WHERE l.bom_id=b.id),0) AS component_count FROM v2_boms b JOIN v2_products p ON p.id=b.product_id WHERE b.book_id=? ORDER BY b.name`, [active.value]);
  }

  async listProductionOrders() {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value) return [];
    return this.db.all(`SELECT o.*,b.name AS bom_name,p.name AS product_name FROM v2_production_orders o JOIN v2_boms b ON b.id=o.bom_id JOIN v2_products p ON p.id=b.product_id WHERE o.book_id=? ORDER BY o.date DESC`, [active.value]);
  }
}

export type { BomInput, BomLineInput, ProductionInput };
