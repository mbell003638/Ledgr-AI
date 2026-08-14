import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { bookOptionalSettings, isOptionalModuleEnabledForBook, requireOptionalModule } from '../optionalModules';
import { V2_ACCOUNT_CODES, type V2PaymentMethod } from '../types';
import { mulMoney, round2 } from '../../money';

type ActiveContext = { bookId: string; periodId: string };

export type LocationRecord = {
  id: string;
  bookId: string;
  name: string;
  archived: boolean;
};

export type CashTransferInput = {
  date: string;
  fromLocationId: string;
  toLocationId: string;
  amount: number;
  method?: V2PaymentMethod;
  notes?: string;
};

export type StockTransferInput = {
  date: string;
  fromLocationId: string;
  toLocationId: string;
  productId: string;
  qty: number;
  notes?: string;
};

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const acct = (bookId: string, code: string) => `${bookId}:account:${code}`;
const methods = new Set<V2PaymentMethod>(['cash', 'bank', 'card', 'mobile']);
const method = (value: any): V2PaymentMethod => (methods.has(value) ? value : 'cash');
const paymentCode = (value: V2PaymentMethod) => {
  if (value === 'bank') return V2_ACCOUNT_CODES.BANK;
  if (value === 'card') return V2_ACCOUNT_CODES.CARD;
  if (value === 'mobile') return V2_ACCOUNT_CODES.MOBILE;
  return V2_ACCOUNT_CODES.CASH;
};

export const LOCATION_QTY_SQL = `COALESCE(SUM(CASE
  WHEN m.kind IN ('sale','transfer_out') THEN -m.qty
  ELSE m.qty
END), 0)`;

export async function resolveWriteLocationId(
  db: SqlRunner,
  bookId: string,
  requested?: unknown,
): Promise<string | null> {
  if (!(await isOptionalModuleEnabledForBook(db, bookId, 'locations'))) return null;
  const explicit = String(requested || '').trim();
  if (explicit) return requireLocation(db, bookId, explicit);
  const scoped = await bookOptionalSettings(db, bookId);
  let fallback = String(scoped.activeLocationId || '').trim();
  if (!fallback && bookId === 'default') {
    const row = await db.first<{ value: string }>("SELECT value FROM settings WHERE key='main'");
    let parsed: { activeLocationId?: unknown } = {};
    try { parsed = JSON.parse(row?.value || '{}'); } catch { parsed = {}; }
    fallback = String(parsed.activeLocationId || '').trim();
  }
  if (!fallback) throw new Error('Choose a location before recording this.');
  return requireLocation(db, bookId, fallback);
}

export async function requireLocation(db: SqlRunner, bookId: string, locationId: string): Promise<string> {
  const row = await db.first<{ id: string; archived: number }>(
    'SELECT id,archived FROM v2_locations WHERE id=? AND book_id=?',
    [locationId, bookId],
  );
  if (!row) throw new Error('Location not found');
  if (row.archived) throw new Error('That location is archived');
  return row.id;
}

export async function qtyAtLocation(
  db: SqlRunner,
  bookId: string,
  productId: string,
  locationId: string,
): Promise<number> {
  const row = await db.first<{ qty: number }>(
    `SELECT ${LOCATION_QTY_SQL} AS qty FROM v2_stock_moves m WHERE m.book_id=? AND m.product_id=? AND m.location_id=?`,
    [bookId, productId, locationId],
  );
  return Number(row?.qty || 0);
}

export class LocationDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    private readonly getActiveContext: (date?: string) => Promise<ActiveContext | null>,
  ) {}

  async listLocations(): Promise<LocationRecord[]> {
    const c = await this.requireContext();
    const rows = await this.db.all<{ id: string; book_id: string; name: string; archived: number }>(
      'SELECT id,book_id,name,archived FROM v2_locations WHERE book_id=? AND archived=0 ORDER BY name,id',
      [c.bookId],
    );
    return rows.map((row) => ({ id: row.id, bookId: row.book_id, name: row.name, archived: Boolean(row.archived) }));
  }

  async createLocation(input: { name: string }): Promise<LocationRecord> {
    await this.requireModule();
    const c = await this.requireContext();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('Location name is required');
    const dup = await this.db.first<{ id: string }>(
      'SELECT id FROM v2_locations WHERE book_id=? AND archived=0 AND lower(name)=lower(?)',
      [c.bookId, name],
    );
    if (dup) throw new Error('A location with that name already exists');
    const id = uid('loc');
    await this.db.run('INSERT INTO v2_locations(id,book_id,name,archived) VALUES(?,?,?,0)', [id, c.bookId, name]);
    return { id, bookId: c.bookId, name, archived: false };
  }

  async archiveLocation(id: string): Promise<LocationRecord> {
    await this.requireModule();
    const c = await this.requireContext();
    const row = await this.db.first<{ id: string; name: string }>('SELECT id,name FROM v2_locations WHERE id=? AND book_id=?', [id, c.bookId]);
    if (!row) throw new Error('Location not found');
    await this.db.run('UPDATE v2_locations SET archived=1 WHERE id=? AND book_id=?', [id, c.bookId]);
    return { id: row.id, bookId: c.bookId, name: row.name, archived: true };
  }

  async listStockTransfers() {
    const c = await this.requireContext();
    const rows = await this.db.all<{ id: string; date: string; metadata: string | null }>(
      "SELECT id,date,metadata FROM v2_sources WHERE book_id=? AND type='location_stock_transfer' ORDER BY date DESC,id DESC",
      [c.bookId],
    );
    return rows.map((row) => {
      let metadata: Record<string, any> = {};
      try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
      return {
        id: row.id,
        date: row.date,
        fromLocationId: String(metadata.fromLocationId || ''),
        toLocationId: String(metadata.toLocationId || ''),
        productId: String(metadata.productId || ''),
        qty: Number(metadata.qty || 0),
        quantity: Number(metadata.qty || 0),
        status: 'posted',
        notes: String(metadata.notes || ''),
      };
    });
  }

  async transferCash(input: CashTransferInput) {
    await this.requireModule();
    const c = await this.requireContext(input.date);
    const fromId = await requireLocation(this.db, c.bookId, input.fromLocationId);
    const toId = await requireLocation(this.db, c.bookId, input.toLocationId);
    if (fromId === toId) throw new Error('Choose two different locations');
    const amount = round2(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Transfer amount must be positive');
    const pay = method(input.method);
    const code = paymentCode(pay);
    const available = await this.cashAt(c.bookId, fromId, code);
    if (amount > available + 0.005) throw new Error('Not enough cash at the sending location');
    await this.repo.ensureDefaultAccounts(c.bookId);
    const source = {
      id: uid('loc_cash'),
      bookId: c.bookId,
      type: 'location_cash_transfer',
      date: input.date,
      metadata: {
        fromLocationId: fromId,
        toLocationId: toId,
        total: amount,
        method: pay,
        notes: input.notes || '',
      },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: c.bookId,
      periodId: c.periodId,
      date: input.date,
      memo: input.notes?.trim() || 'Location cash transfer',
      lines: [
        { accountId: acct(c.bookId, code), debit: amount, credit: 0, locationId: toId },
        { accountId: acct(c.bookId, code), debit: 0, credit: amount, locationId: fromId },
      ],
    });
    return { source, journal };
  }

  async transferStock(input: StockTransferInput) {
    const c = await this.requireContext(input.date);
    await this.requireModule();
    if (!(await isOptionalModuleEnabledForBook(this.db, c.bookId, 'perpetualInventory'))) {
      throw new Error('Turn on Live Product Stock in Customize Features before transferring stock.');
    }
    const fromId = await requireLocation(this.db, c.bookId, input.fromLocationId);
    const toId = await requireLocation(this.db, c.bookId, input.toLocationId);
    if (fromId === toId) throw new Error('Choose two different locations');
    const qty = Number(input.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Transfer quantity must be positive');
    const product = await this.db.first<{ id: string; cost: number }>(
      'SELECT id,cost FROM v2_products WHERE id=? AND book_id=? AND archived=0',
      [input.productId, c.bookId],
    );
    if (!product) throw new Error('Product not found');
    const available = await qtyAtLocation(this.db, c.bookId, product.id, fromId);
    if (qty > available + 0.0005) throw new Error('Not enough stock at the sending location');
    const sourceId = uid('loc_stock');
    return this.repo.runInTransaction(async () => {
      await this.db.run(
        'INSERT INTO v2_sources(id,book_id,type,date,reference,metadata,location_id) VALUES(?,?,?,?,?,?,?)',
        [sourceId, c.bookId, 'location_stock_transfer', input.date, null, JSON.stringify({
          fromLocationId: fromId,
          toLocationId: toId,
          productId: product.id,
          qty,
          notes: input.notes || '',
        }), null],
      );
      await this.db.run(
        'INSERT INTO v2_stock_moves(id,book_id,product_id,date,qty,unit_cost,kind,source_id,location_id) VALUES(?,?,?,?,?,?,?,?,?)',
        [uid('move'), c.bookId, product.id, input.date, qty, Number(product.cost), 'transfer_out', sourceId, fromId],
      );
      await this.db.run(
        'INSERT INTO v2_stock_moves(id,book_id,product_id,date,qty,unit_cost,kind,source_id,location_id) VALUES(?,?,?,?,?,?,?,?,?)',
        [uid('move'), c.bookId, product.id, input.date, qty, Number(product.cost), 'transfer_in', sourceId, toId],
      );
      return { sourceId, qty, unitCost: Number(product.cost), value: mulMoney(Number(product.cost), qty) };
    });
  }

  async posSettlementPreview(input: { locationId: string; openingCash: number; openedAt?: string; date: string }) {
    const c = await this.requireContext(input.date);
    const locationId = await requireLocation(this.db, c.bookId, input.locationId);
    const openingCash = round2(Number(input.openingCash || 0));
    if (!Number.isFinite(openingCash) || openingCash < 0) throw new Error('Opening cash must be zero or a valid amount');
    const fromDate = String(input.openedAt || input.date).slice(0, 10);
    const row = await this.db.first<{ movement: number }>(
      `SELECT COALESCE(SUM(l.debit-l.credit),0) AS movement
       FROM v2_journal_entries j
       JOIN v2_journal_lines l ON l.journal_id=j.id
       JOIN v2_accounts a ON a.id=l.account_id
       WHERE j.book_id=? AND j.date>=? AND j.date<=? AND l.location_id=? AND a.code=?`,
      [c.bookId, fromDate, input.date, locationId, V2_ACCOUNT_CODES.CASH],
    );
    const movement = round2(Number(row?.movement || 0));
    return { locationId, date: input.date, openingCash, ledgerMovement: movement, expectedCash: round2(openingCash + movement) };
  }

  async settlePosSession(input: { sessionId: string; locationId: string; openingCash: number; openedAt?: string; date: string; countedCash: number; notes?: string }) {
    await this.requireModule();
    const c = await this.requireContext(input.date);
    const countedCash = round2(Number(input.countedCash));
    if (!Number.isFinite(countedCash) || countedCash < 0) throw new Error('Counted cash must be zero or a valid amount');
    const preview = await this.posSettlementPreview(input);
    const variance = round2(countedCash - preview.expectedCash);
    const sourceId = `pos_settlement:${String(input.sessionId || '').trim()}`;
    if (sourceId.length <= 'pos_settlement:'.length) throw new Error('POS session id is required');
    const existing = await this.db.first<{ id: string; metadata: string }>("SELECT id,metadata FROM v2_sources WHERE id=? AND book_id=? AND type='pos_settlement'", [sourceId, c.bookId]);
    if (existing) {
      let metadata: Record<string, any> = {};
      try { metadata = JSON.parse(existing.metadata || '{}'); } catch { metadata = {}; }
      return { ...preview, countedCash: Number(metadata.countedCash ?? countedCash), variance: Number(metadata.variance ?? variance), sourceId, journalId: null, alreadySettled: true };
    }
    if (variance === 0) return { ...preview, countedCash, variance, sourceId, journalId: null, alreadySettled: false };
    const amount = Math.abs(variance);
    const source = {
      id: sourceId,
      bookId: c.bookId,
      type: 'pos_settlement',
      date: input.date,
      locationId: preview.locationId,
      metadata: { sessionId: input.sessionId, locationId: preview.locationId, openingCash: preview.openingCash, ledgerMovement: preview.ledgerMovement, expectedCash: preview.expectedCash, countedCash, variance, notes: String(input.notes || '').trim() },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: c.bookId,
      periodId: c.periodId,
      date: input.date,
      memo: variance > 0 ? 'POS cash overage settlement' : 'POS cash shortage settlement',
      lines: variance > 0
        ? [
            { accountId: acct(c.bookId, V2_ACCOUNT_CODES.CASH), debit: amount, credit: 0, locationId: preview.locationId },
            { accountId: acct(c.bookId, V2_ACCOUNT_CODES.POS_VARIANCE), debit: 0, credit: amount, locationId: preview.locationId },
          ]
        : [
            { accountId: acct(c.bookId, V2_ACCOUNT_CODES.POS_VARIANCE), debit: amount, credit: 0, locationId: preview.locationId },
            { accountId: acct(c.bookId, V2_ACCOUNT_CODES.CASH), debit: 0, credit: amount, locationId: preview.locationId },
          ],
    });
    return { ...preview, countedCash, variance, sourceId: source.id, journalId: journal.id, alreadySettled: false };
  }

  private async cashAt(bookId: string, locationId: string, code: string): Promise<number> {
    const row = await this.db.first<{ bal: number }>(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS bal
       FROM v2_journal_lines l
       JOIN v2_journal_entries j ON j.id = l.journal_id
       JOIN v2_accounts a ON a.id = l.account_id
       WHERE j.book_id=? AND l.location_id=? AND a.code=?`,
      [bookId, locationId, code],
    );
    return round2(Number(row?.bal || 0));
  }

  private async requireModule() {
    requireOptionalModule(await isOptionalModuleEnabledForBook(this.db, (await this.getActiveContext())?.bookId || '', 'locations'), 'locations');
  }

  private async requireContext(date?: string): Promise<ActiveContext> {
    const c = await this.getActiveContext(date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return c;
  }
}
