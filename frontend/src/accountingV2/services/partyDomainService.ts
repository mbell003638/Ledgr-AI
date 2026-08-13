import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2DocumentService } from '../documentService';
import { V2_BOOK_VERSION, accountingBookVersion } from '../appBootstrap';
import type { V2PartyRole } from '../types';
import { round2 } from '../../money';

type AnyRecord = Record<string, any>;
const cents = round2;
const normalized = (value: any) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isGenericAccountsPayableName = (value: any) => /^(creditors?|accounts? payable)$/.test(normalized(value));
let partyRepairSequence = 0;

export const partyDisplayName = (value: any) => {
  let name = String(value || '').trim();
  while (/^v2:(customer|supplier):/i.test(name)) name = name.replace(/^v2:(customer|supplier):/i, '').trim();
  return name;
};

export const stablePartyId = (role: V2PartyRole, input: AnyRecord) => {
  const explicit = input.partyId || input[role === 'customer' ? 'debtorId' : 'supplierId'];
  if (explicit) return String(explicit);
  return `v2:${role}:${normalized(partyDisplayName(input[role === 'customer' ? 'clientName' : 'supplierName']))}`;
};

export type V2ScanPartyRequest = { name: string; role: V2PartyRole };
export type V2ScanPartyPreflightItem = V2ScanPartyRequest & {
  status: 'existing' | 'missing' | 'role_missing' | 'ignored_generic_ap';
  partyId?: string;
  requiresCreation: boolean;
};

export class PartyDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    readonly documents: V2DocumentService,
    private readonly getActiveContext: () => Promise<{ bookId: string; periodId: string } | null>,
  ) {}

  async assertPartyNameAvailable(name: string, bookId?: string) {
    const targetBookId = bookId || (await this.getActiveContext())?.bookId;
    if (!targetBookId) throw new Error('No active versioned V2 book');
    const members = await this.db.all<{ name: string }>('SELECT name FROM v2_members WHERE book_id=?', [targetBookId]);
    if (members.some((member) => normalized(member.name) === normalized(name))) {
      throw new Error(`A Capital Account named '${String(name || '').trim()}' already exists. A Customer or Supplier must use a different name.`);
    }
  }

  async party(input: AnyRecord, role: V2PartyRole, bookId: string) {
    const id = stablePartyId(role, input);
    const requestedName = partyDisplayName(input[role === 'customer' ? 'clientName' : 'supplierName']);
    const name = requestedName || partyDisplayName(input.partyId || id) || id;
    await this.assertPartyNameAvailable(name, bookId);
    const existing = await this.db.first('SELECT id FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
    if (!existing) await this.repo.createParty({ id, bookId, name, phone: input.clientPhone || input.phone, email: input.email, roles: [role] });
    else {
      const row = await this.db.first<{ roles: string }>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [id, bookId]);
      const roles: V2PartyRole[] = row ? JSON.parse(row.roles) : [];
      if (!roles.includes(role)) await this.db.run('UPDATE v2_parties SET roles=? WHERE id=?', [JSON.stringify([...roles, role]), id]);
    }
    return id;
  }

  async partyByName(bookId: string, name: string, role?: V2PartyRole) {
    const rows = await this.db.all<{ id: string; name: string; roles: string }>('SELECT id,name,roles FROM v2_parties WHERE book_id=? AND archived=0', [bookId]);
    const matches = rows.filter((row) => normalized(row.name) === normalized(name));
    if (!matches.length) return null;
    if (!role) return matches[0];
    return matches.find((row) => {
      try { return (JSON.parse(row.roles || '[]') as string[]).includes(role); } catch { return false; }
    }) || matches[0];
  }

  async preflightScanParties(requests: V2ScanPartyRequest[]) {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) {
      throw new Error('No active versioned V2 book');
    }
    const unique = new Map<string, V2ScanPartyRequest>();
    for (const request of requests || []) {
      const name = String(request?.name || '').trim();
      const role = request?.role === 'supplier' ? 'supplier' : 'customer';
      if (!name) throw new Error(`${role === 'supplier' ? 'Supplier' : 'Customer'} name is required`);
      unique.set(`${role}:${normalized(name)}`, { name, role });
    }
    const items: V2ScanPartyPreflightItem[] = [];
    for (const request of unique.values()) {
      if (request.role === 'supplier' && isGenericAccountsPayableName(request.name)) {
        items.push({ ...request, status: 'ignored_generic_ap', requiresCreation: false });
        continue;
      }
      const existing = await this.partyByName(active.value, request.name, request.role);
      if (!existing) {
        items.push({ ...request, status: 'missing', requiresCreation: true });
        continue;
      }
      let roles: string[] = [];
      try { roles = JSON.parse(existing.roles || '[]'); } catch { roles = []; }
      const hasRole = roles.includes(request.role);
      items.push({ ...request, partyId: existing.id, status: hasRole ? 'existing' : 'role_missing', requiresCreation: !hasRole });
    }
    return { items, requiresApproval: items.some((item) => item.requiresCreation) };
  }

  async approvedScanParty(bookId: string, name: string, role: V2PartyRole, createMissingParty: boolean) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error(`${role === 'supplier' ? 'Supplier' : 'Customer'} name is required`);
    if (role === 'supplier' && isGenericAccountsPayableName(cleanName)) {
      throw new Error(`'${cleanName}' is an aggregate Accounts Payable label, not a supplier`);
    }
    const existing = await this.partyByName(bookId, cleanName, role);
    let roles: string[] = [];
    try { roles = existing ? JSON.parse(existing.roles || '[]') : []; } catch { roles = []; }
    if (existing && roles.includes(role)) return existing.id;
    if (!createMissingParty) {
      throw new Error(`${role === 'supplier' ? 'Supplier' : 'Customer'} ledger '${cleanName}' requires confirmed creation`);
    }
    return this.party({
      ...(existing ? { partyId: existing.id } : {}),
      [role === 'customer' ? 'clientName' : 'supplierName']: cleanName,
    }, role, bookId);
  }

  async ensureParty(name: string, role: V2PartyRole, details: { phone?: string; email?: string } = {}) {
    const context = await this.getActiveContext();
    if (!context) throw new Error('No active versioned V2 book');
    const id = await this.party({ [role === 'customer' ? 'clientName' : 'supplierName']: partyDisplayName(name), phone: details.phone, email: details.email }, role, context.bookId);
    return this.db.first<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE id=? AND book_id=?', [id, context.bookId]);
  }

  async repairPartyIdentities(bookId: string) {
    const suspect = await this.db.first<{ id: string }>(`SELECT id FROM v2_parties
      WHERE book_id=? AND (
        id LIKE 'v2:customer:v2:%' OR id LIKE 'v2:supplier:v2:%'
        OR name LIKE 'v2:customer:%' OR name LIKE 'v2:supplier:%'
      ) LIMIT 1`, [bookId]);
    if (!suspect) return;
    const savepoint = `v2_party_repair_${++partyRepairSequence}`;
    await this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const rows = await this.db.all<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE book_id=?', [bookId]);
      const sources = await this.db.all<any>('SELECT id,metadata FROM v2_sources WHERE book_id=?', [bookId]);
      for (const row of rows) {
        const cleanName = partyDisplayName(row.name);
        let roles: V2PartyRole[] = [];
        try { roles = JSON.parse(row.roles || '[]'); } catch { roles = []; }
        const role = roles.includes('supplier') && !roles.includes('customer') ? 'supplier' : 'customer';
        const canonicalId = `v2:${role}:${normalized(cleanName)}`;
        const corrupt = cleanName !== String(row.name || '').trim() || /^v2:(customer|supplier):v2:/i.test(row.id);
        if (!corrupt || !cleanName) continue;
        if (row.id === canonicalId) {
          await this.db.run('UPDATE v2_parties SET name=? WHERE id=? AND book_id=?', [cleanName, row.id, bookId]);
          continue;
        }
        const canonical = await this.db.first<any>('SELECT roles FROM v2_parties WHERE id=? AND book_id=?', [canonicalId, bookId]);
        if (!canonical) {
          await this.repo.createParty({ id: canonicalId, bookId, name: cleanName, phone: row.phone, email: row.email, roles: roles.length ? roles : [role] });
        } else {
          let canonicalRoles: V2PartyRole[] = [];
          try { canonicalRoles = JSON.parse(canonical.roles || '[]'); } catch { canonicalRoles = []; }
          await this.db.run('UPDATE v2_parties SET roles=? WHERE id=?', [JSON.stringify([...new Set([...canonicalRoles, ...roles])]), canonicalId]);
        }
        await this.db.run('UPDATE v2_journal_lines SET party_id=? WHERE party_id=?', [canonicalId, row.id]);
        for (const source of sources) {
          let metadata: any = {};
          try { metadata = JSON.parse(source.metadata || '{}'); } catch { continue; }
          let changed = false;
          for (const key of ['partyId', 'customerId']) if (metadata[key] === row.id) { metadata[key] = canonicalId; changed = true; }
          if (changed) {
            source.metadata = JSON.stringify(metadata);
            await this.db.run('UPDATE v2_sources SET metadata=? WHERE id=?', [source.metadata, source.id]);
          }
        }
        await this.db.run('DELETE FROM v2_parties WHERE id=? AND book_id=?', [row.id, bookId]);
      }
      await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      try {
        await this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } catch { /* preserve the repair failure */ }
      throw error;
    }
  }

  async listParties() {
    const context = await this.getActiveContext(); if (!context) return [];
    await this.repairPartyIdentities(context.bookId);
    const rows = await this.db.all<any>(`SELECT p.id,p.name,p.phone,p.email,p.roles,
      COALESCE(SUM(CASE WHEN a.code='1100' THEN l.debit-l.credit ELSE 0 END),0) AS receivable,
      COALESCE(SUM(CASE WHEN a.code='2000' THEN l.credit-l.debit ELSE 0 END),0) AS payable
      FROM v2_parties p
      LEFT JOIN v2_journal_lines l ON l.party_id=p.id
      LEFT JOIN v2_journal_entries j ON j.id=l.journal_id AND j.book_id=p.book_id
      LEFT JOIN v2_accounts a ON a.id=l.account_id
      WHERE p.book_id=? AND p.archived=0
      GROUP BY p.id,p.name,p.phone,p.email,p.roles
      ORDER BY p.name`, [context.bookId]);
    return rows.map((row) => {
      let roles: string[] = []; try { roles = JSON.parse(row.roles || '[]'); } catch { roles = []; }
      const receivable = Number(row.receivable || 0); const payable = Number(row.payable || 0);
      return { id: row.id, name: row.name, phone: row.phone, email: row.email, roles, receivable, payable, net: receivable - payable };
    });
  }

  async getPartyDetail(id: string, role: 'customer' | 'supplier') {
    const context = await this.getActiveContext(); if (!context) return null;
    await this.repairPartyIdentities(context.bookId);
    const party = await this.db.first<any>('SELECT id,name,phone,email,roles FROM v2_parties WHERE id=? AND book_id=? AND archived=0', [id, context.bookId]);
    if (!party) return null;
    let roles: string[] = []; try { roles = JSON.parse(party.roles || '[]'); } catch { roles = []; }
    if (!roles.includes(role)) return null;
    const sourceTypes = role === 'customer' ? ['invoice', 'receipt', 'credit_note', 'debit_note'] : ['cash_purchase', 'credit_purchase', 'supplier_payment', 'credit_note', 'debit_note', 'opening_balance'];
    const placeholders = sourceTypes.map(() => '?').join(','); const accountCode = role === 'customer' ? '1100' : '2000';
    const rows = await this.db.all<any>(`SELECT s.id,s.type,s.date,s.reference,s.metadata,
      COALESCE(SUM(CASE WHEN a.code=? THEN l.debit ELSE 0 END),0) AS debit,
      COALESCE(SUM(CASE WHEN a.code=? THEN l.credit ELSE 0 END),0) AS credit
      FROM v2_sources s LEFT JOIN v2_journal_entries j ON j.source_id=s.id
      LEFT JOIN v2_journal_lines l ON l.journal_id=j.id AND l.party_id=? LEFT JOIN v2_accounts a ON a.id=l.account_id
      WHERE s.book_id=? AND (json_extract(s.metadata,'$.partyId')=? OR EXISTS (
        SELECT 1 FROM v2_journal_entries je2 JOIN v2_journal_lines jl2 ON jl2.journal_id=je2.id
        WHERE je2.source_id=s.id AND jl2.party_id=?
      )) AND s.type IN (${placeholders})
      GROUP BY s.id,s.type,s.date,s.reference,s.metadata ORDER BY s.date,s.id`, [accountCode, accountCode, id, context.bookId, id, id, ...sourceTypes]);
    const active = rows.flatMap((row) => { let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; } return metadata.deleted || metadata.reversed ? [] : [{ ...row, metadata }]; });
    if (role === 'customer') {
      let running = 0;
      const ledger = active.map((row) => { const debit = cents(row.debit); const credit = cents(row.credit); running = cents(running + debit - credit); return { id: row.id, kind: row.type, date: row.date, ref: row.reference, reason: row.metadata.reason || '', notes: row.metadata.notes || '', amount: Number(row.metadata.total || debit || credit || 0), debit, credit, balance: running }; });
      const totalInvoiced = cents(active.filter((row) => row.type === 'invoice').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      const totalPaid = cents(active.filter((row) => row.type === 'receipt').reduce((sum, row) => sum + Number(row.metadata.total || 0), 0));
      return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles,
        payments: active.filter((row) => row.type === 'receipt').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '' })),
        totalInvoiced, totalPaid, balance: running, statement: { ledger: ledger.slice().reverse(), balance: running } };
    }
    const bills = active.filter((row) => row.type === 'cash_purchase' || row.type === 'credit_purchase').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), invoiceNo: row.metadata.invoiceNo || row.reference || '', notes: row.metadata.notes || '', paymentType: row.type === 'cash_purchase' ? 'cash' : 'credit' }));
    const notes = active.filter((row) => row.type === 'credit_note' || row.type === 'debit_note').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), reason: row.metadata.reason || '', notes: row.metadata.notes || '', reference: row.reference || '', kind: row.type === 'credit_note' ? 'credit_note' : 'debit_note' }));
    const payments = active.filter((row) => row.type === 'supplier_payment').map((row) => ({ id: row.id, date: row.date, amount: Number(row.metadata.total || 0), notes: row.metadata.notes || '', reference: row.reference || '' }));
    const billsTotal = cents(bills.reduce((sum, row) => sum + row.amount, 0)); const paymentsTotal = cents(payments.reduce((sum, row) => sum + row.amount, 0));
    const balance = cents(active.reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0));
    return { id: party.id, name: party.name, phone: party.phone || '', email: party.email || '', roles, bills: bills.reverse(), payments: payments.reverse(), notes: notes.reverse(), billsTotal, paymentsTotal, balance };
  }

  async updateParty(id: string, patch: AnyRecord) {
    const current = await this.db.first<{ book_id: string; name: string }>('SELECT book_id,name FROM v2_parties WHERE id=?', [id]);
    if (current && patch.name != null && normalized(patch.name) !== normalized(current.name)) {
      await this.assertPartyNameAvailable(String(patch.name), current.book_id);
    }
    return this.documents.updateParty(id, patch);
  }

  async archiveParty(id: string) {
    return this.documents.archiveParty(id);
  }
}
