import { round2 } from "../money";

/**
 * Presentation-layer collapsing for journal-derived ledger listings.
 *
 * The V2 engine corrects mistakes non-destructively (reversal + re-post), which
 * is right for the books but noisy on everyday screens: an edited opening
 * balance shows as "+100 / −100" pairs, an edited sale shows three rows, and
 * In/Out totals count internal adjustment pairs. This module folds that
 * mechanical noise into what the user actually did — WITHOUT touching the
 * posting engine. It is pure and unit-testable.
 *
 * Data shapes (see accountingV2/repository.ts + documentService.ts):
 * - v2_journal_entries: id, source_id, date, memo, posted_at, reversal_of
 * - reversal journals carry reversal_of = original journal id and a source of
 *   type `${originalType}_reversal`
 * - the reversed original source's metadata gains reversed=1 (+ deleted=1 for
 *   true deletes, deleted=0 for edits) and reversalSourceId
 */

export type LedgerRow = {
  id: string; // journal entry id (or manual cash-entry id)
  amount: number;
  direction: "in" | "out";
  date: string;
  notes?: string | null;
  origin?: "manual" | "v2";
  editable?: boolean;
  /** V2 linkage (optional — manual/legacy rows won't have these) */
  sourceId?: string | null;
  sourceType?: string | null; // e.g. 'cash_sale', 'opening_balance', 'receipt_reversal'
  reversalOf?: string | null; // journal id this journal reverses
  postedAt?: string | null; // journal created_at (posted_at ISO timestamp)
  sourceReversed?: boolean; // the row's source has been reversed
  sourceDeleted?: boolean; // the row's source was deleted (reversed, no re-post)
  /** Legacy-mirror linkage (optional — only legacy rows dual-written next to a
   *  V2 journal carry these; see dedupeLegacyMirrors). */
  type?: string | null; // legacy cash-entry kind, e.g. 'capital_injection'
  receiptId?: string | null; // legacy receipt bridge rows: the receipt (V2 source) id
  v2SourceId?: string | null; // explicit mirror linkage written by api dual-writes
};

/**
 * Drop legacy (manual-collection) rows that MIRROR a V2-journaled movement.
 *
 * Why mirrors exist: when V2 is active, api dual-writes keep the legacy
 * collections in sync (backup/export continuity). The legacy mirror row gets
 * the V2 SOURCE id as linkage, but the journal-derived V2 row in this list is
 * keyed by its JOURNAL id — so a plain id-keyed merge keeps both twins and the
 * Cash Book shows (and totals) the same movement twice.
 *
 * Linkage dedupe (preferred): a legacy row is a mirror when any of its linkage
 * keys — its own id (investor-capital mirrors are created WITH the V2 source
 * id), its explicit `v2SourceId`, or its `receiptId` (legacy receipt bridge
 * rows) — matches the `sourceId` of a V2 row in the same list.
 *
 * Conservative fallback (rows written before linkage existed): an
 * investor-capital legacy row (`type` capital_injection/drawing) matching a V2
 * capital movement on date + amount + direction is treated as the same
 * movement. Matches are consumed one-for-one so a genuine second same-day,
 * same-amount deposit is never swallowed.
 *
 * Other dual-written movements (cash sales, expenses, supplier payments…)
 * don't need this: their legacy mirrors live in `sales`/`payments`/… — not in
 * `cashEntries` — so they never reach the Cash Book merge in the first place.
 * The only legacy writes that land in `cashEntries` are receipt bridge rows
 * (linked via `receiptId`) and investor-capital mirrors (linked via id /
 * `v2SourceId`), both covered above.
 */
export function dedupeLegacyMirrors(rows: LedgerRow[]): LedgerRow[] {
  const v2SourceIds = new Set(
    rows.filter((row) => row.origin === "v2" && row.sourceId).map((row) => String(row.sourceId)),
  );
  if (!v2SourceIds.size) return rows;
  const capitalKey = (row: LedgerRow) => `${row.date}|${round2(Number(row.amount) || 0)}|${row.direction}`;
  const fallbackPool = new Map<string, number>();
  for (const row of rows) {
    if (row.origin !== "v2") continue;
    if (row.sourceType !== "capital_injection" && row.sourceType !== "drawing") continue;
    const key = capitalKey(row);
    fallbackPool.set(key, (fallbackPool.get(key) || 0) + 1);
  }
  return rows.filter((row) => {
    if (row.origin === "v2") return true;
    const links = [row.id, row.v2SourceId, row.receiptId].filter(Boolean).map(String);
    if (links.some((link) => v2SourceIds.has(link))) return false;
    if (row.type === "capital_injection" || row.type === "drawing") {
      const key = capitalKey(row);
      const available = fallbackPool.get(key) || 0;
      if (available > 0) { fallbackPool.set(key, available - 1); return false; }
    }
    return true;
  });
}

export type DisplayLedgerRow = LedgerRow & {
  edited?: boolean;
  editedAt?: string | null; // latest correction timestamp (posted_at of newest underlying journal)
  /** For synthetic collapsed rows: how many correction journals were folded in. */
  adjustmentCount?: number;
  synthetic?: boolean;
};

export type CollapsedLedger = {
  rows: DisplayLedgerRow[];
  /** Escape hatch: how many raw ledger rows the collapsed view represents. */
  rawCount: number;
  hiddenCount: number;
  /** Totals computed from the COLLAPSED view (internal pairs excluded).
   *  `opening` is the signed net of the opening-balance family; `ins`/`outs`
   *  cover the remaining visible rows; net = opening + ins − outs. */
  totals: { ins: number; outs: number; net: number; opening: number };
};

const signed = (row: LedgerRow) => (row.direction === "in" ? 1 : -1) * (Number(row.amount) || 0);

const isOpeningFamily = (row: LedgerRow) => {
  const type = row.sourceType || "";
  if (type === "opening_balance" || type === "opening_balance_reversal") return true;
  if (row.origin === "manual") return false;
  if (type) return false;
  return /^(update )?opening balances\b/i.test(String(row.notes || ""));
};

const latestStamp = (rows: LedgerRow[]): string | null => {
  let best: string | null = null;
  for (const row of rows) {
    const stamp = row.postedAt || row.date || null;
    if (stamp && (!best || stamp > best)) best = stamp;
  }
  return best;
};

/**
 * Collapse raw journal-derived rows into what the user should see:
 * (a) reversed journal + its reversal are hidden when they fully cancel;
 * (b) the re-posted live version of an edited source is flagged `edited`;
 * (c) the opening-balance family folds into ONE synthetic row at its net value;
 * (d) fully deleted sources (reversed with no re-post) disappear.
 * Row order of the input is preserved for everything that stays visible.
 */
export function collapseLedgerRows(rows: LedgerRow[]): CollapsedLedger {
  const opening = rows.filter(isOpeningFamily);
  const rest = rows.filter((row) => !isOpeningFamily(row));

  // Group non-opening V2 rows by journal id (a journal can emit several cash lines).
  const byJournal = new Map<string, LedgerRow[]>();
  for (const row of rest) {
    if (row.origin === "manual" || !row.id) continue;
    const list = byJournal.get(row.id) || [];
    list.push(row);
    byJournal.set(row.id, list);
  }
  const journalNet = (journalId: string) => (byJournal.get(journalId) || []).reduce((sum, row) => sum + signed(row), 0);

  // Pair each reversal journal with the journal it reverses; hide both when they fully cancel.
  const hiddenJournals = new Set<string>();
  type Pair = { originalType: string | null; correctionStamp: string | null; deleted: boolean };
  const editPairs: Pair[] = [];
  for (const [journalId, journalRows] of byJournal) {
    const reversalOf = journalRows[0]?.reversalOf;
    if (!reversalOf || !byJournal.has(reversalOf) || hiddenJournals.has(journalId)) continue;
    if (round2(journalNet(journalId) + journalNet(reversalOf)) !== 0) continue; // only hide when they fully cancel
    hiddenJournals.add(journalId);
    hiddenJournals.add(reversalOf);
    const originals = byJournal.get(reversalOf) || [];
    editPairs.push({
      originalType: originals[0]?.sourceType || null,
      correctionStamp: latestStamp(journalRows),
      deleted: originals.some((row) => row.sourceDeleted),
    });
  }

  // For edits (reversed but NOT deleted), flag the live re-posted journal of the
  // same source type that landed at/after the correction as "edited".
  const editedByJournal = new Map<string, string | null>();
  for (const pair of editPairs) {
    if (pair.deleted || !pair.originalType) continue;
    let candidate: { id: string; stamp: string | null } | null = null;
    for (const [journalId, journalRows] of byJournal) {
      if (hiddenJournals.has(journalId)) continue;
      const row = journalRows[0];
      if (row.reversalOf || row.sourceReversed || row.sourceDeleted) continue;
      if ((row.sourceType || null) !== pair.originalType) continue;
      const stamp = latestStamp(journalRows);
      if (pair.correctionStamp && stamp && stamp < pair.correctionStamp) continue; // re-post never precedes its reversal
      if (!candidate || (stamp || "") < (candidate.stamp || "")) candidate = { id: journalId, stamp };
    }
    if (candidate) {
      const stamp = candidate.stamp || pair.correctionStamp || null;
      const prior = editedByJournal.get(candidate.id);
      if (!prior || (stamp && stamp > prior)) editedByJournal.set(candidate.id, stamp);
    }
  }

  // Opening-balance family → ONE synthetic row at the current net value.
  let openingRow: DisplayLedgerRow | null = null;
  let openingNet = 0;
  if (opening.length) {
    openingNet = round2(opening.reduce((sum, row) => sum + signed(row), 0));
    const live = opening.find((row) => !row.reversalOf && !row.sourceReversed && !row.sourceDeleted);
    const reference = live || opening[0];
    openingRow = {
      id: `opening-balances:${reference.id}`,
      amount: Math.abs(openingNet),
      direction: openingNet < 0 ? "out" : "in",
      date: reference.date,
      notes: "Opening balances",
      origin: "v2",
      editable: false,
      sourceId: reference.sourceId,
      sourceType: "opening_balance",
      synthetic: true,
      edited: opening.length > 1,
      editedAt: opening.length > 1 ? latestStamp(opening) : null,
      adjustmentCount: Math.max(0, opening.length - 1),
    };
  }

  // Rebuild the list preserving input order; the synthetic opening row takes
  // the place of the first opening-family row encountered.
  const out: DisplayLedgerRow[] = [];
  let openingEmitted = false;
  for (const row of rows) {
    if (isOpeningFamily(row)) {
      if (!openingEmitted && openingRow) { out.push(openingRow); openingEmitted = true; }
      continue;
    }
    if (row.origin !== "manual" && hiddenJournals.has(row.id)) continue;
    const editedAt = editedByJournal.has(row.id) ? editedByJournal.get(row.id) : undefined;
    out.push(editedAt !== undefined ? { ...row, edited: true, editedAt: editedAt || null } : row);
  }

  let ins = 0;
  let outs = 0;
  for (const row of out) {
    if (row.synthetic) continue; // opening net is reported separately
    if (row.direction === "in") ins += Number(row.amount) || 0;
    else outs += Number(row.amount) || 0;
  }
  ins = round2(ins);
  outs = round2(outs);
  return {
    rows: out,
    rawCount: rows.length,
    hiddenCount: rows.length - out.length,
    totals: { ins, outs, opening: openingNet, net: round2(openingNet + ins - outs) },
  };
}

/** Navigation target for a posted row so taps are never a dead end. */
export type SourceNavigation = {
  label: string; // human name of the source document, e.g. "Sale"
  pathname: string;
  params?: Record<string, string>;
};

const NAV_MAP: Record<string, { label: string; form?: string; list: string }> = {
  cash_sale: { label: "Sale", form: "/sale-form", list: "/sales" },
  invoice: { label: "Invoice", list: "/invoices" },
  receipt: { label: "Receipt", form: "/receipt-form", list: "/receipts" },
  supplier_payment: { label: "Payment", form: "/payment-form", list: "/payments" },
  drawing: { label: "Drawing", form: "/payment-form", list: "/payments" },
  cash_purchase: { label: "Purchase", form: "/bill-form", list: "/(tabs)/bills" },
  credit_purchase: { label: "Purchase", form: "/bill-form", list: "/(tabs)/bills" },
  expense: { label: "Expense", list: "/expenses" },
  payable_expense: { label: "Expense", list: "/expenses" },
  capital_injection: { label: "Capital injection", list: "/daybook" },
  profit_allocation: { label: "Profit allocation", list: "/daybook" },
};

/**
 * Resolve where a posted (journal-derived) row should take the user.
 * Sources with a param-based edit form route straight there; otherwise we route
 * to the listing screen for that type — still better than a dead-end alert.
 * Opening balances are handled by the caller (inline editor), so they return null.
 */
export function describeSourceNavigation(sourceType?: string | null, sourceId?: string | null): SourceNavigation | null {
  const baseType = String(sourceType || "").replace(/_reversal$/, "");
  if (!baseType || baseType === "opening_balance") return null;
  const entry = NAV_MAP[baseType];
  if (!entry) {
    const label = baseType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    return { label, pathname: "/daybook" };
  }
  if (entry.form && sourceId) return { label: entry.label, pathname: entry.form, params: { id: sourceId } };
  return { label: entry.label, pathname: entry.list };
}

/** Short human stamp for the "edited" tag, e.g. "12 Jan, 3:42 PM". */
export function formatEditedStamp(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  const day = d.toLocaleDateString([], { day: "numeric", month: "short" });
  const hasTime = /T\d{2}:/.test(String(iso));
  if (!hasTime) return day;
  return `${day}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
