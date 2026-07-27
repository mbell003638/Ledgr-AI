import type { SqlRunner } from '../db/schema';
import type { V2MemoryStore } from './schema';
import { buildV2Reports, type V2ReportOptions, type V2Reports } from './reports';

export type PersistentReportResult<TLegacy> =
  | { source: 'v2'; report: V2Reports }
  | { source: 'legacy'; report: TLegacy };

/**
 * Prefer authoritative journal-derived reports when the active book exists in
 * normalized SQLite. Any unavailable/incomplete V2 path delegates to the
 * caller's legacy report loader so report screens remain usable.
 */
export async function persistentV2ReportsOrFallback<TLegacy>(
  db: SqlRunner | null,
  options: V2ReportOptions,
  legacy: () => Promise<TLegacy>,
): Promise<PersistentReportResult<TLegacy>> {
  if (db) {
    try {
      const book = await db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [options.bookId]);
      if (book) return { source: 'v2', report: await buildPersistentV2Reports(db, options) };
    } catch {
      // SQLite reads must never prevent the legacy report path from rendering.
    }
  }
  return { source: 'legacy', report: await legacy() };
}

/** Load normalized SQLite postings into the report engine; journal rows are the sole authority. */
export async function buildPersistentV2Reports(db: SqlRunner, options: V2ReportOptions) {
  const books = await db.all<any>('SELECT id,name,style,basis,created_at FROM v2_books WHERE id=?', [options.bookId]);
  const accounts = await db.all<any>('SELECT id,book_id,code,name,type,payment_method,active FROM v2_accounts WHERE book_id=?', [options.bookId]);
  const entries = await db.all<any>('SELECT id,book_id,period_id,source_id,date,memo,reversal_of FROM v2_journal_entries WHERE book_id=? ORDER BY date,id', [options.bookId]);
  const journals = [] as any[];
  for (const entry of entries) {
    const lines = await db.all<any>('SELECT account_id,party_id,debit,credit,memo FROM v2_journal_lines WHERE journal_id=? ORDER BY id', [entry.id]);
    journals.push({ id:entry.id, bookId:entry.book_id, periodId:entry.period_id, sourceId:entry.source_id || undefined, date:entry.date, memo:entry.memo, reversalOf:entry.reversal_of || undefined, lines:lines.map(l=>({accountId:l.account_id,partyId:l.party_id||undefined,debit:Number(l.debit),credit:Number(l.credit),memo:l.memo||undefined})) });
  }
  const store: V2MemoryStore = {
    books: books.map(b=>({id:b.id,name:b.name,style:b.style,basis:b.basis,createdAt:b.created_at})),
    accounts: accounts.map(a=>({id:a.id,bookId:a.book_id,code:a.code,name:a.name,type:a.type,paymentMethod:a.payment_method||undefined,active:!!a.active})),
    journals, parties:[], sources:[], allocations:[],
  };
  return buildV2Reports(store, options);
}
