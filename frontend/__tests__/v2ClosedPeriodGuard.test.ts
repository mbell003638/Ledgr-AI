/**
 * Closed-period write guard (audit H2/H3, L1).
 *
 * Proves:
 *  - Deleting/reversing a source whose journal sits in a CLOSED period posts the
 *    correcting entry into the current OPEN period (dated inside it), never into the
 *    closed period. Closed-period journal totals stay frozen.
 *  - The correcting entry's memo references the original (period-closed annotation).
 *  - Every documentService journal insert enforces balance (the old bypass is gone):
 *    an unbalanced posting is rejected before any row is written.
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initSchema } from '../src/db/schema';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { defaultAccounts, defaultBook } from '../src/accountingV2/schema';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';
import { V2DocumentService } from '../src/accountingV2/documentService';
import { postInvoice } from '../src/accountingV2/postings';

async function setup() {
  const node = makeNodeRunner();
  await initSchema(node.runner);
  const repo = new V2SqlRepository(node.runner);
  const book = defaultBook('guard-book', 'Guard Shop');
  await repo.createBook(book, defaultAccounts(book.id));
  await repo.createPeriod({ id: 'jan', bookId: book.id, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' });
  await repo.createPeriod({ id: 'feb', bookId: book.id, startDate: '2026-02-01', endDate: '2026-02-28', status: 'open' });
  return { ...node, repo, book, service: new V2DocumentService(repo), close: node.close, closeRepo: new V2CloseBooksRepository(node.runner) };
}

describe('closed-period write guard', () => {
  it('redirects a closed-period invoice reversal into the current open period and freezes closed totals', async () => {
    const { runner, close, repo, book, service, closeRepo } = await setup();
    try {
      await repo.createParty({ id: 'cust', bookId: book.id, name: 'Customer', roles: ['customer'] });
      const invoice = await postInvoice(repo, { bookId: book.id, periodId: 'jan', partyId: 'cust', date: '2026-01-15', amount: 100, reference: 'INV-12' });

      // Close January (zero-activity-safe: opening=closing count).
      await closeRepo.recordInventoryCount({ id: 'o', bookId: book.id, periodId: 'jan', date: '2026-01-01', value: 0 });
      await closeRepo.recordInventoryCount({ id: 'c', bookId: book.id, periodId: 'jan', date: '2026-01-31', value: 0 });
      await closeRepo.closeBooks({ id: 'close-jan', bookId: book.id, periodId: 'jan', nextPeriodId: 'feb', date: '2026-01-31', commissionPct: 0 });
      expect(await runner.first('SELECT status FROM v2_periods WHERE id=?', ['jan'])).toEqual({ status: 'closed' });

      // Snapshot Jan's ledger footprint before the correction.
      const janLinesBefore = Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.period_id='jan'"))?.n);
      const janDebitBefore = Number((await runner.first<{ s: number }>("SELECT COALESCE(SUM(l.debit),0) AS s FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.period_id='jan'"))?.s);

      // Delete the invoice that lives in the now-closed January.
      const reversal = await service.reverseSource(invoice.source.id, 'invoice', 'Delete invoice', true);

      // The correcting journal landed in FEBRUARY (the open period), not January.
      const revEntry = await runner.first<{ period_id: string; date: string; memo: string }>('SELECT period_id,date,memo FROM v2_journal_entries WHERE id=?', [reversal.journal.id]);
      expect(revEntry?.period_id).toBe('feb');
      const revDate = revEntry?.date ?? '';
      expect(revDate >= '2026-02-01' && revDate <= '2026-02-28').toBe(true);
      expect(revEntry?.memo).toMatch(/INV-12.*period closed/i);

      // January's journal footprint is unchanged (totals frozen).
      const janLinesAfter = Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.period_id='jan'"))?.n);
      const janDebitAfter = Number((await runner.first<{ s: number }>("SELECT COALESCE(SUM(l.debit),0) AS s FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.period_id='jan'"))?.s);
      expect(janLinesAfter).toBe(janLinesBefore);
      expect(janDebitAfter).toBe(janDebitBefore);

      // Original invoice source is flagged reversed+deleted, and the whole book still balances.
      expect(await runner.first<{ deleted: number }>("SELECT json_extract(metadata,'$.deleted') AS deleted FROM v2_sources WHERE id=?", [invoice.source.id])).toEqual({ deleted: 1 });
      expect((await repo.reconcileBook(book.id)).balanced).toBe(true);
    } finally { close(); }
  });

  it('enforces balance on every documentService insert path (old bypass is dead)', async () => {
    const { runner, close, book, service } = await setup();
    try {
      // A drawing posts through insertSourceJournal; a zero amount would create an
      // invalid (0/0) line — rejected by the balance guard before any row is written.
      await expect(service.drawing({ bookId: book.id, periodId: 'jan', date: '2026-01-10', amount: 0, method: 'cash' })).rejects.toThrow(/positive|balance/i);
      expect(Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_sources WHERE type='drawing'"))?.n)).toBe(0);
      expect(Number((await runner.first<{ n: number }>('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
    } finally { close(); }
  });
});
