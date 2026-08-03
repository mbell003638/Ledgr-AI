# Ledgr AI — Project Memory (resume-from-here)

Everything an agent (or you) needs to continue work without re-discovery. State as of 2026-08-04, branch `Fable5-Opus` @ `0ce1c39`.

## The project
- **App:** Ledgr AI — offline-first, single-user shop accounting (React Native / Expo SDK 54, TypeScript, expo-router). No server. Data on-device: SQLite (primary) + AsyncStorage. AI features call providers directly with the user's own key.
- **Repo:** `github.com/mbell003638/Ledgr-AI` · **work branch: `Fable5-Opus`** (base was `codex-sol`; `main` is stale).
- **Identity:** `com.ahem.ledgrai` (Android package + iOS bundle id; no "mbell" anywhere in app). Nothing shipped to Play yet.
- **User context:** shop owner (DRC/Congo, UTC+1/2 — hence local-date fixes), Samsung Android device, partnership books (partners e.g. Amit/Rahim, 50/50, 18% commission), migrating from an older prototype app (`accounts_shop_pro.html` design).

## Architecture map (key files)
- **V2 double-entry engine (authoritative):** `frontend/src/accountingV2/` — `repository.ts` (savepoints, balanced-entry enforcement, closed-period validation), `postings.ts` (per-doc journals incl. advances 2100/1210, role-aware notes), `documentService.ts` (reversal-based edits/deletes; closed-period corrections redirect to open period), `reports.ts` (`buildV2Reports`, accrual+cash basis, COGS-aware), `cogs.ts` (single source: periodic COGS = opening + purchases − closing count), `closeBooksRepository.ts` (close posts COGS + commission journals, zeroes temporaries into 3300 Retained Earnings, allocates to partners), `appService.ts` (orchestration; self-correcting `applyOpeningBalances`; V2-first writes with legacy mirror; `lastMirrorErrors`), `appBootstrap.ts` (idempotent/self-healing book init), `resetBook.ts` (`factoryResetV2Data` wipes ALL v2_* tables), `investorLedgerService.ts`, `scanImport.ts` (AI-import mapper).
- **Chart:** 1000 Cash…1100 AR, 1200 Inventory, 1210 Supplier Advances, 2000 AP, 2100 Customer Advances, 2200 Commission Payable, 3000 Member Capital, 3100 Drawings, 3200 legacy Current Profit (retired), 3300 Retained Earnings, 3400 Owner Contributions, 4000/4010 Sales, 5000 COGS, 6000/6100 Expenses.
- **Legacy V1:** `src/db/local.ts` (2k lines, per-book namespaced collections) — mirror only; V2 authoritative. Secondary books DO run on V2 (SQLite shared).
- **api seam:** `src/api.ts` — ALL screens go through it. Historical bug hotspot: legacy-only routes bypassing V2 (notes + quote-conversion were fixed in round 11 — check any remaining `db.*` write passthroughs when adding features).
- **Backup:** format **10** — legacy collections + settings/logo + books index + per-secondary-book payloads + full V2 dump (`v2Backup.ts`); atomic restore; API key stripped.
- **UI conventions:** `useScreenData` + `dataVersion.ts` (bump on every write — new write paths MUST call `bumpDataVersion()`), `normalizeDateInput` on every typed date (tripwire test enforces), `FormCard/FormField` shared form grammar, GlowPressable press scale 0.972 w/ overshootClamping, `ledgerDisplay.ts` collapse/dedupe for cashbook, report builders `reportDocument.ts` (monthly) + `customReportDocument.ts` (custom) — approved style: cream A4, hero card, monospace tabular numbers, invoice-theme accents (navy_gold default).
- **AI:** `src/db/ai.ts` — 5 providers (Gemini default `gemini-2.5-flash`, Anthropic, OpenRouter, custom OpenAI/Anthropic-compatible), JSON-schema extraction, untrusted-doc delimiting, 30s timeout, 429/model-gone handling. Writes ALWAYS user-confirmed, tagged `[Voice]/[AI]/[Reconcile]/[Scan]`, bounds: amount ≤1e9, years 2000-2099. Key in expo-secure-store, stripped from backups.

## Working-with-this-repo constraints (hard-won)
1. **GitHub App token limits:** NO multi-file commits (git-trees 403) → push one commit per file via `github__push_files` w/ paramsFile; NO `.github/workflows/` writes (`workflows` scope missing — user must upload workflow changes manually; stage them in `docs/ci/`); NO workflow dispatch via API → user clicks Run workflow (or browser handoff; sessions die ~15 min).
2. **Per-file push bursts** → mid-batch CI runs fail red legitimately; `concurrency` cancels most; judge by NEWEST run. A rare event-order race can leave a stale red run — the build workflow's test gate is the authority.
3. **Sandbox:** npm registry needs network approval; no gh CLI; anonymous GitHub API rate-limits after heavy polling.
4. **Validation ritual per change:** `npx tsc --noEmit` + `npx jest --ci --silent` (58 suites/425 tests green baseline) → append `docs/AUDIT_FIXES.md` round entry → local commit (Co-Authored-By: Claude Fable 5) → per-file courier push → `git fetch` + `git diff HEAD FETCH_HEAD` must be empty.
5. Tests use real `node:sqlite`; device-faithful harness pattern exists in repo tests (and `/tmp/audit-journey/` from the round-11 auditor — tmp may not survive).

## Current status
- ✅ 11 fix rounds complete; 58/58 suites, 425 tests, tsc clean; branch fully pushed & in sync.
- ✅ CI: tests all branches + cancel-in-progress; build gated on tests; persistent-keystore ready (secrets NOT yet configured → builds are test-signed, suffix `-testsigned`).
- ⚠️ **Installed APK on user's device = round-6 code.** Rounds 7-11 (opening-balance fix, cashbook collapse, Scan & Import, capital UX, reset crash, notes/quotes/backup fixes) need a fresh build: Actions → Build Ledgr AI Android → branch Fable5-Opus (~20 min; artifacts `Ledgr-AI-APK-testsigned` / `-AAB-testsigned`). Test-signed APK installs ALONGSIDE old app (different key/id).

## Open items / backlog
1. **Trigger fresh APK build + device retest of rounds 7-11.** (Top priority.)
2. Day Book: apply reversal-collapsing + tap-to-source navigation (cashbook has it; daybook pending).
3. Apply approved report style to P&L/balance-sheet/party-statement share-print outputs.
4. Play-Store signing: generate persistent keystore, add 4 GitHub secrets (RELEASE_KEYSTORE_B64, RELEASE_KEY_ALIAS, RELEASE_STORE_PASSWORD, RELEASE_KEY_PASSWORD).
5. PR `Fable5-Opus` → `codex-sol` (squash-merge recommended — branch has ~200 per-file commits).
6. Product roadmap P0s (from audit): WhatsApp payment reminders, VAT/TVA line calc (fields exist, not wired), product catalog, aged receivables + statements; CDF currency ✅ done. AI-first: auto-categorization, cash-flow forecast, close assistant. Optional: capital-weighted profit splits, per-location cash accounts (user's prototype had them).
7. Deferred tech debt: git-history blob purge (needs owner), V1 CRUD typing (~428 anys), god-file splits (local.ts/invoices.tsx/api.ts), full V1→V2 cutover decision.
8. Known limitation: AsyncStorage-fallback mode (SQLite unavailable — rare) creates legacy-only books.

## Key artifacts in this thread
- Document: "Ledgr AI — Full Audit Report (codex-sol)" (original audit).
- Webpage: "Report Redesign Proposal" mockup.
- On-branch: `docs/AUDIT_FIXES.md` (all 11 rounds, finding-by-finding), `docs/ci/` (workflow copies).
- Agent roster used: audits/fixes ran as Opus/Fable subagents with disjoint file ownership; pushes via sequential per-file "courier" agents.
