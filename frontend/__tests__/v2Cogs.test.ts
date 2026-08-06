/**
 * Periodic COGS closing-count selection (audit FIX 2).
 *
 * computePeriodicCogs must never reuse the SAME inventory count as both the opening and the
 * closing count. Previously, when the only count was dated exactly on the period start, the
 * closing-count query (date >= start) picked that same row as "closing", returning
 * cogs = full purchases with hasClosingCount:true — a bogus estimate that then leaked into the
 * live P&L. The closing count must be a DISTINCT, strictly-later count; when none exists COGS is
 * unknown (0, hasClosingCount:false).
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { computePeriodicCogs } from '../src/accountingV2/cogs';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const base = new V2SqlRepository(node.runner);
  const book = defaultBook('cogs-book', 'COGS Shop', 'retail_partnership');
  await base.createBook(book, defaultAccounts(book.id));
  await base.createPeriod({ id: 'p1', bookId: book.id, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' });
  const closeRepo = new V2CloseBooksRepository(node.runner);
  const acct = (code: string) => `${book.id}:account:${code}`;
  // Purchase of 400 into Inventory (1200) inside the period.
  const purchase = (date: string, amount: number) => base.postJournal({
    id: `purchase-${date}`, bookId: book.id, periodId: 'p1', date, memo: 'purchase',
    lines: [{ accountId: acct('1200'), debit: amount, credit: 0 }, { accountId: acct('2000'), debit: 0, credit: amount }],
  });
  const bounds = { start: '2026-01-01', end: '2026-01-31' };
  return { ...node, base, closeRepo, book, purchase, bounds };
}

describe('computePeriodicCogs — closing count must differ from the opening count', () => {
  it('single count dated exactly on period start is NOT reused as closing (cogs 0)', async () => {
    const { runner, close, closeRepo, book, purchase, bounds } = await setup();
    try {
      await closeRepo.recordInventoryCount({ id: 'only', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      await purchase('2026-01-15', 400);
      const result = await computePeriodicCogs(runner, book.id, bounds);
      // Old bug returned { cogs: 400, hasClosingCount: true } by reusing the start count.
      expect(result.hasClosingCount).toBe(false);
      expect(result.cogs).toBe(0);
      expect(result.openingInventory).toBe(200);
      expect(result.purchases).toBe(400);
    } finally { close(); }
  });

  it('start-dated opening + a distinct later count yields periodic cogs', async () => {
    const { runner, close, closeRepo, book, purchase, bounds } = await setup();
    try {
      await closeRepo.recordInventoryCount({ id: 'open', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      await closeRepo.recordInventoryCount({ id: 'close', bookId: book.id, periodId: 'p1', date: '2026-01-20', value: 250 });
      await purchase('2026-01-15', 400);
      const result = await computePeriodicCogs(runner, book.id, bounds);
      expect(result.hasClosingCount).toBe(true);
      expect(result.openingInventory).toBe(200);
      expect(result.closingInventory).toBe(250);
      expect(result.cogs).toBe(350); // 200 + 400 − 250
    } finally { close(); }
  });

  it('a count dated before the period start is not usable as a closing count (cogs 0)', async () => {
    const { runner, close, closeRepo, book, purchase } = await setup();
    try {
      // Only physical count is on 2026-01-01, but the evaluated period starts 2026-01-02, so the
      // count is strictly before the period and cannot serve as the in-period closing count.
      await closeRepo.recordInventoryCount({ id: 'pre', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      await purchase('2026-01-15', 400);
      const result = await computePeriodicCogs(runner, book.id, { start: '2026-01-02', end: '2026-01-31' });
      // No count within [start, end] → closing inventory unknown → cogs 0.
      expect(result.hasClosingCount).toBe(false);
      expect(result.cogs).toBe(0);
    } finally { close(); }
  });

  it('no counts at all yields cogs 0 and hasClosingCount false', async () => {
    const { runner, close, book, purchase, bounds } = await setup();
    try {
      await purchase('2026-01-15', 400);
      const result = await computePeriodicCogs(runner, book.id, bounds);
      expect(result.hasClosingCount).toBe(false);
      expect(result.cogs).toBe(0);
    } finally { close(); }
  });

  it('does not count an opening-balance Inventory debit as a purchase', async () => {
    const { runner, close, base, closeRepo, book, purchase, bounds } = await setup();
    try {
      await base.postSourceJournal({ id: 'opening-source', bookId: book.id, type: 'opening_balance', date: '2026-01-01', metadata: { inventory: 200 } }, {
        bookId: book.id, periodId: 'p1', date: '2026-01-01', memo: 'Opening balances',
        lines: [
          { accountId: book.id + ':account:1200', debit: 200, credit: 0 },
          { accountId: book.id + ':account:3000', debit: 0, credit: 200 },
        ],
      });
      await closeRepo.recordInventoryCount({ id: 'open-with-journal', bookId: book.id, periodId: 'p1', date: '2026-01-01', value: 200 });
      await closeRepo.recordInventoryCount({ id: 'close-with-journal', bookId: book.id, periodId: 'p1', date: '2026-01-31', value: 250 });
      await purchase('2026-01-15', 400);

      const result = await computePeriodicCogs(runner, book.id, bounds);
      expect(result.openingInventory).toBe(200);
      expect(result.purchases).toBe(400);
      expect(result.closingInventory).toBe(250);
      expect(result.cogs).toBe(350);
    } finally { close(); }
  });
});
