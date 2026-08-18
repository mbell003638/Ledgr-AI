import type { SqlRunner } from '../db/schema';
import type { V2MemoryStore } from './schema';
import { buildV2Reports, type V2ReportOptions, type V2Reports } from './reports';
import { computePeriodicCogs } from './cogs';
import { isOptionalModuleEnabled } from './optionalModules';
import { V2_ACCOUNT_CODES } from './types';

export type PersistentReportResult = { source: 'v2'; report: V2Reports };

/** Load reports from the sole authoritative V2 journal. */
export async function persistentV2Reports(
  db: SqlRunner,
  options: V2ReportOptions,
): Promise<PersistentReportResult> {
  const book = await db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [options.bookId]);
  if (!book) throw new Error(`V2 book ${options.bookId} was not found`);
  return { source: 'v2', report: await buildPersistentV2Reports(db, options) };
}

/** Load normalized SQLite postings into the report engine; journal rows are the sole authority. */
export async function buildPersistentV2Reports(db: SqlRunner, options: V2ReportOptions) {
  const books = await db.all<any>('SELECT id,name,style,basis,created_at FROM v2_books WHERE id=?', [options.bookId]);
  const accounts = await db.all<any>('SELECT id,book_id,code,name,type,payment_method,active FROM v2_accounts WHERE book_id=?', [options.bookId]);
  const parties = await db.all<any>('SELECT id,book_id,name,phone,email,roles,archived FROM v2_parties WHERE book_id=?', [options.bookId]);
  const entries = await db.all<any>('SELECT id,book_id,period_id,source_id,date,memo,reversal_of FROM v2_journal_entries WHERE book_id=? ORDER BY date,id', [options.bookId]);
  const lineRows = await db.all<any>(
    'SELECT l.journal_id,l.account_id,l.party_id,l.debit,l.credit,l.memo,l.location_id FROM v2_journal_lines l ' +
    'JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.book_id=? ORDER BY j.date,j.id,l.id',
    [options.bookId],
  );
  const linesByJournal = new Map<string, any[]>();
  for (const line of lineRows) {
    const lines = linesByJournal.get(line.journal_id) || [];
    lines.push({ accountId:line.account_id, partyId:line.party_id||undefined, debit:Number(line.debit), credit:Number(line.credit), memo:line.memo||undefined, locationId:line.location_id||undefined });
    linesByJournal.set(line.journal_id, lines);
  }
  const journals = entries.map((entry) => ({ id:entry.id, bookId:entry.book_id, periodId:entry.period_id, sourceId:entry.source_id || undefined, date:entry.date, memo:entry.memo, reversalOf:entry.reversal_of || undefined, lines:linesByJournal.get(entry.id) || [] }));
  // Sources and allocations are needed for cash-basis P&L (money actually received/paid).
  const sourceRows = await db.all<any>('SELECT id,book_id,type,date,reference,metadata,location_id FROM v2_sources WHERE book_id=?', [options.bookId]);
  const allocationRows = await db.all<any>('SELECT id,book_id,invoice_source_id,receipt_source_id,amount,allocated_at FROM v2_invoice_allocations WHERE book_id=?', [options.bookId]);
  const store: V2MemoryStore = {
    books: books.map(b=>({id:b.id,name:b.name,style:b.style,basis:b.basis,createdAt:b.created_at})),
    accounts: accounts.map(a=>({id:a.id,bookId:a.book_id,code:a.code,name:a.name,type:a.type,paymentMethod:a.payment_method||undefined,active:!!a.active})),
    journals, parties: parties.map((party) => {
      let roles: any[] = []; try { roles = JSON.parse(party.roles || '[]'); } catch { roles = []; }
      return { id: party.id, bookId: party.book_id, name: party.name, phone: party.phone || undefined, email: party.email || undefined, roles, archived: Boolean(party.archived) };
    }),
    sources: sourceRows.map((s) => { let metadata: any = {}; try { metadata = JSON.parse(s.metadata || '{}'); } catch { metadata = {}; } return { id: s.id, bookId: s.book_id, type: s.type, date: s.date, reference: s.reference || undefined, metadata, locationId: s.location_id || metadata.locationId || undefined }; }),
    allocations: allocationRows.map((a) => ({ id: a.id, bookId: a.book_id, invoiceSourceId: a.invoice_source_id, receiptSourceId: a.receipt_source_id, amount: Number(a.amount), allocatedAt: a.allocated_at })),
  };
  const skippedShopCogs = Boolean(options.locationId) && !(await isOptionalModuleEnabled(db, 'perpetualInventory', options.bookId));
  const cogsAdjustment = await openPeriodCogsAdjustment(db, options);
  const report = buildV2Reports(store, { ...options, cogsAdjustment });
  return { ...report, provisionalShopCogs: skippedShopCogs && !cogsAdjustment };
}

/**
 * Compute the still-open period's periodic COGS as a synthetic report adjustment so
 * live P&L includes cost of sales before the close posts it. Returns undefined when
 * perpetualInventory is on (sale-time 5000 is already posted), there is no open
 * period, no closing count yet, or the report range excludes the open period.
 */
async function openPeriodCogsAdjustment(db: SqlRunner, options: V2ReportOptions) {
  try {
    if (options.locationId) return undefined;
    if (await isOptionalModuleEnabled(db, 'perpetualInventory', options.bookId)) return undefined;
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
    if (!hasClosingCount || Math.abs(cogs) <= 0.005) return undefined;
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
