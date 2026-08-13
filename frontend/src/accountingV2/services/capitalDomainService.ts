import type { SqlRunner } from '../../db/schema';
import { V2SqlRepository } from '../repository';
import { V2DocumentService } from '../documentService';
import { V2CloseBooksRepository, type CloseBooksResult } from '../closeBooksRepository';
import { V2_BOOK_VERSION, accountingBookVersion } from '../appBootstrap';
import { buildPersistentV2Reports } from '../persistentReports';
import { V2_ACCOUNT_CODES } from '../types';
import { round2 } from '../../money';
import type { AccountingPeriodPolicy } from '../config';
import type { PartyDomainService } from './partyDomainService';

type AnyRecord = Record<string, any>;
type PeriodRow = { id: string; start_date: string; end_date: string };
type MemberCapitalRow = { id: string; name: string; profit_share_pct: number };

const cents = round2;
const normalized = (value: any) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const isGenericAccountsPayableName = (value: any) => /^(creditors?|accounts? payable)$/.test(normalized(value));
const dayAfter = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const endOfMonth = (date: string) => { const d = new Date(`${date}T00:00:00.000Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
const addDays = (date: string, days: number) => { const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const nextFixedPeriodEnd = (start: string, end: string, nextStart: string) => {
  const startDate = new Date(`${start}T00:00:00.000Z`); const endDate = new Date(`${end}T00:00:00.000Z`);
  const calendarAligned = startDate.getUTCDate() === 1 && end === endOfMonth(end);
  if (calendarAligned) {
    const months = (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + endDate.getUTCMonth() - startDate.getUTCMonth() + 1;
    const next = new Date(`${nextStart}T00:00:00.000Z`);
    return new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + months, 0)).toISOString().slice(0, 10);
  }
  const durationDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
  return addDays(nextStart, durationDays);
};
const validIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value; } catch { return false; }
};

export type V2CloseBooksAppInput = { actualStock: number; openingInventory: number; commissionPct: number; notes?: string; date?: string };
export type V2CloseBooksAppResult = { source: 'v2'; result: CloseBooksResult };
export type V2OpeningBalancesInput = {
  date?: string;
  cash: number;
  inventory: number;
  otherAssets?: number;
  assetBreakdown?: { name: string; amount: number }[];
  accountsPayable?: number;
  otherLiabilities?: number;
  liabilityBreakdown?: { name: string; amount: number; type: 'creditor' | 'other' }[];
  ownerCapital?: number;
  retainedEarnings?: number;
  memo?: string;
};
export type V2ClosingBalancePartner = { memberId?: string; name: string; amount: number; profitSharePct?: number };
export type V2ClosingBalancesImportInput = V2OpeningBalancesInput & {
  ownerCapital: number;
  partnerCapitals: V2ClosingBalancePartner[];
  createMissingPartners?: boolean;
  createMissingCreditors?: boolean;
};

export class CapitalDomainService {
  constructor(
    readonly db: SqlRunner,
    readonly repo: V2SqlRepository,
    readonly documents: V2DocumentService,
    readonly parties: PartyDomainService,
    private readonly getActiveContext: (date?: string) => Promise<{ bookId: string; periodId: string } | null>,
    private readonly periodPolicy: (bookId: string) => Promise<AccountingPeriodPolicy>,
    private readonly storePeriodPolicy: (bookId: string, policy: AccountingPeriodPolicy) => Promise<void>,
    private readonly editInput: (input: AnyRecord) => Promise<AnyRecord>,
    private readonly sourceType: (id: string) => Promise<string | null>,
  ) {}

  async postOpeningBalances(input: V2OpeningBalancesInput) {
    return this.applyOpeningBalances(input);
  }

  async updateOpeningBalances(input: V2OpeningBalancesInput) {
    return this.applyOpeningBalances(input);
  }

  async getOpeningBalances() {
    const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!activeBook?.value) return null;
    const row = await this.db.first<{ metadata: string }>(
      "SELECT metadata FROM v2_sources WHERE book_id=? AND type='opening_balance' AND (json_extract(metadata,'$.reversed') IS NULL OR json_extract(metadata,'$.reversed') != 1) AND (json_extract(metadata,'$.deleted') IS NULL OR json_extract(metadata,'$.deleted') != 1) ORDER BY date DESC, id DESC LIMIT 1",
      [activeBook.value],
    );
    if (!row) return null;
    try { return JSON.parse(row.metadata || '{}'); } catch { return null; }
  }

  async importClosingBalances(input: V2ClosingBalancesImportInput) {
    return this.repo.runInTransaction(async () => {
      const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
      if (!activeBook?.value || await accountingBookVersion(this.db, activeBook.value) !== V2_BOOK_VERSION) {
        throw new Error('No active versioned V2 book with an open accounting period');
      }
      const bookId = activeBook.value;
      const book = await this.db.first<{ style: string }>('SELECT style FROM v2_books WHERE id=?', [bookId]);
      const members = await this.db.all<MemberCapitalRow>('SELECT id,name,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY id', [bookId]);
      const hasPartnerScope = (input.partnerCapitals || []).length > 0 || Boolean(input.createMissingPartners) || members.length > 0;
      if (hasPartnerScope && book?.style !== 'retail_partnership') {
        throw new Error('Closing reports with capital accounts can only be imported with Equity Split enabled');
      }
      const memberById = new Map(members.map((member) => [member.id, member]));
      const membersByName = new Map<string, MemberCapitalRow[]>();
      for (const member of members) {
        const key = normalized(member.name);
        membersByName.set(key, [...(membersByName.get(key) || []), member]);
      }

      const matchedIds = new Set<string>();
      const newMemberIds = new Set<string>();
      const partnerCapitals = (input.partnerCapitals || []).map((partner) => {
        const partnerName = String(partner?.name || '').trim();
        const partnerAmount = cents(Number(partner?.amount));
        if (!partnerName || !Number.isFinite(partnerAmount) || partnerAmount < 0) {
          throw new Error('Every closing-report partner requires a name and a non-negative capital amount');
        }
        const candidates = membersByName.get(normalized(partnerName)) || [];
        if (candidates.length > 1) throw new Error(`Configured partner name '${partnerName}' is ambiguous`);
        let member = (partner.memberId ? memberById.get(String(partner.memberId)) : undefined) || candidates[0];
        if (!member) {
          if (!input.createMissingPartners) throw new Error(`No configured partner matches '${partnerName}'`);
          const profitSharePct = Number(partner.profitSharePct);
          if (!Number.isFinite(profitSharePct) || profitSharePct < 0 || profitSharePct > 100) {
            throw new Error(`A valid profit share is required to create partner '${partnerName}'`);
          }
          const memberKey = normalized(partnerName).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member';
          let memberId = `${bookId}:member:${memberKey}`;
          let suffix = 2;
          while (memberById.has(memberId)) memberId = `${bookId}:member:${memberKey}-${suffix++}`;
          member = { id: memberId, name: partnerName, profit_share_pct: profitSharePct };
          memberById.set(member.id, member);
          membersByName.set(normalized(member.name), [member]);
          newMemberIds.add(member.id);
        } else if (partner.profitSharePct !== undefined) {
          const suppliedShare = Number(partner.profitSharePct);
          if (!Number.isFinite(suppliedShare) || suppliedShare < 0 || suppliedShare > 100 || Math.abs(suppliedShare - Number(member.profit_share_pct)) > 0.005) {
            throw new Error(`Profit share for existing partner '${member.name}' must match the configured ${Number(member.profit_share_pct)}%`);
          }
        }
        if (matchedIds.has(member.id)) throw new Error(`Closing report contains partner '${member.name}' more than once`);
        matchedIds.add(member.id);
        return { memberId: member.id, name: member.name, amount: partnerAmount, profitSharePct: Number(member.profit_share_pct) };
      });

      const missing = members.filter((member) => !matchedIds.has(member.id));
      if (missing.length) throw new Error(`Closing report is missing configured partner${missing.length === 1 ? '' : 's'}: ${missing.map((member) => member.name).join(', ')}`);
      const profitShareTotal = cents(partnerCapitals.reduce((sum, partner) => sum + partner.profitSharePct, 0));
      if (partnerCapitals.length && Math.abs(profitShareTotal - 100) > 0.005) {
        throw new Error(`Capital-account profit shares must total 100% (currently ${profitShareTotal}%)`);
      }
      const ownerCapital = cents(Number(input.ownerCapital));
      const partnerTotal = cents(partnerCapitals.reduce((sum, partner) => sum + partner.amount, 0));
      if (hasPartnerScope && (!Number.isFinite(ownerCapital) || Math.abs(partnerTotal - ownerCapital) > 0.005)) {
        throw new Error(`Capital accounts (${partnerTotal.toFixed(2)}) must equal total equity (${Number.isFinite(ownerCapital) ? ownerCapital.toFixed(2) : 'invalid'})`);
      }

      const namedCreditors = (input.liabilityBreakdown || [])
        .filter((liability) => liability.type === 'creditor' && Number(liability.amount) > 0 && !isGenericAccountsPayableName(liability.name))
        .map((liability) => ({ name: liability.name, role: 'supplier' as const }));
      const creditorPreflight = await this.parties.preflightScanParties(namedCreditors);
      const creditorCreations = creditorPreflight.items.filter((item) => item.requiresCreation);
      if (creditorCreations.length && !input.createMissingCreditors) {
        throw new Error(`Supplier ledger creation requires confirmation for: ${creditorCreations.map((item) => item.name).join(', ')}`);
      }

      for (const partner of partnerCapitals) {
        if (!newMemberIds.has(partner.memberId)) continue;
        await this.db.run(
          'INSERT INTO v2_members(id,book_id,name,opening_contribution,current_capital,profit_share_pct) VALUES(?,?,?,?,?,?)',
          [partner.memberId, bookId, partner.name, partner.amount, partner.amount, partner.profitSharePct],
        );
      }

      const result = await this.applyOpeningBalances(input);
      const source = await this.db.first<{ metadata: string }>('SELECT metadata FROM v2_sources WHERE id=? AND book_id=?', [result.sourceId, bookId]);
      if (source) {
        let metadata: AnyRecord = {};
        try { metadata = JSON.parse(source.metadata || '{}'); } catch { /* empty */ }
        metadata.partnerCapitals = partnerCapitals;
        metadata.closingBalanceImport = true;
        await this.db.run('UPDATE v2_sources SET metadata=? WHERE id=? AND book_id=?', [JSON.stringify(metadata), result.sourceId, bookId]);
      }
      for (const partner of partnerCapitals) {
        await this.db.run('UPDATE v2_members SET current_capital=? WHERE id=? AND book_id=?', [partner.amount, partner.memberId, bookId]);
      }
      return { ...result, partnerCapitals };
    });
  }

  async applyOpeningBalances(input: V2OpeningBalancesInput) {
    const cash = cents(input.cash); const inventory = cents(input.inventory);
    if (!Number.isFinite(cash) || cash < 0 || !Number.isFinite(inventory) || inventory < 0) throw new Error('Opening balances must be non-negative');
    const activeBook = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!activeBook?.value || await accountingBookVersion(this.db, activeBook.value) !== V2_BOOK_VERSION) throw new Error('No active versioned V2 book with an open accounting period');
    const bookId = activeBook.value;
    return this.repo.runInTransaction(async () => {
      if (input.date !== undefined && !validIsoDate(input.date)) throw new Error('Opening balance date must use a genuine YYYY-MM-DD date');
      const openPeriods = await this.db.all<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date", [bookId]);
      if (!openPeriods.length) throw new Error('No open accounting period is available. Create or reopen a period before setting opening balances.');
      const date = input.date || openPeriods[0].start_date;
      let target = [...openPeriods].reverse().find((period) => period.start_date <= date && period.end_date >= date);
      if (!target) {
        const closed = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status!='open' AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1", [bookId, date, date]);
        if (closed) throw new Error(`Opening balances can't be dated ${date}: that date falls in the closed period ${closed.start_date} to ${closed.end_date}. Choose a date on or after ${openPeriods[0].start_date}.`);
        const policy = await this.periodPolicy(bookId);
        if (policy.mode === 'fixed') throw new Error(`Opening balance date ${date} is outside the fixed accounting period ${policy.startDate} to ${policy.endDate}`);
        const earliest = openPeriods[0];
        if (date < earliest.start_date) {
          const blocking = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND id!=? AND end_date>=? AND start_date<? ORDER BY start_date DESC LIMIT 1', [bookId, earliest.id, date, earliest.start_date]);
          if (blocking) throw new Error(`Opening balances can't be dated ${date}: the period ${blocking.start_date} to ${blocking.end_date} already covers it. Choose a date on or after ${earliest.start_date}.`);
          await this.db.run('UPDATE v2_periods SET start_date=? WHERE id=?', [date, earliest.id]);
          target = { ...earliest, start_date: date };
        } else {
          const latest = openPeriods[openPeriods.length - 1];
          const blocking = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND id!=? AND start_date<=? AND end_date>? ORDER BY start_date LIMIT 1', [bookId, latest.id, date, latest.end_date]);
          if (blocking) throw new Error(`Opening balances can't be dated ${date}: the period ${blocking.start_date} to ${blocking.end_date} already covers it.`);
          await this.db.run('UPDATE v2_periods SET end_date=? WHERE id=?', [date, latest.id]);
          target = { ...latest, end_date: date };
        }
      }
      const rows = await this.db.all<{ id: string; metadata: string }>("SELECT s.id,s.metadata FROM v2_sources s LEFT JOIN v2_journal_entries j ON j.source_id=s.id AND j.reversal_of IS NULL WHERE s.book_id=? AND s.type='opening_balance' ORDER BY j.posted_at DESC, s.id DESC", [bookId]);
      const live: { id: string; metadata: AnyRecord }[] = [];
      for (const row of rows) {
        let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { continue; }
        if (!metadata.reversed && !metadata.deleted) live.push({ id: row.id, metadata });
      }
      const prior = live[0]?.metadata || {};
      const otherAssets = cents(input.otherAssets ?? Number(prior.otherAssets || 0));
      const assetBreakdown = (input.assetBreakdown ?? prior.assetBreakdown ?? [])
        .map((asset: any) => ({ name: String(asset?.name || "").trim(), amount: cents(asset?.amount) }))
        .filter((asset: any) => asset.name || asset.amount);
      if (assetBreakdown.some((asset: any) => asset.amount < 0 || (asset.amount > 0 && !asset.name))) throw new Error('Each other opening asset requires a name and a non-negative amount');
      if (assetBreakdown.length && cents(assetBreakdown.reduce((sum: number, asset: any) => sum + asset.amount, 0)) !== otherAssets) throw new Error('Other opening asset details must equal the other-assets total');
      const accountsPayable = cents(input.accountsPayable ?? Number(prior.accountsPayable || 0));
      const otherLiabilities = cents(input.otherLiabilities ?? Number(prior.otherLiabilities || 0));
      const liabilityBreakdown = (input.liabilityBreakdown ?? prior.liabilityBreakdown ?? [])
        .map((liability: any) => ({ name: String(liability?.name || "").trim(), amount: cents(liability?.amount), type: liability?.type === "creditor" ? "creditor" : "other" }))
        .filter((liability: any) => liability.name || liability.amount);
      if (liabilityBreakdown.some((liability: any) => liability.amount < 0 || (liability.amount > 0 && !liability.name))) throw new Error('Each opening liability requires a name and a non-negative amount');
      if (liabilityBreakdown.length) {
        const creditorTotal = cents(liabilityBreakdown.filter((liability: any) => liability.type === "creditor").reduce((sum: number, liability: any) => sum + liability.amount, 0));
        const otherTotal = cents(liabilityBreakdown.filter((liability: any) => liability.type === "other").reduce((sum: number, liability: any) => sum + liability.amount, 0));
        if (creditorTotal !== accountsPayable || otherTotal !== otherLiabilities) throw new Error('Opening liability details must equal the liability totals');
      }
      const linkedLiabilityBreakdown = [];
      for (const liability of liabilityBreakdown) {
        if (liability.type === 'creditor' && liability.amount > 0 && !isGenericAccountsPayableName(liability.name)) {
          const existing = await this.parties.partyByName(bookId, liability.name, 'supplier');
          const partyId = await this.parties.party({ ...(existing ? { partyId: existing.id } : {}), supplierName: liability.name }, 'supplier', bookId);
          linkedLiabilityBreakdown.push({ ...liability, partyId });
        } else {
          linkedLiabilityBreakdown.push(liability);
        }
      }
      const retainedEarnings = cents(input.retainedEarnings ?? Number(prior.retainedEarnings || 0));
      const ownerCapital = cents(input.ownerCapital ?? (cash + inventory + otherAssets - accountsPayable - otherLiabilities - retainedEarnings));
      if ([otherAssets, accountsPayable, otherLiabilities, retainedEarnings, ownerCapital].some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Opening balances must be non-negative');
      const totalAssets = cents(cash + inventory + otherAssets);
      const totalLiabilitiesAndEquity = cents(accountsPayable + otherLiabilities + ownerCapital + retainedEarnings);
      if (totalAssets !== totalLiabilitiesAndEquity) throw new Error(`Opening balances do not balance: assets are ${totalAssets.toFixed(2)} and liabilities plus equity are ${totalLiabilitiesAndEquity.toFixed(2)}.`);
      if (live.length === 1 && Number(prior.cash) === cash && Number(prior.inventory) === inventory && Number(prior.otherAssets || 0) === otherAssets && JSON.stringify(prior.assetBreakdown || []) === JSON.stringify(assetBreakdown) && Number(prior.accountsPayable || 0) === accountsPayable && Number(prior.otherLiabilities || 0) === otherLiabilities && JSON.stringify(prior.liabilityBreakdown || []) === JSON.stringify(linkedLiabilityBreakdown) && Number(prior.ownerCapital ?? ownerCapital) === ownerCapital && Number(prior.retainedEarnings || 0) === retainedEarnings && prior.date === date) {
        return { sourceId: live[0].id, alreadyPosted: true };
      }
      for (const entry of live) await this.documents.reverseSource(entry.id, 'opening_balance', 'Update opening balances', true);
      const total = totalAssets;
      const canonicalId = `${bookId}:opening:${target.id}`;
      if (total === 0) return { sourceId: live[0]?.id ?? canonicalId, alreadyPosted: false, journal: null };
      const occupied = await this.db.first('SELECT id FROM v2_sources WHERE id=?', [canonicalId]);
      const sourceId = occupied ? `${canonicalId}:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` : canonicalId;
      const source: any = { id: sourceId, bookId, type: 'opening_balance', date, metadata: { cash, inventory, otherAssets, assetBreakdown, accountsPayable, otherLiabilities, liabilityBreakdown: linkedLiabilityBreakdown, ownerCapital, retainedEarnings, date } };
      const lines: any[] = [];
      if (cash) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.CASH}`, debit: cash, credit: 0 });
      if (inventory) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.INVENTORY}`, debit: inventory, credit: 0 });
      if (otherAssets) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.OTHER_ASSETS}`, debit: otherAssets, credit: 0 });
      const creditorLines = linkedLiabilityBreakdown.filter((liability: any) => liability.type === 'creditor' && liability.amount > 0);
      for (const liability of creditorLines) {
        lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.AP}`, partyId: liability.partyId, debit: 0, credit: liability.amount, memo: liability.name });
      }
      if (accountsPayable && !creditorLines.length) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.AP}`, debit: 0, credit: accountsPayable });
      if (otherLiabilities) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.OTHER_LIABILITIES}`, debit: 0, credit: otherLiabilities });
      if (ownerCapital) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.CAPITAL}`, debit: 0, credit: ownerCapital });
      if (retainedEarnings) lines.push({ accountId: `${bookId}:account:${V2_ACCOUNT_CODES.RETAINED_EARNINGS}`, debit: 0, credit: retainedEarnings });
      const journal = await this.repo.postSourceJournal(source, { bookId, periodId: target.id, date, memo: input.memo || 'Opening balances', lines });
      return { sourceId, alreadyPosted: false, journal };
    });
  }

  async recordInventoryCount(input: { date: string; value: number; notes?: string }) {
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.value);
    if (!Number.isFinite(value) || value < 0) throw new Error('Inventory value must be non-negative');
    const id = `${context.bookId}:inventory:${context.periodId}:${input.date}`;
    const prior = await this.db.first('SELECT id FROM v2_inventory_counts WHERE id=?', [id]);
    if (prior) { await this.db.run('UPDATE v2_inventory_counts SET value=? WHERE id=?', [value, id]); return { id, bookId: context.bookId, periodId: context.periodId, date: input.date, value }; }
    const count = await new V2CloseBooksRepository(this.db).recordInventoryCount({ id, bookId: context.bookId, periodId: context.periodId, date: input.date, value });
    return { ...count, notes: input.notes || '' };
  }

  async recordManualAsset(input: { date: string; name: string; category?: string; amount: number; funding: 'cash' | 'bank' | 'capital' | 'liability'; notes?: string }) {
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.amount);
    const name = String(input.name || '').trim();
    if (!name || !Number.isFinite(value) || value <= 0) throw new Error('Asset name and a positive amount are required');
    await this.repo.ensureDefaultAccounts(context.bookId);
    const creditCode = input.funding === 'bank' ? V2_ACCOUNT_CODES.BANK
      : input.funding === 'capital' ? V2_ACCOUNT_CODES.OWNER_CONTRIBUTIONS
      : input.funding === 'liability' ? V2_ACCOUNT_CODES.OTHER_LIABILITIES
      : V2_ACCOUNT_CODES.CASH;
    const source: any = {
      id: `manual_asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      bookId: context.bookId,
      type: 'manual_asset',
      date: input.date,
      metadata: { name, category: String(input.category || 'Other asset'), total: value, funding: input.funding, notes: input.notes || '' },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: context.bookId, periodId: context.periodId, date: input.date,
      memo: `Asset: ${name}`,
      lines: [
        { accountId: `${context.bookId}:account:${V2_ACCOUNT_CODES.OTHER_ASSETS}`, debit: value, credit: 0, memo: name },
        { accountId: `${context.bookId}:account:${creditCode}`, debit: 0, credit: value, memo: input.notes || name },
      ],
    });
    return { source, journal };
  }

  async recordManualLiability(input: { date: string; name: string; category?: string; amount: number; recognition: 'cash' | 'bank' | 'asset' | 'expense' | 'creditor'; notes?: string }) {
    const context = await this.getActiveContext(input.date);
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const value = cents(input.amount);
    const name = String(input.name || '').trim();
    if (!name || !Number.isFinite(value) || value <= 0) throw new Error('Liability name and a positive amount are required');
    await this.repo.ensureDefaultAccounts(context.bookId);
    const debitCode = input.recognition === 'bank' ? V2_ACCOUNT_CODES.BANK
      : input.recognition === 'asset' ? V2_ACCOUNT_CODES.OTHER_ASSETS
      : input.recognition === 'expense' ? V2_ACCOUNT_CODES.EXPENSES
      : input.recognition === 'creditor' ? V2_ACCOUNT_CODES.INVENTORY
      : V2_ACCOUNT_CODES.CASH;
    const source: any = {
      id: `manual_liability_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      bookId: context.bookId,
      type: 'manual_liability',
      date: input.date,
      metadata: { name, category: String(input.category || 'Other liability'), total: value, recognition: input.recognition, notes: input.notes || '' },
    };
    const journal = await this.repo.postSourceJournal(source, {
      bookId: context.bookId, periodId: context.periodId, date: input.date,
      memo: `Liability: ${name}`,
      lines: [
        { accountId: `${context.bookId}:account:${debitCode}`, debit: value, credit: 0, memo: input.notes || name },
        { accountId: `${context.bookId}:account:${(input.recognition === 'creditor' ? V2_ACCOUNT_CODES.AP : V2_ACCOUNT_CODES.OTHER_LIABILITIES)}`, debit: 0, credit: value, memo: name },
      ],
    });
    return { source, journal };
  }

  async inventoryOverview() {
    const context = await this.getActiveContext();
    if (!context) return null;
    const period = await this.db.first<PeriodRow>('SELECT id,start_date,end_date FROM v2_periods WHERE id=? AND book_id=?', [context.periodId, context.bookId]);
    if (!period) return null;
    const closeRepo = new V2CloseBooksRepository(this.db);
    const counts = await closeRepo.listInventoryCounts(context.bookId, context.periodId);
    const expectedAt = async (to: string) => {
      const report = await buildPersistentV2Reports(this.db, { bookId: context.bookId, to });
      return cents(report.trialBalance.accounts.find((account) => account.code === V2_ACCOUNT_CODES.INVENTORY)?.normalBalance || 0);
    };
    const history = await Promise.all(counts.map(async (count) => {
      const expectedStock = await expectedAt(count.date);
      return { id: count.id, date: count.date, actualStock: count.value, expectedStock, variance: cents(count.value - expectedStock), notes: '' };
    }));
    const expected = await expectedAt(period.end_date);
    const openingInventory = await expectedAt(period.start_date);
    const lastAudit = history.length ? history[history.length - 1] : null;
    const sinceDate = lastAudit?.date || period.start_date;
    const sinceSources = await this.db.all<any>(
      `SELECT type, metadata FROM v2_sources WHERE book_id=? AND date>=? AND date<=?`,
      [context.bookId, sinceDate, period.end_date],
    );
    let purchasesSince = 0;
    let salesSince = 0;
    for (const row of sinceSources) {
      let meta: AnyRecord = {};
      try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
      if (meta.reversed || meta.deleted) continue;
      const tot = Number(meta.total || 0);
      if (row.type === 'cash_purchase' || row.type === 'credit_purchase') purchasesSince += tot;
      else if (row.type === 'cash_sale' || row.type === 'invoice') salesSince += tot;
    }
    return { expected, openingInventory, lastAudit, purchasesSince: cents(purchasesSince), salesSince: cents(salesSince), history: history.reverse(), periodStart: period.start_date, periodEnd: period.end_date, periodPolicy: await this.periodPolicy(context.bookId) };
  }

  async deleteV2InventoryCount(id: string) {
    const context = await this.getActiveContext();
    if (!context) throw new Error('No active versioned V2 book with an open accounting period');
    const count = await this.db.first<{ id: string }>('SELECT id FROM v2_inventory_counts WHERE id=? AND book_id=? AND period_id=?', [id, context.bookId, context.periodId]);
    if (!count) throw new Error('Inventory count not found in the active period');
    await this.db.run('DELETE FROM v2_inventory_counts WHERE id=?', [id]);
  }

  async listManualBalanceTransactions() {
    const context = await this.getActiveContext();
    if (!context) return [];
    const rows = await this.db.all<any>("SELECT id,type,date,metadata FROM v2_sources WHERE book_id=? AND type IN ('manual_asset','manual_liability') ORDER BY date DESC,id DESC", [context.bookId]);
    return rows.flatMap((row) => {
      let metadata: AnyRecord = {}; try { metadata = JSON.parse(row.metadata || '{}'); } catch { return []; }
      if (metadata.reversed || metadata.deleted) return [];
      return [{ id: row.id, type: row.type === 'manual_asset' ? 'asset' as const : 'liability' as const, date: row.date, name: String(metadata.name || ''), category: String(metadata.category || ''), amount: Number(metadata.total || 0), counterparty: String(metadata.funding || metadata.recognition || ''), notes: String(metadata.notes || '') }];
    });
  }

  async deleteManualBalanceTransaction(sourceId: string) {
    const type = await this.sourceType(sourceId);
    if (type !== 'manual_asset' && type !== 'manual_liability') throw new Error('Manual balance transaction not found');
    return this.documents.reverseSource(sourceId, type, 'Delete manual balance transaction', true);
  }

  async updateManualBalanceTransaction(sourceId: string, input: AnyRecord) {
    const row = await this.db.first<{ type: string; metadata: string }>('SELECT type,metadata FROM v2_sources WHERE id=?', [sourceId]);
    if (!row || (row.type !== 'manual_asset' && row.type !== 'manual_liability')) throw new Error('Manual balance transaction not found');
    let prior: AnyRecord = {};
    try { prior = JSON.parse(row.metadata || '{}'); } catch { prior = {}; }
    const next = await this.editInput({ ...prior, ...input });
    if (row.type === 'manual_asset') {
      return this.documents.replaceSource(sourceId, row.type, 'Edit manual asset', () => this.recordManualAsset({
        date: next.date, name: next.name, category: next.category, amount: next.amount ?? next.total,
        funding: next.funding || 'cash', notes: next.notes,
      }));
    }
    return this.documents.replaceSource(sourceId, row.type, 'Edit manual liability', () => this.recordManualLiability({
      date: next.date, name: next.name, category: next.category, amount: next.amount ?? next.total,
      recognition: next.recognition || 'expense', notes: next.notes,
    }));
  }

  async closeBooks(input: V2CloseBooksAppInput): Promise<V2CloseBooksAppResult> {
    const active = await this.db.first<{ value: string }>("SELECT value FROM meta WHERE key='v2_active_book_id'");
    if (!active?.value || await accountingBookVersion(this.db, active.value) !== V2_BOOK_VERSION) throw new Error('No active versioned V2 book');
    const openingInventory = input.openingInventory != null ? Number(input.openingInventory) : 0;
    if (input.actualStock == null) throw new Error('Physical inventory count required: actualStock must be a finite non-negative amount');
    const actualStock = Number(input.actualStock);
    if (!Number.isFinite(actualStock) || actualStock < 0) throw new Error('Physical inventory count required: actualStock must be a finite non-negative amount');
    if (!Number.isFinite(openingInventory) || openingInventory < 0) throw new Error('Opening inventory must be a finite non-negative amount');
    return this.repo.runInTransaction(async () => {
      let period = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' ORDER BY start_date LIMIT 1", [active.value]);
      if (!period) throw new Error('No open accounting period to close');
      const policy = await this.periodPolicy(active.value);
      const closeDate = input.date || period.end_date;
      if (!validIsoDate(closeDate)) throw new Error('Close date must use a genuine YYYY-MM-DD date');
      if (closeDate < period.start_date) throw new Error(`Close date ${closeDate} cannot be before the period start ${period.start_date}`);
      if (policy.mode === 'fixed' && closeDate !== policy.endDate) {
        throw new Error(`Fixed accounting period must close on ${policy.endDate}`);
      }
      const laterJournal = await this.db.first<{ date: string }>('SELECT date FROM v2_journal_entries WHERE book_id=? AND period_id=? AND date>? ORDER BY date LIMIT 1', [active.value, period.id, closeDate]);
      const laterCount = await this.db.first<{ date: string }>('SELECT date FROM v2_inventory_counts WHERE book_id=? AND period_id=? AND date>? ORDER BY date LIMIT 1', [active.value, period.id, closeDate]);
      const later = laterJournal || laterCount;
      if (later) throw new Error(`Accounting period cannot close on ${closeDate} because it contains activity dated ${later.date}`);
      const overlap = await this.db.first<{ id: string }>('SELECT id FROM v2_periods WHERE book_id=? AND id!=? AND start_date<=? AND end_date>=? LIMIT 1', [active.value, period.id, closeDate, period.start_date]);
      if (overlap) throw new Error('Close date conflicts with another configured accounting period');
      if (period.end_date !== closeDate) {
        await this.db.run('UPDATE v2_periods SET end_date=? WHERE id=? AND book_id=?', [closeDate, period.id, active.value]);
        period = { ...period, end_date: closeDate };
      }
      const closeRepo = new V2CloseBooksRepository(this.db);
      const counts = await closeRepo.listInventoryCounts(active.value, period.id);
      if (!counts.some((count) => count.date === period.start_date)) await closeRepo.recordInventoryCount({ id: `${period.id}:opening-inventory`, bookId: active.value, periodId: period.id, date: period.start_date, value: openingInventory });
      if (!counts.some((count) => count.date === closeDate)) await closeRepo.recordInventoryCount({ id: `${period.id}:closing-inventory`, bookId: active.value, periodId: period.id, date: closeDate, value: actualStock });
      const nextStart = dayAfter(closeDate);
      let next = await this.db.first<PeriodRow>("SELECT id,start_date,end_date FROM v2_periods WHERE book_id=? AND status='open' AND start_date>? ORDER BY start_date LIMIT 1", [active.value, closeDate]);
      if (!next) {
        const nextEnd = policy.mode === 'fixed' ? nextFixedPeriodEnd(period.start_date, period.end_date, nextStart) : input.date ? '9999-12-31' : endOfMonth(nextStart);
        next = { id: `${active.value}:period:${nextStart}`, start_date: nextStart, end_date: nextEnd };
        await this.repo.createPeriod({ id: next.id, bookId: active.value, startDate: next.start_date, endDate: next.end_date, status: 'open' });
      }
      const result = await closeRepo.closeBooks({ id: `${active.value}:close:${period.id}`, bookId: active.value, periodId: period.id, nextPeriodId: next.id, date: closeDate, commissionPct: input.commissionPct });
      if (policy.mode === 'fixed') await this.storePeriodPolicy(active.value, { mode: 'fixed', startDate: next.start_date, endDate: next.end_date });
      return { source: 'v2' as const, result };
    });
  }
}
