# Ledgr-AI Clean-Slate V2 Implementation Plan

> **For Hermes:** Use this plan task-by-task with TDD and independent review. Do not trigger a release build until all release gates pass.

**Goal:** Replace the disconnected accounting collections with a stable, balanced, on-device ledger while delivering multi-persona onboarding, isolated books, retail partnership close-books, unified Parties, Custom Reports, AI/voice workflows, and professional UI.

**Architecture:** Keep the existing Expo Router/React Native shell and useful native integrations, but introduce a V2 domain layer whose journal postings are authoritative. Documents (sales, invoices, receipts, bills, expenses) reference stable books, parties, accounts, periods, and source IDs. Reports derive from postings and reconciliation checks, not duplicated totals. Since legacy data is unimportant, V2 starts with a clean database namespace and an explicit “new V2 book” path; old collections remain read-only only until removed after verification.

**Tech Stack:** Expo 54, React Native 0.81, TypeScript, expo-sqlite, AsyncStorage fallback, Expo Print/Sharing, Jest/ts-jest, Expo Router.

---

## Release gates for every batch

1. `cd frontend && npx tsc --noEmit`
2. `cd frontend && npx jest --runInBand`
3. `git diff --check`, `git status --short`
4. Independent review of accounting changes.
5. No push/build until remote SHA equals local SHA and the exact workflow `head_sha` is verified.

## Task 1: Freeze the current baseline

**Files:** `frontend/__tests__/v2Baseline.test.ts`, `frontend/src/db/*`.

- Record the current test count and known defects as audit fixtures.
- Ensure no source change is made without a failing test for the target behavior.
- Add a V2 feature flag/book version setting that defaults new builds to V2 while preserving the current shell.

## Task 2: Add V2 schema and types

**Files:** Create `frontend/src/accountingV2/types.ts`, `frontend/src/accountingV2/schema.ts`; modify `frontend/src/db/schema.ts`, `frontend/src/db/sqliteStore.ts`.

Add tables/collections:

- `v2_books`: id, name, active, style, basis, createdAt
- `v2_personas`: id, bookId, type, enabled, config
- `v2_parties`: id, bookId, name, phone, email, roles, archived
- `v2_accounts`: id, bookId, code, name, type, paymentMethod, active
- `v2_periods`: id, bookId, startDate, endDate, status, closeSnapshot
- `v2_sources`: id, bookId, type, date, reference, metadata
- `v2_journal_entries`: id, bookId, periodId, sourceId, date, memo, postedAt, reversalOf
- `v2_journal_lines`: id, journalId, accountId, partyId, debit, credit, memo
- `v2_invoice_allocations`: id, bookId, invoiceSourceId, receiptSourceId, amount, allocatedAt
- `v2_inventory_counts`: id, bookId, periodId, date, value
- `v2_members`: id, bookId, name, openingContribution, profitSharePct
- `v2_close_books`: id, bookId, periodId, closedAt, snapshot, journalId

Invariants:
- debit and credit are finite non-negative numbers; a line cannot have both > 0.
- journal debit total equals credit total within cent tolerance.
- every source/book/period/account/party reference is valid.
- all writes run in one SQLite transaction or rollback entirely.

## Task 3: Implement posting engine first

**Files:** Create `frontend/src/accountingV2/postings.ts`, `frontend/src/accountingV2/repository.ts`; tests `frontend/__tests__/v2Postings.test.ts`.

Implement:

- `postJournal(input)` with balanced-entry validation and transaction.
- `reverseJournal(journalId, reason)` using an explicit reversal entry.
- `ensureDefaultAccounts(bookId)` for cash, bank, card/mobile clearing, AR, inventory, AP, customer advances, revenue, COGS, expenses, commission payable, capital, drawings.
- `accountBalance(bookId, accountId, range)`.
- `reconcileBook(bookId, range)` returning debit, credit, difference, balance-sheet difference, and errors.

Test cash sale, credit sale, receipt, advance, purchase, supplier payment, expense, drawing, and reversal.

## Task 4: Implement authoritative documents

**Files:** Create `frontend/src/accountingV2/documents.ts`; tests `frontend/__tests__/v2Documents.test.ts`.

Implement:

- `createParty`, `updateParty`, archive (never destructive-delete a party with sources).
- `createInvoice(partyId, lines, tax)` → AR debit + revenue credit.
- `recordReceipt(partyId, paymentAccountId, allocations, amount)` → validate ownership/open balance, post receipt; excess becomes customer advance.
- `markInvoicePaid(invoiceId)` → record only the open balance.
- `editReceipt` and `deleteReceipt` → atomic reversal/repost or reversal only.
- `createPurchase(partyId, paymentAccountId?, amount)` → cash or AP posting.
- `recordSupplierPayment` → AP debit + payment account credit.
- `createExpense` with `settlementAccountId` or payable.
- credit/debit notes linked to invoice and party.

Stable `partyId` is mandatory; names are display-only.

## Task 5: Implement inventory, periods and retail close

**Files:** Create `frontend/src/accountingV2/inventory.ts`, `periodClose.ts`; tests `frontend/__tests__/v2InventoryClose.test.ts`.

- Store irregular physical counts by book/period.
- Compute `COGS = opening inventory + purchases - closing inventory`.
- Support styles: `standard`, `simple_cash`, `retail_partnership`, `custom`.
- `closeBooks(bookId, periodId)` is idempotent and creates an immutable snapshot of cash, bank, AR, AP, advances, inventory, liabilities, member capital, and net profit.
- Retail partnership Net Profit = Sales − COGS − commission − operating expenses; drawings only reduce equity.
- Allocate profit using member percentage shares; carry closing member capital and balances into the next opening period.

## Task 6: Build unified Books, Personas and onboarding

**Files:** `frontend/app/onboarding.tsx`, `frontend/app/(tabs)/settings.tsx`, `frontend/src/db/backend.ts`, create `frontend/src/accountingV2/config.ts`, `frontend/app/book-manager.tsx` if needed.

- Multi-select persona wizard with relevant follow-up questions.
- Store active persona IDs per book; add/remove later without deleting data.
- Book switcher with explicit active-book reload and isolation tests.
- Settings for style, basis, inventory, tax, members, commission policy, close-books permissions.
- Retail-specific setup: members, contributions, profit shares, shopkeeper salary/commission, inventory cadence.
- Generic setup for freelancer/service workflows.

## Task 7: Replace Staff with Custom Reports

**Files:** `frontend/app/(tabs)/reports.tsx`, create `frontend/src/accountingV2/reports.ts`, `frontend/app/custom-report.tsx`; tests `frontend/__tests__/customReports.test.ts`.

- Remove Staff tab/button and employee report route from navigation.
- Build selectable report sections/fields/date range/grouping.
- Generate preview from V2 report engine.
- Export PDF through `expo-print`, HTML/text, and `expo-sharing`/Android share sheet.
- AI summary uses report output, never raw storage.

## Task 8: Unified Parties and Sales UI

**Files:** `frontend/app/(tabs)/suppliers.tsx`, `frontend/app/debtors.tsx`, `frontend/app/sales.tsx`, create shared `frontend/src/components/TransactionDetail.tsx`.

- Parties screen shows customers, suppliers, and both roles with receivable/payable/net balances.
- Sales screen includes cash sales and invoices with document type/status.
- Consistent detail actions: Edit, Delete/Reversal, Share, Print, More.
- Debtor/customer statements resolve receipt metadata and allocations.
- Remove cluttered horizontal action rows; use primary action plus overflow menu.

## Task 9: Professional UI system

**Files:** `frontend/src/components/UI.tsx`, `frontend/src/theme.ts`, home/reports/parties/sales/debtors/settings screens.

- Shared card, tile, row, chip, modal, button, empty/error/loading components.
- Theme tokens, elevation, spacing, typography, contrast and accessibility labels.
- Persona-driven navigation and dashboard KPI configuration.
- No Staff terminology anywhere.

## Task 10: AI and voice commands

**Files:** `frontend/src/db/ai.ts`, `frontend/app/ask.tsx`, `frontend/app/voice.tsx`, `frontend/src/accountingV2/aiActions.ts`.

- Map natural-language intents to validated V2 commands.
- Show confirmation preview for all writes.
- Support report queries, invoice/payment creation, party lookup, inventory/profit, and close books.
- Test intents without real provider calls; provider integration remains configurable.

## Task 11: Reconciliation and regression suite

**Files:** `frontend/__tests__/v2Reconciliation.test.ts`, `frontend/__tests__/v2BooksPersonas.test.ts`, `frontend/__tests__/v2UiContracts.test.ts`.

Prove:

- Every journal balances.
- Assets = liabilities + equity.
- Credit sale/receipt/advance/overpayment behavior.
- Cash/bank/card separation.
- Cash and credit purchases.
- Expense and drawing treatment.
- COGS and close-books carry-forward.
- Multiple books/personas isolated.
- Reports reconcile to journal.
- Staff is absent and Custom Reports exists.
- AI/voice uses confirmation and domain API.

## Task 12: Release and verification

- Run full TypeScript, Jest, lint where available, diff/security scan, independent review.
- Add prompt/docs only after code is real.
- Use a persistent GitHub signing key; never generate a new release key per build.
- Commit once the verified batch is complete.
- Push `sol`; verify remote SHA.
- Dispatch workflow from `sol`; verify run head SHA equals remote SHA.
- Verify APK and AAB artifacts exist and are not expired.
- Do not call the release complete until a physical-device test covers onboarding, book switching, credit sale, payment, custom report, and close books.
