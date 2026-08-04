import type { SqlRunner } from '../db/schema';
import type { V2MemoryStore } from './schema';
import { buildV2Reports, type V2ReportOptions, type V2Reports } from './reports';
import { computePeriodicCogs } from './cogs';
import { V2_ACCOUNT_CODES } from './types';

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
  // Sources and allocations are needed for cash-basis P&L (money actually received/paid).
  const sourceRows = await db.all<any>('SELECT id,book_id,type,date,reference,metadata FROM v2_sources WHERE book_id=?', [options.bookId]);
  const allocationRows = await db.all<any>('SELECT id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at FROM v2_invoice_allocations WHERE book_id=?', [options.bookId]);
  const store: V2MemoryStore = {
    books: books.map(b=>({id:b.id,name:b.name,style:b.style,basis:b.basis,createdAt:b.created_at})),
    accounts: accounts.map(a=>({id:a.id,bookId:a.book_id,code:a.code,name:a.name,type:a.type,paymentMethod:a.payment_method||undefined,active:!!a.active})),
    journals, parties:[],
    sources: sourceRows.map((s) => { let metadata: any = {}; try { metadata = JSON.parse(s.metadata || '{}'); } catch { metadata = {}; } return { id: s.id, bookId: s.book_id, type: s.type, date: s.date, reference: s.reference || undefined, metadata }; }),
    allocations: allocationRows.map((a) => ({ id: a.id, bookId: a.book_id, invoiceSourceId: a.invoice_source_id, receiptSourceId: a.receipt_source_id, amount: Number(a.amount), allocatedAt: a.allocated_at })),
  };
  const cogsAdjustment = await openPeriodCogsAdjustment(db, options);
  return buildV2Reports(store, { ...options, cogsAdjustment });
}

/**
 * Compute the still-open period's periodic COGS as a synthetic report adjustment so
 * live P&L includes cost of sales before the close posts it. Returns undefined when
 * there is no open period, no closing count yet, or the report range excludes the
 * open period (so we never double-count a closed period's already-posted COGS).
 */
async function openPeriodCogsAdjustment(db: SqlRunner, options: V2ReportOptions) {
  try {
    const period = await db.first<{ start_date: string; end_date: string }>(
      "SELECT start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1",
      [options.bookId],
    );
    if (!period) return undefined;
    // Only inject when the requested range actually overlaps the open period.
    if (options.to && options.to < period.start_date) return undefined;
    if (options.from && options.from > period.end_date) return undefined;
    const end = options.to && options.to < period.end_date ? options.to : period.end_date;
    const { cogs, hasClosingCount } = await computePeriodicCogs(db, options.bookId, { start: period.start_date, end });
    if (!hasClosingCount || cogs <= 0) return undefined;
    // Resolve account ids by (book_id, code) rather than templating `${bookId}:account:${code}`.
    // If a book's ids ever diverge from that convention, a templated id would miss the report's
    // accountsById lookup and the COGS estimate would silently vanish from the P&L.
    const cogsAccountId = await accountIdByCode(db, options.bookId, V2_ACCOUNT_CODES.COGS);
    const inventoryAccountId = await accountIdByCode(db, options.bookId, V2_ACCOUNT_CODES.INVENTORY);
    if (!cogsAccountId || !inventoryAccountId) return undefined;
    return { cogsAccountId, inventoryAccountId, amount: cogs };
  } catch {
    return undefined; // never let the COGS estimate break report rendering
  }
}

/** Resolve an account id from the authoritative accounts table by (book_id, code). */
async function accountIdByCode(db: SqlRunner, bookId: string, code: string): Promise<string | undefined> {
  const row = await db.first<{ id: string }>('SELECT id FROM v2_accounts WHERE book_id=? AND code=?', [bookId, code]);
  return row?.id;
}
