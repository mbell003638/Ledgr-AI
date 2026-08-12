/**
 * Fable5 audit fixes — V2 ledger behaviors (findings A, C, E, F).
 *
 * These adapt the auditor's device-faithful journeys into the repo's own
 * nodeRunner harness. They assert the FIXED behavior (the auditor's minimized
 * repros asserted the pre-fix dead-ends).
 *
 *  A [credit/debit notes route through V2]:
 *      a customer credit note lowers the AR balance; a supplier debit note moves
 *      the AP balance; both are visible on the party detail and the book stays
 *      balanced. A note with the SCREEN's field shape ({customerId}/{supplierId})
 *      posts (the api maps those to the canonical party field).
 *  C [closed-period EDIT redirects like DELETE]:
 *      editing a sale whose journal is in a CLOSED period succeeds — the
 *      correction lands in the OPEN period and the closed period stays frozen.
 *  E [partially-paid invoice edits]:
 *      raising the total of an invoice with a receipt applied succeeds and keeps
 *      the allocation; lowering it below the received amount is blocked with an
 *      actionable message.
 *  F [markUnpaid is safe]:
 *      updateInvoice({status:'unpaid'}) on an open invoice is a no-op (no throw);
 *      on a receipted invoice it raises an actionable message, not a raw
 *      "Amount must be positive".
 */

import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2SqlRepository } from '../src/accountingV2/repository';
import { V2CloseBooksRepository } from '../src/accountingV2/closeBooksRepository';

async function boot() {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: 'book1', name: 'Shop', style: 'standard', basis: 'accrual' },
    period: { id: 'p2026', startDate: '2026-01-01', endDate: '2026-12-31' },
    personas: ['custom'],
  });
  return { ...node, service: new V2AppService(node.runner), repo: new V2SqlRepository(node.runner) };
}

describe('Finding A — credit/debit notes route through the V2 ledger', () => {
  it('a customer credit note lowers the AR balance and shows on party detail', async () => {
    const { runner, close, service } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 300, clientName: 'Alice' });
      const partyId = String((inv.source.metadata as any).partyId);
      const note = await service.createCreditNote({ debtorId: partyId, clientName: 'Alice', date: '2026-02-05', amount: 50, role: 'customer' });
      expect(note.source.type).toBe('credit_note');
      const detail: any = await service.getPartyDetail(partyId, 'customer');
      expect(detail.balance).toBe(250);                       // 300 invoiced − 50 credited
      expect(detail.statement.ledger.length).toBe(2);
      expect((await service.repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });

  it('a customer debit note raises the AR balance', async () => {
    const { close, service } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 100, clientName: 'Bob' });
      const partyId = String((inv.source.metadata as any).partyId);
      await service.createDebitNote({ debtorId: partyId, clientName: 'Bob', date: '2026-02-06', amount: 25, role: 'customer' });
      const detail: any = await service.getPartyDetail(partyId, 'customer');
      expect(detail.balance).toBe(125);
    } finally { close(); }
  });

  it('a supplier debit note moves the AP balance and shows on the supplier statement', async () => {
    const { close, service } = await boot();
    try {
      const bill = await service.createBill({ date: '2026-02-01', amount: 200, supplierName: 'VendorCo', paymentType: 'credit' });
      const supplierId = String((bill.source.metadata as any).partyId);
      const before: any = await service.getPartyDetail(supplierId, 'supplier');
      expect(before.balance).toBe(200);                       // we owe 200
      await service.createDebitNote({ supplierId, supplierName: 'VendorCo', partyId: supplierId, date: '2026-02-07', amount: 40, role: 'supplier' });
      const after: any = await service.getPartyDetail(supplierId, 'supplier');
      expect(after.balance).toBe(240);                        // debit note increases AP
      expect(after.notes.some((p: any) => p.kind === 'debit_note')).toBe(true);
      expect(after.paymentsTotal).toBe(0);                    // notes are not cash payments
      expect((await service.repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });

  it('a supplier credit note lowers the AP balance', async () => {
    const { close, service } = await boot();
    try {
      const bill = await service.createBill({ date: '2026-02-01', amount: 200, supplierName: 'VendorCo', paymentType: 'credit' });
      const supplierId = String((bill.source.metadata as any).partyId);
      await service.createCreditNote({ supplierId, supplierName: 'VendorCo', partyId: supplierId, date: '2026-02-08', amount: 30, role: 'supplier' });
      const after: any = await service.getPartyDetail(supplierId, 'supplier');
      expect(after.balance).toBe(170);                        // 200 − 30 credited back
      expect((await service.repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });

  it('edits a note by reversal/repost and preserves its visible details', async () => {
    const { runner, close, service } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 300, clientName: 'Edit Note' });
      const partyId = String((inv.source.metadata as any).partyId);
      const other = await service.createBill({ date: '2026-02-02', amount: 10, supplierName: 'Other Party', paymentType: 'credit' });
      const otherPartyId = String((other.source.metadata as any).partyId);
      const note = await service.createCreditNote({ debtorId: partyId, clientName: 'Edit Note', date: '2026-02-05', amount: 25, role: 'customer', reference: 'CN-1', reason: 'Return', notes: 'One unit' });
      await service.updateNote(note.source.id, { date: '2026-02-06', amount: 40, reference: '', reason: 'Damaged return', notes: 'Two units', partyId: otherPartyId, supplierId: otherPartyId, role: 'supplier' });
      const detail: any = await service.getPartyDetail(partyId, 'customer');
      const visible = detail.statement.ledger.find((row: any) => row.kind === 'credit_note');
      expect(detail.balance).toBe(260);
      expect(visible).toMatchObject({ ref: null, reason: 'Damaged return', notes: 'Two units', amount: 40 });
      const otherDetail: any = await service.getPartyDetail(otherPartyId, 'supplier');
      expect(otherDetail.notes).toHaveLength(0);              // caller cannot migrate note across party/role
      expect(otherDetail.balance).toBe(10);
      const original: any = await runner.first('SELECT metadata FROM v2_sources WHERE id=?', [note.source.id]);
      expect(Boolean(JSON.parse(original.metadata).reversed)).toBe(true);
      expect((await service.repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });
});

describe('standardized sale and invoice lines', () => {
  it('persists units and discounts while posting the discounted total', async () => {
    const { close, service } = await boot();
    try {
      const invoice = await service.createInvoice({
        date: '2026-03-01', clientName: 'Unit Buyer', discount: 20, taxRate: 10,
        lines: [{ description: 'Cases', qty: 2, unit: 'dzn', rate: 100 }],
      });
      expect((invoice.source.metadata as any)).toMatchObject({ subtotal: 200, discount: 20, tax: 18, total: 198 });
      const listed: any = (await service.listSalesAndInvoices()).find((row: any) => row.id === invoice.source.id);
      expect(listed.lines).toEqual([{ description: 'Cases', qty: 2, unit: 'dzn', rate: 100 }]);
      expect(listed.discount).toBe(20);
      const party = await service.getPartyDetail(String((invoice.source.metadata as any).partyId), 'customer');
      expect(party?.balance).toBe(198);

      const cash = await service.createSale({ date: '2026-03-02', discount: 5, lines: [{ description: 'Set', qty: 2, unit: 'sets', rate: 25 }] });
      expect((cash.source.metadata as any)).toMatchObject({ subtotal: 50, discount: 5, total: 45 });
      expect((await service.repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });
});

describe('Finding C — editing a closed-period sale redirects into the open period', () => {
  async function bootWithClose() {
    const node = makeNodeRunner();
    // initializeV2Book sets the correct book version + v2_active_book_id meta.
    await initializeV2Book(node.runner, {
      book: { id: 'book1', name: 'Shop', style: 'standard', basis: 'accrual' },
      period: { id: 'jan', startDate: '2026-01-01', endDate: '2026-01-31' },
      personas: ['custom'],
    });
    const repo = new V2SqlRepository(node.runner);
    await repo.createPeriod({ id: 'feb', bookId: 'book1', startDate: '2026-02-01', endDate: '2026-02-28', status: 'open' });
    return { ...node, repo, service: new V2AppService(node.runner), closeRepo: new V2CloseBooksRepository(node.runner) };
  }

  it('closed-period cash sale edit succeeds; correction lands in the open period, closed totals frozen', async () => {
    const { runner, close, repo, service, closeRepo } = await bootWithClose();
    try {
      const sale = await service.createSale({ date: '2026-01-15', amount: 500, method: 'cash' });
      // Close January.
      await closeRepo.recordInventoryCount({ id: 'o', bookId: 'book1', periodId: 'jan', date: '2026-01-01', value: 0 });
      await closeRepo.recordInventoryCount({ id: 'c', bookId: 'book1', periodId: 'jan', date: '2026-01-31', value: 0 });
      await closeRepo.closeBooks({ id: 'close-jan', bookId: 'book1', periodId: 'jan', nextPeriodId: 'feb', date: '2026-01-31', commissionPct: 0 });

      const janLinesBefore = Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.period_id='jan'"))?.n);

      // Edit the closed-period sale (previously a dead-end).
      const res = await service.updateSale(sale.source.id, { date: '2026-01-15', amount: 600, method: 'cash' });
      expect(res).toBeTruthy();

      // Replacement + reversal both live in February (the open period).
      const febEntries = await runner.all<{ id: string }>("SELECT id FROM v2_journal_entries WHERE period_id='feb'");
      expect(febEntries.length).toBeGreaterThanOrEqual(2);
      // January's footprint is unchanged (frozen).
      const janLinesAfter = Number((await runner.first<{ n: number }>("SELECT COUNT(*) AS n FROM v2_journal_lines l JOIN v2_journal_entries j ON j.id=l.journal_id WHERE j.period_id='jan'"))?.n);
      expect(janLinesAfter).toBe(janLinesBefore);
      // Book still balances.
      expect((await repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });
});

describe('Finding E — editing a partially-paid invoice', () => {
  it('raising the total above the received amount succeeds and keeps the allocation', async () => {
    const { close, service, repo } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 100, clientName: 'Alice' });
      const partyId = String((inv.source.metadata as any).partyId);
      await service.createReceipt({ date: '2026-02-02', amount: 60, debtorId: partyId, method: 'cash', allocations: [{ invoiceId: inv.source.id, amountApplied: 60 }] });
      const res: any = await service.updateInvoice(inv.source.id, { date: '2026-02-01', total: 200, clientName: 'Alice' });
      // Open balance is newTotal − allocated = 140.
      expect(await repo.invoiceOpen(res.source.id)).toBe(140);
      expect((await repo.reconcileBook('book1')).balanced).toBe(true);
    } finally { close(); }
  });

  it('lowering the total below the received amount is blocked with an actionable message', async () => {
    const { close, service } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 100, clientName: 'Bob' });
      const partyId = String((inv.source.metadata as any).partyId);
      await service.createReceipt({ date: '2026-02-02', amount: 80, debtorId: partyId, method: 'cash', allocations: [{ invoiceId: inv.source.id, amountApplied: 80 }] });
      await expect(service.updateInvoice(inv.source.id, { date: '2026-02-01', total: 50, clientName: 'Bob' }))
        .rejects.toThrow(/already received against this invoice/i);
    } finally { close(); }
  });
});

describe('Finding F — markUnpaid (status-only invoice edit) is safe', () => {
  it('status-only unpaid on an open invoice is a no-op (no throw); balance intact', async () => {
    const { close, service } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 100, clientName: 'Alice' });
      const partyId = String((inv.source.metadata as any).partyId);
      await expect(service.updateInvoice(inv.source.id, { status: 'unpaid' })).resolves.toBeTruthy();
      const detail: any = await service.getPartyDetail(partyId, 'customer');
      expect(detail.balance).toBe(100);
    } finally { close(); }
  });

  it('status-only unpaid on a receipted invoice raises an actionable message (not "Amount must be positive")', async () => {
    const { close, service } = await boot();
    try {
      const inv = await service.createInvoice({ date: '2026-02-01', total: 100, clientName: 'Carol' });
      const partyId = String((inv.source.metadata as any).partyId);
      await service.createReceipt({ date: '2026-02-02', amount: 40, debtorId: partyId, method: 'cash', allocations: [{ invoiceId: inv.source.id, amountApplied: 40 }] });
      await expect(service.updateInvoice(inv.source.id, { status: 'unpaid' }))
        .rejects.toThrow(/receipt applied/i);
    } finally { close(); }
  });
});
