import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2DocumentService } from '../documentService';
import { postInvoice } from '../postings';
import { calculateInvoiceTotals } from '../../utils/invoiceTotals';
import { localTodayIso } from '../../utils/dateValidation';
import type { PartyDomainService } from './partyDomainService';
import { ProductDomainService } from './productDomainService';
import { resolveWriteLocationId } from './locationDomainService';

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
    const productLines = Array.isArray(input.productLines) ? input.productLines : [];
    const locationId = await resolveWriteLocationId(this.db, c.bookId, input.locationId);
    return this.repo.runInTransaction(async () => {
      const partyId = await this.parties.party(input, 'customer', c.bookId);
      const result = await postInvoice(this.repo, {
        ...c,
        date: input.date,
        partyId,
        amount: net,
        reference: input.invoiceNumber || input.reference,
        locationId: locationId || undefined,
        metadata: {
          clientPhone: input.clientPhone,
          dueDate: input.dueDate,
          lines,
          notes: input.notes,
          terms: input.terms,
          taxLabel: input.taxLabel,
          taxRate: Number(input.taxRate || 0),
          discount: totals?.discount ?? Number(input.discount || 0),
          subtotal: totals?.subtotal ?? (input.subtotal != null ? Number(input.subtotal) : (input.tax != null ? Number(net) - Number(input.tax) : net)),
          tax: totals?.tax ?? Number(input.tax || 0),
          ...(input.locationId ? { locationId: String(input.locationId) } : {}),
          ...(input.posSessionId ? { posSessionId: String(input.posSessionId) } : {}),
          ...(productLines.length ? { productLines } : {}),
        },
      });
      if (productLines.length) {
        await new ProductDomainService(this.db, this.repo, this.getActiveContext)
          .applySaleLines(c.bookId, c.periodId, input.date, result.source.id, productLines, locationId || undefined);
      }
      return result;
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
    const row = await this.db.first<any>("SELECT id,type,date,reference,metadata FROM v2_sources WHERE id=? AND type='invoice'", [id]);
    if (!row) throw new Error('Invoice not found');
    let priorMeta: AnyRecord = {}; try { priorMeta = JSON.parse(row.metadata || '{}'); } catch { priorMeta = {}; }
    const next = await this.editInput(input);
    const payload = Array.isArray(next.productLines) ? next : { ...next, productLines: priorMeta.productLines };
    const allocated = await this.db.first<{ id: string }>('SELECT id FROM v2_invoice_allocations WHERE invoice_source_id=? LIMIT 1', [id]);
    if (allocated) {
      const c = await this.getActiveContext(next.date || row.date);
      if (!c) throw new Error('No active versioned V2 book with an open accounting period');
      const nextPartyId = await this.resolveExistingCustomerId(next, c.bookId);
      const unresolvedNewName = !next.partyId && !next.customerId && !next.debtorId && !!next.clientName && !nextPartyId;
      if ((nextPartyId && priorMeta.partyId && nextPartyId !== priorMeta.partyId) || unresolvedNewName) {
        throw new Error('Cannot change customer on an invoice that has active receipt allocations. Remove receipt allocations first.');
      }
      const newTotal = amount(payload.total ?? payload.amount);
      return this.documents.replaceInvoicePreservingAllocations(id, 'Edit invoice', newTotal, () => this.createInvoice(payload));
    }
    return this.documents.replaceSource(id, 'invoice', 'Edit invoice', () => this.createInvoice(payload));
  }

  /** Lookup only. Never createParty / ensureParty / party() — those insert before the allocation guard can throw. */
  private async resolveExistingCustomerId(next: AnyRecord, bookId: string): Promise<string | null> {
    const explicitId = next.partyId || next.customerId || next.debtorId;
    if (explicitId) return String(explicitId);
    if (!next.clientName) return null;
    const existing = await this.parties.partyByName(bookId, String(next.clientName), 'customer');
    return existing?.id ?? null;
  }

  async deleteInvoice(id: string) {
    return this.documents.reverseSource(id, 'invoice', 'Delete invoice', true);
  }

  async markInvoicePaid(id: string, input: AnyRecord = {}) {
    const date = input.date || localTodayIso();
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
