# Ledgr AI — Session History (2026-08-03 → 04)

Full record of the audit-and-fix marathon on `mbell003638/Ledgr-AI`, branch **`Fable5-Opus`** (created from `codex-sol`).

---

## Phase 1 — Full audit of `codex-sol`
Six specialist agents audited the app (accounting logic, money math, data integrity, AI safety, code quality/CI, product gaps). Deliverable: **"Ledgr AI — Full Audit Report (codex-sol)"** document (in this thread's artifacts). ~60 findings. Headlines: backup excluded the entire V2 ledger; COGS never posted (P&L overstated profit); 4 profit engines disagreed ($415 divergence); Play-Store lockout risk (throwaway CI keystore + bundle-ID mismatch); reconcile AI wrote to books without confirmation; CI tests never ran on the branch.

## Phase 2 — Fix rounds on `Fable5-Opus` (all Opus/Fable agents)

**Round 1 — full audit fixes (~60 findings).** COGS engine (`cogs.ts`, periodic model, posted at close), retained-earnings close (3300), closed-period guard, customer/supplier advances (2100/1210), cash-basis reporting, V2 backup (format 9), atomic restore, complete factory reset, AI hardening (reconcile confirmation, amount ≤1e9 / years 2000-2099 bounds, OCR injection delimiting, key→header, model → gemini-2.5-flash), repo hygiene (~15MB junk deleted, deps pruned), CI rework (persistent-keystore signing w/ test-signed fallback, test-gated builds, tests on all branches). Result: 45 suites/276 tests → published via per-file commits (GitHub App token can't do multi-file pushes).

**Round 2 — verification + UI perf + rebrand.** Independent re-audit verified all round-1 fixes genuine; found & fixed 4 new issues (cash-basis gross/net coherence, COGS count-selection edges, close-vs-report count rules, account-id lookup). UI performance layer: `dataVersion.ts` + `useScreenData` (instant back-nav), InteractionManager deferral, FlatList tuning, memoized rows. **Rebrand: `com.ahem.ledgrai`** everywhere (no `mbell` in app). 46/285.

**Round 3 — device-testing feedback.** Date-input normalization (`normalizeDateInput`) across 11 fields/9 screens + Opening Balances modal; animation overshoot clamped (hero-tile bounce); shared `FormCard/FormField/FormActions` for investor/inventory/assets; factory reset wipes prefs (theme/animations/tile order) + instant theme reset; **persona→tiles wiring fixed** (was totally broken — key mismatch); multi-book isolation verified (10 tests). Also fixed reports-tab P&L field mapping (cogs/grossProfit were aliased wrong). 49/327.

**Round 4 — approved monthly report.** User's own prototype design implemented: `reportDocument.ts` builder — hero net-profit card, assets/liabilities columns, Partner Stakes Reconciliation — exact for print/share PDF (A4), mini native preview in-app, accents adapt to invoice theme (navy_gold/amoled_blue/emerald/minimal). 50/342.

**Round 5 — date sweep from screenshot.** Found the Cash Book/inventory/assets regexes were `\\d` (double-escaped) = **rejected every date ever typed**; plus Samsung keypad Unicode dashes (U+2212 etc.). Normalizer folds 9 dash variants; every typed-date site app-wide routed through it; onBlur self-correction; tripwire contract test. 51/352.

**Round 6 — custom report + press consistency.** Custom Report was raw pipe-joined dumps → rebuilt in approved style (`customReportDocument.ts`): real trial-balance table w/ tie-out totals, P&L hero, balance-sheet groups, themed PDF + structured preview + Print. Dashboard daily-summary card got the same press treatment as hero (KPI tiles aligned). 52/374.

**Round 7 — opening-balance dead end.** "Opening balances are already posted…reverse them" guard removed; single self-correcting `applyOpeningBalances` (amount delta / date change auto reverse+repost / no-op / zero-out / closed-period actionable error). Bonus: cashbook reversal-collapsing (`ledgerDisplay.ts`) shipped — one row per edited opening, totals don't count internal pairs. 53/380.

**Round 8 — Scan & Import feature.** `analyzeDocumentAI` (any photo/PDF/pasted text → classified + extracted entries & book setup), review screen w/ per-row checkboxes + inline edits + bounds flags, batch import via existing api only, `[Scan]` tags. Entry points: Ask screen + quick-action menu. Purely additive (1,095 insertions, 0 deletions). 54/393.

**Round 9 — investor capital UX.** Parties tile now shows computed capital (was stale opening snapshot); cashbook mirror dedupe (linkage + fallback — deposits showed twice, In doubled); new deposit entry points (Cash In type chip → Investor capital; Parties "+ Capital"). Formula: Current Capital = Opening + Injections + Profit Share − Drawings. 55/409.

**Round 10 — factory-reset → onboarding crash.** `UNIQUE constraint failed: v2_books.id` — reset preserved book-identity rows; now `factoryResetV2Data` wipes every v2_* table (guarded list) AND bootstrap is idempotent/self-healing (fixes devices carrying orphan rows from old builds). Regression reproduced pre-fix. 56/414.

**Round 11 — audit team (user-requested).** Opus lifecycle auditor drove real api through full journeys w/ cross-view consistency. Engine core passed everywhere. Found & fixed: **CRITICAL** backup lost all secondary books (format 10 now carries books index + every book's data); credit/debit notes 100% broken (field mismatch + legacy-only); quote→invoice bypassed V2 ledger; closed-period edit dead-end (now redirects like delete); partially-paid invoice edits (≥ received OK, else actionable message); markUnpaid unhandled throw. **58 suites / 425 tests green.**

## Builds & CI along the way
- Workflows applied manually by user (App token lacks `workflows` scope — permanent limitation).
- Actions bumped to Node-24 majors (checkout/setup-node/setup-java v5, upload-artifact v5, setup-android v4).
- `concurrency: cancel-in-progress` added to test.yml (kills mid-batch red noise from per-file pushes; judge branch health by the NEWEST run).
- APK/AAB built successfully twice (test-signed): last build = round-6 code (`65b77a2`). **Rounds 7–11 NOT yet in any installed build.**

## Where things stand (end of session)
- Branch `Fable5-Opus` @ `0ce1c39…` — local == remote, all pushed.
- 58/58 suites, 425 tests, tsc clean; Tests green in real CI.
- 11 fix rounds documented in `docs/AUDIT_FIXES.md` on the branch.
- **Next action: trigger a fresh APK build** (Run workflow → Fable5-Opus) and retest on device.
