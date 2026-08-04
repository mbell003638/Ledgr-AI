/**
 * Investor-capital UX contracts:
 *  (a) the Parties tile shows the SAME journal-computed capital balance as the
 *      investor detail screen (not the static period-opening snapshot);
 *  (b) the Cash Book merge lists a dual-written capital deposit exactly ONCE
 *      (linkage dedupe + conservative fallback) and totals count it once;
 *  (c) the Cash In "Investor capital" entry point and the Parties "+ Capital"
 *      quick action both route through api.depositInvestorCapital.
 */
import fs from 'fs';
import path from 'path';
import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { V2InvestorLedgerService } from '../src/accountingV2/investorLedgerService';
import { collapseLedgerRows, dedupeLegacyMirrors, type LedgerRow } from '../src/utils/ledgerDisplay';

const root = path.join(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const v2Row = (over: Partial<LedgerRow>): LedgerRow => ({
  id: 'j1', amount: 1250, direction: 'in', date: '2026-07-10', notes: 'Capital deposit — Amit',
  origin: 'v2', sourceId: 'capital_injection_x', sourceType: 'capital_injection', ...over,
});
const legacyRow = (over: Partial<LedgerRow>): LedgerRow => ({
  id: 'legacy-1', amount: 1250, direction: 'in', date: '2026-07-10', notes: 'Additional',
  origin: 'manual', type: 'capital_injection', ...over,
});

describe('Cash Book legacy-mirror dedupe (unit)', () => {
  it('drops a legacy mirror whose own id is the V2 source id (investor-capital dual write)', () => {
    const rows = [legacyRow({ id: 'capital_injection_x' }), v2Row({})];
    const deduped = dedupeLegacyMirrors(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].origin).toBe('v2');
  });

  it('drops a legacy mirror linked via explicit v2SourceId', () => {
    const rows = [legacyRow({ id: 'some-uuid', v2SourceId: 'capital_injection_x' }), v2Row({})];
    expect(dedupeLegacyMirrors(rows).map((r) => r.id)).toEqual(['j1']);
  });

  it('drops a legacy receipt bridge row linked via receiptId', () => {
    const rows = [
      legacyRow({ id: 'bridge-uuid', type: '', receiptId: 'receipt_src_1', notes: 'Receipt R-1' }),
      v2Row({ id: 'j2', sourceId: 'receipt_src_1', sourceType: 'receipt', notes: 'Receipt' }),
    ];
    expect(dedupeLegacyMirrors(rows).map((r) => r.id)).toEqual(['j2']);
  });

  it('conservative fallback: an unlinked investor-capital legacy row matching a V2 capital movement on date+amount+direction is treated as the same movement — consumed one-for-one', () => {
    // Pre-fix mirror (no linkage at all): dropped via fallback.
    const rows = [legacyRow({ id: 'old-mirror-uuid' }), v2Row({})];
    expect(dedupeLegacyMirrors(rows).map((r) => r.id)).toEqual(['j1']);

    // Two identical legacy capital rows but only ONE V2 twin: exactly one is
    // absorbed; a genuine second same-day, same-amount deposit survives.
    const twoLegacy = [legacyRow({ id: 'a' }), legacyRow({ id: 'b' }), v2Row({})];
    expect(dedupeLegacyMirrors(twoLegacy)).toHaveLength(2);
  });

  it('keeps legacy-only capital rows (no matching V2 movement) and general manual entries', () => {
    const rows = [
      legacyRow({ id: 'pre-v2-deposit', amount: 500, date: '2026-06-01' }),
      legacyRow({ id: 'petty', type: '', amount: 20, notes: 'Petty cash' }),
      v2Row({}),
    ];
    expect(dedupeLegacyMirrors(rows)).toHaveLength(3);
  });

  it('is a no-op when no V2 rows are present (legacy-only books)', () => {
    const rows = [legacyRow({ id: 'x' }), legacyRow({ id: 'y', type: '' })];
    expect(dedupeLegacyMirrors(rows)).toEqual(rows);
  });

  it('totals computed AFTER dedupe count a dual-written deposit once', () => {
    const deduped = dedupeLegacyMirrors([legacyRow({ id: 'capital_injection_x' }), v2Row({})]);
    const { totals } = collapseLedgerRows(deduped);
    expect(totals.ins).toBe(1250);
    expect(totals.net).toBe(1250);
  });
});

describe('Cash Book dedupe + capital balance (integration over real V2 journals)', () => {
  async function setup() {
    const node = makeNodeRunner();
    const boot = await initializeV2Book(node.runner, {
      book: { id: 'partner-book', name: 'Partner Book', style: 'retail_partnership' },
      period: { id: 'p1', startDate: '2026-07-01', endDate: '2026-07-31' },
      members: [{ name: 'Amit', openingContribution: 1000, profitSharePct: 100 }],
    });
    return { ...node, boot, service: new V2AppService(node.runner), ledger: new V2InvestorLedgerService(node.runner) };
  }

  it('one deposit produces exactly one merged Cash Book row, counted once in totals', async () => {
    const { runner, close, ledger, service } = await setup();
    try {
      const memberId = 'partner-book:member:1';
      const { source } = await ledger.deposit({ bookId: 'partner-book', memberId, date: '2026-07-10', amount: 1250, notes: 'Additional' });

      const v2Entries = (await service.listCashMovements()).map((entry: any) => ({ ...entry, origin: 'v2', editable: false }));
      expect(v2Entries).toHaveLength(1);
      expect(v2Entries[0].notes).toBe('Capital deposit — Amit'); // journal memo copy
      expect(v2Entries[0].sourceNotes).toBe('Additional'); // user note surfaced as detail
      expect(v2Entries[0].sourceId).toBe(source.id);

      // The legacy mirror exactly as api.depositInvestorCapital dual-writes it.
      const mirror: LedgerRow = {
        id: source.id, v2SourceId: source.id, amount: 1250, direction: 'in', date: '2026-07-10',
        notes: 'Additional', type: 'capital_injection', origin: 'manual',
      };
      const merged = dedupeLegacyMirrors([mirror, ...v2Entries]);
      expect(merged).toHaveLength(1);
      expect(merged[0].origin).toBe('v2');

      const { totals } = collapseLedgerRows(merged);
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

describe('Source contracts — tile balance, dedupe placement, entry points', () => {
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

  it('Parties tile renders the computed balance (investor.currentCapital), never opening_contribution', () => {
    expect(partiesSource).toContain('Number(investor.currentCapital || 0)');
    expect(partiesSource).not.toContain('openingCapital');
    expect(partiesSource).toContain('Capital {fmt(item.capitalBalance || 0)}');
  });

  it('api.listCashEntries dedupes legacy mirrors before returning rows (totals collapse runs on the deduped list)', () => {
    const listCashEntries = apiSource.slice(apiSource.indexOf('listCashEntries:'), apiSource.indexOf('createCashEntry:'));
    expect(listCashEntries).toContain('dedupeLegacyMirrors');
    // Merge keying happens on the deduped list.
    expect(listCashEntries.indexOf('dedupeLegacyMirrors')).toBeLessThan(listCashEntries.indexOf('new Map'));
  });

  it('the deposit dual-write stamps the legacy mirror with the V2 source id linkage', () => {
    expect(apiSource).toMatch(/createCashEntry\(\{ id: result\.source\.id, v2SourceId: result\.source\.id/);
  });

  it('Cash Book "Investor capital" path posts through api.depositInvestorCapital, not a plain cash entry', () => {
    expect(cashbookSource).toContain('Investor capital');
    expect(cashbookSource).toContain('api.depositInvestorCapital(investorId, payload)');
    expect(cashbookSource).toContain('api.listInvestors()');
    expect(cashbookSource).toContain('No investors yet — add one in Parties first.');
  });

  it('Parties "+ Capital" quick action opens the existing deposit flow on the investor detail screen', () => {
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
