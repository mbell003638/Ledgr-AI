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

async function setup(periodStart = '2026-01-01', periodEnd = '2026-12-31') {
  const node = makeNodeRunner();
  await initializeV2Book(node.runner, {
    book: { id: BOOK, name: 'Opening Balance Shop' },
    period: { id: `${BOOK}:period:${periodStart}`, startDate: periodStart, endDate: periodEnd },
  });
  return { ...node, service: new V2AppService(node.runner) };
}

const liveOpenings = async (runner: any) =>
  runner.all("SELECT id,metadata FROM v2_sources WHERE book_id=? AND type='opening_balance' AND json_extract(metadata,'$.reversed') IS NULL AND json_extract(metadata,'$.deleted') IS NOT 1", [BOOK]);
const reversalCount = async (runner: any) =>
  Number((await runner.first('SELECT COUNT(*) AS n FROM v2_journal_entries WHERE reversal_of IS NOT NULL'))?.n);

describe('V2 opening balances — self-correcting engine', () => {
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
});
