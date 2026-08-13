import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2DocumentService } from '../documentService';
import { postInvoice } from '../postings';
import { calculateInvoiceTotals } from '../../utils/invoiceTotals';
import type { PartyDomainService } from './partyDomainService';

type AnyRecord = Record<string, any>;
const amount = (value: any) => Number(value);

export class InvoiceDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    readonly documents: V2DocumentService,
    readonly parties: PartyDomainService,
    private readonly getActiveContext: (date?: string) => Promise<{ bookId: string; periodId: string } | null>,
    private readonly editInput: (input: AnyRecord) => Promise<AnyRecord>,
  ) {}

  async createInvoice(input: AnyRecord) {
    const c = await this.getActiveContext(input.date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    const lines = Array.isArray(input.lines) ? input.lines : [];
    const totals = lines.length ? calculateInvoiceTotals(lines, input.discount || 0, input.taxRate || 0) : null;
    const net = totals?.total ?? amount(input.total ?? input.amount);
    return this.repo.runInTransaction(async () => {
      const partyId = await this.parties.party(input, 'customer', c.bookId);
      return postInvoice(this.repo, {
        ...c,
        date: input.date,
        partyId,
        amount: net,
        reference: input.invoiceNumber || input.reference,
        metadata: {
          clientPhone: input.clientPhone,
          dueDate: input.dueDate,
          lines,
          notes: input.notes,
          terms: input.terms,
          taxLabel: input.taxLabel,
          taxRate: Number(input.taxRate || 0),
          discount: totals?.discount ?? Number(input.discount || 0),
          subtotal: totals?.subtotal ?? Number(input.subtotal ?? net),
          tax: totals?.tax ?? 0,
        },
      });
    });
  }

  async updateInvoice(id: string, input: AnyRecord) {
    const hasTotal = input.total != null || input.amount != null;
    if (!hasTotal && input.status != null) {
      const row = await this.db.first<any>("SELECT id,type,date,reference,metadata FROM v2_sources WHERE id=? AND type='invoice'", [id]);
      if (!row) throw new Error('Invoice not found');
      const alloc = await this.db.first<{ id: string }>('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [id]);
      if (String(input.status) === 'unpaid' && alloc) {
        throw new Error('This invoice has a receipt applied to it. Delete or adjust the receipt to mark it unpaid.');
      }
      let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = {}; }
      return { source: { id: row.id, type: row.type, date: row.date, reference: row.reference, metadata } };
    }
    const next = await this.editInput(input);
    const allocated = await this.db.first<{ id: string }>('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [id]);
    if (allocated) {
      const newTotal = amount(next.total ?? next.amount);
      return this.documents.replaceInvoicePreservingAllocations(id, 'Edit invoice', newTotal, () => this.createInvoice(next));
    }
    return this.documents.replaceSource(id, 'invoice', 'Edit invoice', () => this.createInvoice(next));
  }

  async deleteInvoice(id: string) {
    return this.documents.reverseSource(id, 'invoice', 'Delete invoice', true);
  }

  async markInvoicePaid(id: string, input: AnyRecord = {}) {
    const date = input.date || new Date().toISOString().slice(0, 10);
    const c = await this.getActiveContext(date);
    if (!c) throw new Error('No active versioned V2 book with an open accounting period');
    return this.documents.markInvoicePaid(id, { periodId: c.periodId, date, method: input.method });
  }

  async listSalesAndInvoices() {
    const context = await this.getActiveContext();
    if (!context) return [];
    await this.parties.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>(
      "SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name FROM v2_sources s LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId') WHERE s.book_id=? AND s.type IN ('cash_sale','invoice') ORDER BY s.date DESC,s.id DESC",
      [context.bookId],
    );
    const result = [];
    for (const row of rows) {
      const meta = JSON.parse(row.metadata || '{}');
      if (meta.deleted || meta.reversed) continue;
      const open = row.type === 'invoice' ? await this.repo.invoiceOpen(row.id) : 0;
      result.push({
        id: row.id,
        type: row.type,
        date: row.date,
        reference: row.reference,
        amount: Number(meta.total || 0),
        total: Number(meta.total || 0),
        partyId: meta.partyId,
        partyName: row.party_name,
        clientName: row.party_name,
        clientPhone: meta.clientPhone || '',
        status: row.type === 'cash_sale' ? 'paid' : open <= 0 ? 'paid' : open < Number(meta.total || 0) ? 'partial' : 'unpaid',
        openAmount: open,
        notes: meta.notes,
        method: meta.method,
        lines: Array.isArray(meta.lines) ? meta.lines : [],
        discount: Number(meta.discount || 0),
        subtotal: Number(meta.subtotal ?? meta.total ?? 0),
        tax: Number(meta.tax || 0),
        taxLabel: meta.taxLabel,
        taxRate: Number(meta.taxRate || 0),
        dueDate: meta.dueDate,
        terms: meta.terms,
      });
    }
    return result;
  }
}
