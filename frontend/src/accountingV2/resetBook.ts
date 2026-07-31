import type { SqlRunner } from '../db/schema';

const yearEnd = (date: string) => `${date.slice(0, 4)}-12-31`;

/** Clear one V2 book's accounting activity while preserving its identity/configuration. */
export async function resetV2AccountingData(db: SqlRunner, bookId: string, periodStart: string) {
  const book = await db.first<{ id: string }>('SELECT id FROM v2_books WHERE id=?', [bookId]);
  if (!book) return { reset: false, periodId: null };

  const previous = await db.first<{ end_date: string }>(
    "SELECT end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1",
    [bookId],
  );
  const periodEnd = previous?.end_date && previous.end_date >= periodStart ? previous.end_date : yearEnd(periodStart);
  const periodId = `${bookId}:period:${periodStart}`;

  await db.exec('SAVEPOINT v2_reset_book');
  try {
    await db.run('DELETE FROM v2_invoice_allocations WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_close_books WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_inventory_counts WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_journal_lines WHERE journal_id IN (SELECT id FROM v2_journal_entries WHERE book_id=?)', [bookId]);
    await db.run('DELETE FROM v2_journal_entries WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_sources WHERE book_id=?', [bookId]);
    await db.run('UPDATE v2_members SET opening_contribution=0,current_capital=0 WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_parties WHERE book_id=?', [bookId]);
    await db.run('DELETE FROM v2_periods WHERE book_id=?', [bookId]);
    await db.run(
      'INSERT INTO v2_periods(id,book_id,start_date,end_date,status,close_snapshot) VALUES(?,?,?,?,?,?)',
      [periodId, bookId, periodStart, periodEnd, 'open', null],
    );
    await db.exec('RELEASE SAVEPOINT v2_reset_book');
    return { reset: true, periodId };
  } catch (error) {
    try {
      await db.exec('ROLLBACK TO SAVEPOINT v2_reset_book');
      await db.exec('RELEASE SAVEPOINT v2_reset_book');
    } catch { /* preserve the reset failure */ }
    throw error;
  }
}
/** Clear accounting activity for every V2 book without changing the active-book selection. */
export async function resetAllV2AccountingData(db: SqlRunner, periodStart: string) {
  const books = await db.all<{ id: string }>('SELECT id FROM v2_books ORDER BY id');
  const results = [];
  for (const book of books) results.push(await resetV2AccountingData(db, book.id, periodStart));
  return results;
}