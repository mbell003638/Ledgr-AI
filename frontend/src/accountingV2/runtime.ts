import { activeBookId, activeSqlRunner } from '../db/backend';
import { V2SqlRepository } from './repository';
import { V2CloseBooksRepository } from './closeBooksRepository';
import { persistentV2ReportsOrFallback } from './persistentReports';
import type { V2ReportOptions } from './reports';
import * as postings from './postings';

/** Report bridge for screens: use the active normalized V2 book when present, otherwise load legacy reports. */
export function v2ReportsOrFallback<TLegacy>(
  options: Omit<V2ReportOptions, 'bookId'> & { bookId?: string },
  legacy: () => Promise<TLegacy>,
) {
  return persistentV2ReportsOrFallback(
    activeSqlRunner(),
    { ...options, bookId: options.bookId || activeBookId() },
    legacy,
  );
}

/** Runtime bridge used by app screens. V2 requires SQLite so authoritative writes cannot fall back to duplicate JSON collections. */
export function v2Services() {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  return {
    repo: new V2SqlRepository(runner),
    closeBooks: new V2CloseBooksRepository(runner),
    postCashSale: (input: Parameters<typeof postings.postCashSale>[1]) => postings.postCashSale(new V2SqlRepository(runner), input),
    postInvoice: (input: Parameters<typeof postings.postInvoice>[1]) => postings.postInvoice(new V2SqlRepository(runner), input),
    postReceipt: (input: Parameters<typeof postings.postReceipt>[1]) => postings.postReceipt(new V2SqlRepository(runner), input),
    postPurchase: (input: Parameters<typeof postings.postPurchase>[1]) => postings.postPurchase(new V2SqlRepository(runner), input),
    postSupplierPayment: (input: Parameters<typeof postings.postSupplierPayment>[1]) => postings.postSupplierPayment(new V2SqlRepository(runner), input),
    postExpense: (input: Parameters<typeof postings.postExpense>[1]) => postings.postExpense(new V2SqlRepository(runner), input),
  };
}
