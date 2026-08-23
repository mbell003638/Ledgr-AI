/**
 * Investor-capital UX contracts:
 *  (a) the Parties tile shows the SAME journal-computed capital balance as the
 *      investor detail screen (not the static period-opening snapshot);
 *  (b) the Cash Book lists the single V2 capital journal exactly once;
 *  (c) the Cash In "Investor capital" entry point and the Parties "+ Capital"
 *      quick action both route through api.depositInvestorCapital.
 */
import fs from 'fs';
import path from 'path';
import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2InvestorLedgerService } from '../src/accountingV2/investorLedgerService';
import { collapseLedgerRows } from '../src/utils/ledgerDisplay';

const root = path.join(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Cash Book capital balance (integration over real V2 journals)', () => {
  async function setup() {
    const node = makeNodeRunner();
    const boot = await initializeV2Book(node.runner, {
      book: { id: 'partner-book', name: 'Partner Book', style: 'retail_partnership' },
      period: { id: 'p1', startDate: '2026-07-01', endDate: '2026-07-31' },
      members: [{ name: 'Amit', openingContribution: 1000, profitSharePct: 100 }],
    });
    return { ...node, boot, service: new V2AppService(node.runner), ledger: new V2InvestorLedgerService(node.runner) };
  }

  it('one deposit produces exactly one Cash Book row, counted once in totals', async () => {
    const { runner, close, ledger, service } = await setup();
    try {
      const memberId = 'partner-book:member:1';
      const { source } = await ledger.deposit({ bookId: 'partner-book', memberId, date: '2026-07-10', amount: 1250, notes: 'Additional' });

      const v2Entries = (await service.listCashMovements()).map((entry: any) => ({ ...entry, origin: 'v2', editable: false }));
      expect(v2Entries).toHaveLength(1);
      expect(v2Entries[0].notes).toBe('Capital deposit — Amit'); // journal memo copy
      expect(v2Entries[0].sourceNotes).toBe('Additional'); // user note surfaced as detail
      expect(v2Entries[0].sourceId).toBe(source.id);

      const { totals } = collapseLedgerRows(v2Entries);
      expect(totals.ins).toBe(1250); // NOT 2500
      expect(runner).toBeDefined();
    } finally { close(); }
  });

  it('journal-derived capital balance equals opening + injections (the figure the Parties tile must show)', async () => {
    const { close, ledger } = await setup();
    try {
      await ledger.deposit({ bookId: 'partner-book', memberId: 'partner-book:member:1', date: '2026-07-10', amount: 1250, notes: 'Additional' });
      const detail = await ledger.detail('partner-book', 'partner-book:member:1');
      expect(detail.currentCapitalBalance).toBe(2250); // 1000 opening + 1250 injected
      expect(detail.totalInjected).toBe(1250);
    } finally { close(); }
  });
});

describe('Source contracts — tile balance and entry points', () => {
  const apiSource = read('src/api.ts');
  const partiesSource = read('app/(tabs)/suppliers.tsx');
  const cashbookSource = read('app/cashbook.tsx');
  const investorSource = read('app/investor/[id].tsx');

  it('api.listInvestors derives currentCapital from the merged ledger detail, not the static member snapshot', () => {
    const listInvestors = apiSource.slice(apiSource.indexOf('listInvestors:'), apiSource.indexOf('listSalesAndInvoices:'));
    expect(listInvestors).toContain('mergedInvestorLedgerDetail');
    expect(listInvestors).toContain('currentCapitalBalance');
    // The stale mapping the Parties tile bug came from must be gone.
    expect(listInvestors).not.toMatch(/currentCapital:\s*Number\(row\.current_capital\)/);
    // The detail screen reads the SAME computation.
    expect(apiSource).toMatch(/getInvestorLedger:[\s\S]*?return mergedInvestorLedgerDetail\(id\)/);
  });

  it('Capital Accounts tile renders the computed balance (investor.currentCapital), never opening_contribution', () => {
    expect(partiesSource).toContain('Number(investor.currentCapital || 0)');
    expect(partiesSource).not.toContain('openingCapital');
    expect(partiesSource).toContain('Capital {fmt(item.capitalBalance || 0)}');
  });

  it('api.listCashEntries keeps the native path journal-derived while allowing an explicit web fallback', () => {
    const listCashEntries = apiSource.slice(apiSource.indexOf('listCashEntries:'), apiSource.indexOf('createCashEntry:'));
    const nativePath = listCashEntries.slice(listCashEntries.indexOf('const runner = activeSqlRunner();'));
    expect(nativePath).toContain('return v2Entries');
    expect(nativePath).not.toContain('db.listCashEntries');
    expect(nativePath).not.toContain('dedupeLegacyMirrors');
  });

  it('capital deposits do not create a legacy settings or cash-entry mirror', () => {
    const deposit = apiSource.slice(apiSource.indexOf('depositInvestorCapital:'), apiSource.indexOf('updateInvestorCapital:'));
    expect(deposit).not.toContain('db.createCashEntry');
    expect(deposit).not.toContain('v2SourceId');
  });

  it('Cash Book "Add Capital" path posts through api.depositInvestorCapital, not a plain cash entry', () => {
    expect(cashbookSource).toContain('Add Capital');
    expect(cashbookSource).toContain('api.depositInvestorCapital(investorId, payload)');
    expect(cashbookSource).toContain('api.listInvestors()');
    expect(cashbookSource).toContain('No capital accounts yet — add one in Accounts first.');
  });

  it('Accounts "Add Capital" quick action opens the existing capital flow', () => {
    expect(partiesSource).toContain("params: { id: item.id, action: 'deposit' }");
    expect(investorSource).toMatch(/requestedAction === 'deposit'[\s\S]*?setAction\(requestedAction\)/);
  });

  it('capital deposit rows read "Capital deposit — <name>" with the user note appended as detail', () => {
    // Posting memo (shared by every entry point).
    expect(read('src/accountingV2/investorLedgerService.ts')).toContain('memo: `Capital deposit — ${member.name}`');
    // Cash Book copy appends the user note to the memo instead of replacing it.
    expect(apiSource).toMatch(/sourceType === 'capital_injection' && entry\.sourceNotes[\s\S]*?\$\{entry\.notes\} — \$\{entry\.sourceNotes\}/);
  });
});
