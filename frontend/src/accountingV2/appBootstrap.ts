import type { SqlRunner } from '../db/schema';
import { initSchema } from '../db/schema';
import type { PersonaId } from './config';
import { defaultAccounts, defaultBook } from './schema';
import type { V2Basis, V2Book, V2BookStyle, V2Member } from './types';

/** Build-time feature switch for the clean, authoritative accounting path. */
export const ACCOUNTING_V2_ENABLED = true as const;
/** Version written per book, independently of the physical SQLite schema version. */
export const V2_BOOK_VERSION = 2 as const;

const versionKey = (bookId: string) => `v2_book_version:${bookId}`;

export type V2BootstrapOptions = {
  book: {
    id: string;
    name: string;
    style?: V2BookStyle;
    basis?: V2Basis;
    createdAt?: string;
  };
  period: { startDate: string; endDate: string; id?: string };
  personas?: PersonaId[];
  members?: Omit<V2Member, 'id' | 'bookId'>[];
};

export type V2BootstrapResult = {
  bookId: string;
  periodId: string;
  version: typeof V2_BOOK_VERSION;
};

/** Read the accounting model version for one authoritative SQLite book. */
export async function accountingBookVersion(db: SqlRunner, bookId: string): Promise<number | null> {
  const row = await db.first<{ value: string }>('SELECT value FROM meta WHERE key = ?', [versionKey(bookId)]);
  if (!row) return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : null;
}

/**
 * Create a complete V2 book in SQLite. This deliberately accepts a SqlRunner
 * directly and never imports the legacy backend/AsyncStorage book router.
 */
export async function initializeV2Book(db: SqlRunner, options: V2BootstrapOptions): Promise<V2BootstrapResult> {
  await initSchema(db);
  const id = options.book.id.trim();
  const name = options.book.name.trim();
  if (!id || !name) throw new Error('Book id and name are required');
  if (!options.period.startDate || !options.period.endDate || options.period.startDate > options.period.endDate) {
    throw new Error('A valid initial period date range is required');
  }

  const personas = [...new Set(options.personas || ['custom'])];
  if (!personas.length) personas.push('custom');
  const members = options.members || [];
  for (const member of members) {
    if (!member.name.trim() || !Number.isFinite(member.openingContribution) || member.openingContribution < 0
      || !Number.isFinite(member.profitSharePct) || member.profitSharePct < 0 || member.profitSharePct > 100) {
      throw new Error('Members require a name, non-negative contribution, and profit share from 0 to 100');
    }
  }

  const base = defaultBook(id, name, options.book.style || 'standard');
  const book: V2Book = {
    ...base,
    basis: options.book.basis || base.basis,
    createdAt: options.book.createdAt || base.createdAt,
  };
  const periodId = options.period.id || `${id}:period:${options.period.startDate}`;

  await db.exec('BEGIN');
  try {
    // Idempotency / self-healing (defense in depth): a v2_books row with this id
    // can already exist as an ORPHAN — e.g. an old build's factory reset wiped
    // the `v2_book_version:*` meta keys but left the book skeleton rows behind,
    // so onboarding re-runs this bootstrap with the same deterministic id and
    // the plain INSERT crashed with "UNIQUE constraint failed: v2_books.id".
    // Bootstrap is only invoked when the book has no version meta (all callers
    // gate on accountingBookVersion == null), so such a row is stale by
    // definition: purge it children-first inside this transaction and recreate
    // the book from scratch. Fresh ids make these deletes no-ops.
    const existing = await db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [id]);
    if (existing) {
      await db.run('DELETE FROM v2_journal_lines WHERE journal_id IN (SELECT id FROM v2_journal_entries WHERE book_id=?)', [id]);
      await db.run('DELETE FROM v2_invoice_allocations WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_close_books WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_inventory_counts WHERE book_id=?', [id]);
      await db.run('UPDATE v2_journal_entries SET reversal_of=NULL WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_journal_entries WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_sources WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_members WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_personas WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_parties WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_accounts WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_periods WHERE book_id=?', [id]);
      await db.run('DELETE FROM v2_books WHERE id=?', [id]);
    }
    await db.run('INSERT INTO v2_books(id,name,style,basis,created_at) VALUES(?,?,?,?,?)',
      [book.id, book.name, book.style, book.basis, book.createdAt]);
    for (const account of defaultAccounts(id)) {
      await db.run('INSERT INTO v2_accounts(id,book_id,code,name,type,payment_method,active) VALUES(?,?,?,?,?,?,?)',
        [account.id, id, account.code, account.name, account.type, account.paymentMethod || null, 1]);
    }
    await db.run('INSERT INTO v2_periods(id,book_id,start_date,end_date,status,close_snapshot) VALUES(?,?,?,?,?,?)',
      [periodId, id, options.period.startDate, options.period.endDate, 'open', null]);
    for (let index = 0; index < personas.length; index += 1) {
      const type = personas[index];
      await db.run('INSERT INTO v2_personas(id,book_id,type,enabled,active,config) VALUES(?,?,?,?,?,?)',
        [`${id}:persona:${type}`, id, type, 1, index === 0 ? 1 : 0, '{}']);
    }
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      await db.run('INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES(?,?,?,?,?,?)',
        [`${id}:member:${index + 1}`, id, member.name.trim(), member.openingContribution, member.openingContribution, member.profitSharePct]);
    }
    // Upsert: tolerate a leftover version key (same orphan scenario as above).
    await db.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [versionKey(id), String(V2_BOOK_VERSION)]);
    const active = await db.first('SELECT value FROM meta WHERE key = ?', ['v2_active_book_id']);
    if (!active) await db.run('INSERT INTO meta(key,value) VALUES(?,?)', ['v2_active_book_id', id]);
    await db.exec('COMMIT');
  } catch (error) {
    try { await db.exec('ROLLBACK'); } catch { /* preserve the initialization failure */ }
    throw error;
  }

  return { bookId: id, periodId, version: V2_BOOK_VERSION };
}
