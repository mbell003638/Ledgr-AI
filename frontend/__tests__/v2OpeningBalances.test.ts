/**
 * Opening balances must be self-correcting — a shopkeeper can never be told to
 * "reverse them before changing the amounts" (there is no such button).
 *
 * Field repro this suite guards: opening set during onboarding ($100, Aug 3),
 * then changed on the Cash Book screen (amount 0, date 2026-08-01) → previously
 * a dead-end error. Covered states:
 *  - same period-start, changed amounts   → delta via reversal trail (unchanged)
 *  - DIFFERENT period-start date          → internal reverse + repost, one atomic op
 *  - identical values                     → graceful no-op
 *  - zeroed out, then set again           → succeeds (old guard dead-ended here)
 *  - date in a CLOSED period              → clear, actionable rejection naming it
 *  - factory reset → fresh post           → succeeds with NO adjustment/reversal rows
 */
import { makeNodeRunner } from './helpers/nodeRunner';
import { initializeV2Book } from '../src/accountingV2/appBootstrap';
import { V2AppService } from '../src/accountingV2/appService';
import { resetV2AccountingData } from '../src/accountingV2/resetBook';

const BOOK = 'ob-book';

async function setup(
  periodStart = '2026-01-01',
  periodEnd = '2026-12-31',
  members: { name: string; openingContribution: number; profitSharePct: number }[] = [],
  style: 'standard' | 'retail_partnership' = 'standard',
) {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: BOOK, name: 'Opening Balance Shop', style },
    period: { id: `${BOOK}:period:${periodStart}`, startDate: periodStart, endDate: periodEnd },
    members,
  });
  return { ...node, service: new V2AppService(node.runner) };
}

const liveOpenings = async (runner: any) =>
  runner.all("SELECT id,metadata FROM v2_sources WHERE book_id=? AND type='opening_balance' AND json_extract(metadata,'$.reversed') IS NULL AND json_extract(metadata,'$.deleted') IS NOT 1", [BOOK]);
const reversalCount = async (runner: any) =>
  Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n);

describe('V2 opening balances — self-correcting engine', () => {
  it('imports the photographed closing report as one journal without inventing asset, liability, or capital-deposit sources', async () => {
    const { runner, close, service } = await setup('2026-01-01', '2026-12-31', [], 'retail_partnership');
    try {
      await expect(service.importClosingBalances({
        date: '2026-08-10',
        cash: 38689.21,
        inventory: 150527.46,
        otherAssets: 8250,
        assetBreakdown: [
          { name: 'Shop Deposit', amount: 7500 },
          { name: 'House Deposit', amount: 750 },
        ],
        accountsPayable: 36215.42,
        otherLiabilities: 6063.15,
        liabilityBreakdown: [
          { name: 'Creditors', amount: 36215.42, type: 'creditor' },
          { name: 'Commission Payable', amount: 6063.15, type: 'other' },
        ],
        ownerCapital: 155188.1,
        createMissingPartners: true,
        partnerCapitals: [
          { name: 'Amit', amount: 68935.48, profitSharePct: 50 },
          { name: 'Rahim', amount: 86252.62, profitSharePct: 50 },
        ],
        memo: '[Scan] Closing report import',
      })).resolves.toMatchObject({
        alreadyPosted: false,
        partnerCapitals: [
          { memberId: `${BOOK}:member:amit`, name: 'Amit', amount: 68935.48, profitSharePct: 50 },
          { memberId: `${BOOK}:member:rahim`, name: 'Rahim', amount: 86252.62, profitSharePct: 50 },
        ],
      });

      expect(await runner.all('SELECT type FROM v2_sources WHERE book_id=? ORDER BY type', [BOOK])).toEqual([
        { type: 'opening_balance' },
      ]);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(1);
      expect(Number((await runner.first("SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=? AND type IN ('capital_injection','manual_asset','manual_liability')", [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_parties WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_parties WHERE book_id=?', [BOOK]))?.n)).toBe(0);

      const balances = await runner.all<{ code: string; balance: number }>(`
        SELECT a.code,ROUND(SUM(l.debit-l.credit),2) AS balance
        FROM v2_accounts a
        JOIN v2_journal_lines l ON l.account_id=a.id
        JOIN v2_journal_entries j ON j.id=l.journal_id
        WHERE a.book_id=?
        GROUP BY a.code
        ORDER BY a.code
      `, [BOOK]);
      expect(balances).toEqual([
        { code: '1000', balance: 38689.21 },
        { code: '1200', balance: 150527.46 },
        { code: '1500', balance: 8250 },
        { code: '2000', balance: -36215.42 },
        { code: '2500', balance: -6063.15 },
        { code: '3000', balance: -155188.1 },
      ]);
      expect(await runner.all('SELECT name,opening_contribution,current_capital,profit_share_pct FROM v2_members WHERE book_id=? ORDER BY id', [BOOK])).toEqual([
        { name: 'Amit', opening_contribution: 68935.48, current_capital: 68935.48, profit_share_pct: 50 },
        { name: 'Rahim', opening_contribution: 86252.62, current_capital: 86252.62, profit_share_pct: 50 },
      ]);
      const source = await runner.first<{ metadata: string }>("SELECT metadata FROM v2_sources WHERE book_id=? AND type='opening_balance'", [BOOK]);
      expect(JSON.parse(source?.metadata || '{}')).toMatchObject({
        closingBalanceImport: true,
        cash: 38689.21,
        inventory: 150527.46,
        otherAssets: 8250,
        accountsPayable: 36215.42,
        otherLiabilities: 6063.15,
        ownerCapital: 155188.1,
        partnerCapitals: [
          { memberId: `${BOOK}:member:amit`, name: 'Amit', amount: 68935.48, profitSharePct: 50 },
          { memberId: `${BOOK}:member:rahim`, name: 'Rahim', amount: 86252.62, profitSharePct: 50 },
        ],
      });
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('rolls back the complete closing-report import when partner stakes do not match equity', async () => {
    const { runner, close, service } = await setup('2026-01-01', '2026-12-31', [
      { name: 'Amit', openingContribution: 0, profitSharePct: 50 },
      { name: 'Rahim', openingContribution: 0, profitSharePct: 50 },
    ], 'retail_partnership');
    try {
      await expect(service.importClosingBalances({
        date: '2026-08-10',
        cash: 100,
        inventory: 0,
        ownerCapital: 100,
        partnerCapitals: [
          { name: 'Amit', amount: 50 },
          { name: 'Rahim', amount: 49.99 },
        ],
      })).rejects.toThrow('Partner stakes (99.99) must equal owner capital (100.00)');

      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(await runner.all('SELECT name,current_capital FROM v2_members WHERE book_id=? ORDER BY id', [BOOK])).toEqual([
        { name: 'Amit', current_capital: 0 },
        { name: 'Rahim', current_capital: 0 },
      ]);
    } finally { close(); }
  });

  it.each([
    [
      'a new partner is missing an explicit share',
      [{ name: 'Amit', amount: 50, profitSharePct: 50 }, { name: 'Rahim', amount: 50 }],
      /valid profit share is required to create partner 'Rahim'/,
    ],
    [
      'new partner shares do not total 100%',
      [{ name: 'Amit', amount: 50, profitSharePct: 60 }, { name: 'Rahim', amount: 50, profitSharePct: 50 }],
      /partner profit shares must total 100%/i,
    ],
  ])('creates no member or journal when %s', async (_label, partnerCapitals, error) => {
    const { runner, close, service } = await setup('2026-01-01', '2026-12-31', [], 'retail_partnership');
    try {
      await expect(service.importClosingBalances({
        date: '2026-08-10', cash: 100, inventory: 0, ownerCapital: 100,
        createMissingPartners: true,
        partnerCapitals,
      })).rejects.toThrow(error as RegExp);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_members WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(0);
    } finally { close(); }
  });

  it('rejects partner-stake imports outside Partnership Mode without writing anything', async () => {
    const { runner, close, service } = await setup();
    try {
      await expect(service.importClosingBalances({
        date: '2026-08-10', cash: 100, inventory: 0, ownerCapital: 100,
        createMissingPartners: true,
        partnerCapitals: [{ name: 'Owner', amount: 100, profitSharePct: 100 }],
      })).rejects.toThrow('Closing reports with partner stakes can only be imported in Partnership Mode');
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_members WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(0);
    } finally { close(); }
  });

  it('atomically imports a standard closing report when it has no partner section', async () => {
    const { runner, close, service } = await setup();
    try {
      await expect(service.importClosingBalances({
        date: '2026-08-10',
        cash: 100,
        inventory: 50,
        otherAssets: 20,
        assetBreakdown: [{ name: 'Deposit', amount: 20 }],
        accountsPayable: 30,
        liabilityBreakdown: [{ name: 'Creditors', amount: 30, type: 'creditor' }],
        ownerCapital: 140,
        partnerCapitals: [],
      })).resolves.toMatchObject({ alreadyPosted: false, partnerCapitals: [] });
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE book_id=?', [BOOK]))?.n)).toBe(1);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_parties WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('changes the period-start DATE by reversing and reposting atomically (no dead end)', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.postOpeningBalances({ date: '2026-08-03', cash: 100, inventory: 0 });
      // The exact field repro: later change to a different date via the update path.
      const result = await service.updateOpeningBalances({ date: '2026-08-01', cash: 100, inventory: 0 });
      expect(result.alreadyPosted).toBe(false);

      const live = await liveOpenings(runner);
      expect(live).toHaveLength(1);
      expect(JSON.parse(live[0].metadata)).toMatchObject({ cash: 100, inventory: 0, date: '2026-08-01' });
      expect(await reversalCount(runner)).toBe(1); // audit trail keeps the internal reversal
      expect(await service.repo.accountBalance(BOOK, `${BOOK}:account:1000`)).toBe(100);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('the direct post path (modal / advanced settings) also self-corrects instead of throwing the old guard', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.postOpeningBalances({ date: '2026-08-03', cash: 100, inventory: 0 });
      // Previously: "Opening balances are already posted for this period; reverse them..."
      await expect(service.postOpeningBalances({ date: '2026-08-01', cash: 0, inventory: 50 })).resolves.toMatchObject({ alreadyPosted: false });
      const live = await liveOpenings(runner);
      expect(live).toHaveLength(1);
      expect(JSON.parse(live[0].metadata)).toMatchObject({ cash: 0, inventory: 50, date: '2026-08-01' });
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('repeat updates with identical values are graceful no-ops (idempotent)', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.updateOpeningBalances({ date: '2026-02-01', cash: 75, inventory: 45 });
      const before = Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n);
      await expect(service.updateOpeningBalances({ date: '2026-02-01', cash: 75, inventory: 45 })).resolves.toMatchObject({ alreadyPosted: true });
      await expect(service.postOpeningBalances({ date: '2026-02-01', cash: 75, inventory: 45 })).resolves.toMatchObject({ alreadyPosted: true });
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(before);
      expect(await reversalCount(runner)).toBe(0);
    } finally { close(); }
  });

  it('zeroing out the opening and setting it again succeeds (old guard dead-ended on the stale source id)', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.postOpeningBalances({ date: '2026-08-03', cash: 100, inventory: 0 });
      // Amount 0: the live opening is reversed and nothing new is posted.
      await expect(service.updateOpeningBalances({ date: '2026-08-01', cash: 0, inventory: 0 })).resolves.toMatchObject({ journal: null });
      expect(await liveOpenings(runner)).toHaveLength(0);
      // Setting it again used to throw because the canonical source id still existed (reversed).
      await expect(service.updateOpeningBalances({ date: '2026-08-01', cash: 200, inventory: 0 })).resolves.toMatchObject({ alreadyPosted: false });
      await expect(service.postOpeningBalances({ date: '2026-08-01', cash: 300, inventory: 0 })).resolves.toMatchObject({ alreadyPosted: false });
      const live = await liveOpenings(runner);
      expect(live).toHaveLength(1);
      expect(JSON.parse(live[0].metadata)).toMatchObject({ cash: 300 });
      expect(await service.repo.accountBalance(BOOK, `${BOOK}:account:1000`)).toBe(300);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('a date before the open period pulls the period start back (the UI calls this field "Period Start Date")', async () => {
    // Mirrors the factory-reset flow: reset on Aug 3 creates a period starting Aug 3,
    // then the user asks for an Aug 1 opening date on the Cash Book screen.
    const { runner, close, service } = await setup('2026-08-03', '2026-12-31');
    try {
      await service.postOpeningBalances({ date: '2026-08-03', cash: 100, inventory: 0 });
      await expect(service.updateOpeningBalances({ date: '2026-08-01', cash: 0, inventory: 0 })).resolves.toBeTruthy();
      expect(await runner.first('SELECT start_date FROM v2_periods WHERE book_id=?', [BOOK])).toEqual({ start_date: '2026-08-01' });
      await expect(service.updateOpeningBalances({ date: '2026-08-01', cash: 50, inventory: 0 })).resolves.toMatchObject({ alreadyPosted: false });
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('rejects a date inside a CLOSED period with an actionable message naming the period — never "reverse them"', async () => {
    const { runner, close, service } = await setup('2026-02-01', '2026-12-31');
    try {
      await runner.run('INSERT INTO v2_periods(id,book_id,start_date,end_date,status,close_snapshot) VALUES(?,?,?,?,?,NULL)', [`${BOOK}:period:2026-01-01`, BOOK, '2026-01-01', '2026-01-31', 'closed']);
      await service.postOpeningBalances({ date: '2026-02-01', cash: 100, inventory: 0 });
      const failure = await service.updateOpeningBalances({ date: '2026-01-15', cash: 100, inventory: 0 }).then(() => null, (e: any) => e);
      expect(String(failure?.message)).toMatch(/closed period 2026-01-01 to 2026-01-31.*on or after 2026-02-01/);
      expect(String(failure?.message)).not.toMatch(/reverse them/i);
      // The rejection left the books untouched (atomic — no half-applied reversal).
      const live = await liveOpenings(runner);
      expect(live).toHaveLength(1);
      expect(JSON.parse(live[0].metadata)).toMatchObject({ cash: 100, date: '2026-02-01' });
      expect(await reversalCount(runner)).toBe(0);
    } finally { close(); }
  });

  it('after a factory reset, a fresh opening post succeeds with NO adjustment or reversal rows', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.postOpeningBalances({ date: '2026-03-01', cash: 100, inventory: 20 });
      await service.updateOpeningBalances({ date: '2026-03-05', cash: 40, inventory: 10 });
      expect(await reversalCount(runner)).toBeGreaterThan(0);

      await resetV2AccountingData(runner, BOOK, '2026-08-03');

      // Prior posted state is truly gone…
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_sources'))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(0);
      // …and a fresh post is a plain initial post: one source, one journal, zero reversals.
      await expect(service.postOpeningBalances({ date: '2026-08-03', cash: 100, inventory: 0 })).resolves.toMatchObject({ alreadyPosted: false });
      expect(Number((await runner.first("SELECT COUNT(*) AS n FROM v2_sources WHERE type='opening_balance'"))?.n)).toBe(1);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries'))?.n)).toBe(1);
      expect(await reversalCount(runner)).toBe(0);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });
  it('links each opening supplier payable to a real supplier so later payments settle the due', async () => {
    const { runner, close, service } = await setup();
    try {
      await service.postOpeningBalances({
        date: '2026-01-01',
        cash: 100,
        inventory: 0,
        accountsPayable: 40,
        ownerCapital: 60,
        liabilityBreakdown: [{ name: 'Opening Supplier', amount: 40, type: 'creditor' }],
      });
      const payable = await runner.first<{ party_id: string; credit: number }>(
        "SELECT l.party_id,l.credit FROM v2_journal_lines l JOIN v2_accounts a ON a.id=l.account_id WHERE a.code='2000' AND l.credit>0",
      );
      expect(payable).toMatchObject({ credit: 40 });
      expect(await runner.first('SELECT name,roles FROM v2_parties WHERE id=?', [payable?.party_id])).toEqual({
        name: 'Opening Supplier',
        roles: '["supplier"]',
      });
      await service.createPayment({ date: '2026-01-10', amount: 15, supplierId: payable?.party_id, supplierName: 'Opening Supplier', type: 'supplier_payment', method: 'cash' });
      expect((await service.getPartyDetail(String(payable?.party_id), 'supplier'))?.balance).toBe(25);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

  it('creates support only for a typed named creditor and never creates a party for generic Creditors', async () => {
    const { runner, close, service } = await setup();
    try {
      const input = {
        date: '2026-01-01', cash: 100, inventory: 0,
        accountsPayable: 40, ownerCapital: 60,
        partnerCapitals: [],
        liabilityBreakdown: [
          { name: 'Creditors', amount: 25, type: 'creditor' as const },
          { name: 'Named Supplier', amount: 15, type: 'creditor' as const },
        ],
      };
      await expect(service.importClosingBalances(input)).rejects.toThrow('Supplier ledger creation requires confirmation for: Named Supplier');
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_parties WHERE book_id=?', [BOOK]))?.n)).toBe(0);
      expect(Number((await runner.first('SELECT COUNT(*) AS n FROM v2_sources WHERE book_id=?', [BOOK]))?.n)).toBe(0);

      await service.importClosingBalances({ ...input, createMissingCreditors: true });

      expect(await runner.all('SELECT name,roles FROM v2_parties WHERE book_id=? ORDER BY name', [BOOK])).toEqual([
        { name: 'Named Supplier', roles: '["supplier"]' },
      ]);
      const payableLines = await runner.all<{ party_id: string | null; credit: number; memo: string }>(`
        SELECT l.party_id,l.credit,l.memo
        FROM v2_journal_lines l
        JOIN v2_accounts a ON a.id=l.account_id
        WHERE a.book_id=? AND a.code='2000'
        ORDER BY l.credit DESC
      `, [BOOK]);
      expect(payableLines).toEqual([
        { party_id: null, credit: 25, memo: 'Creditors' },
        { party_id: expect.any(String), credit: 15, memo: 'Named Supplier' },
      ]);
      expect((await service.repo.reconcileBook(BOOK)).balanced).toBe(true);
    } finally { close(); }
  });

});
