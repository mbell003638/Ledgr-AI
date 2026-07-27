# Ledgr-AI — Master Product & Engineering Prompt

## Mission
Build Ledgr-AI as a polished, offline-first, on-device accounting app for a global audience of small businesses, shops, service businesses, freelancers, and partnerships. It must be easy for non-technical users through AI and voice assistance, while remaining accountant-correct, auditable, and suitable for Play Store release.

## Non-negotiable product constraints
- Android Expo/React Native app; APK/AAB buildable through GitHub Actions.
- Standalone: data stays on the user's device; no hosted backend is required for bookkeeping.
- Use SQLite as the primary local store with a safe AsyncStorage-compatible path where already supported.
- No India-only assumptions. Support multiple currencies and tax labels; use generic Payment ID / Link terminology.
- Never claim a feature, push, build, or test succeeded without real tool output.
- Before every release: run `npx tsc --noEmit`, full `npx jest`, inspect git status, verify remote SHA, then build from that exact SHA.

## Business personas and onboarding
Onboarding must first ask the user to select one or more business personas. Personas are configuration presets, not separate applications:
- Retail shop / inventory business
- Wholesale / trading
- Salon / beauty
- Handyman / repair
- Professional service
- IT / freelancer
- Vendor / service provider
- Custom business

Each persona controls terminology, visible modules, default workflows, fields, reports, and suggested account structure. Users may select multiple personas during onboarding, add or remove personas later in Settings, and choose which persona is active. Do not destroy data when changing persona; only change presentation and defaults.

The onboarding must ask the minimum relevant questions for the selected personas:
- inventory tracking and periodic stock count for retail/wholesale
- service/job fields for handyman and professional service
- project/client fields for IT/freelancer
- appointments/staff fields for salon
- tax, currency, opening balances, payment accounts, and accounting style

## Multiple books/accounts
Support separate books/ledgers on one device. A user can create two or more independent accounts, such as Shop Accounts A and B, and toggle the active book from Settings. Every book has isolated transactions, settings, opening balances, members, reports, personas, and close-book periods. Switching books must reload all screens and must never mix records.

## Accounting styles
Provide a Settings choice:
1. Standard bookkeeping: accrual or cash basis, with full receivables/payables.
2. Retail periodic-inventory partnership style.
3. Simple cashbook style for very small businesses.
4. Custom/hybrid style with explicitly documented rules.

The selected style controls the same underlying ledger and report engine. It must not create conflicting formulas in different screens. The user can change presentation/style only with a clear warning; historical postings remain auditable.

## Retail partnership mode
For the user's shop model:
- Two investors can have different opening capital contributions.
- Profit share can be 50/50 even when opening capital differs.
- A shopkeeper has salary/expense treatment plus a commission percentage of positive gross profit; commission may be changed by period and is not globally fixed.
- Inventory is counted periodically at an irregular interval.
- COGS = opening inventory + purchases - closing inventory.
- Gross Profit = Sales - COGS.
- Commission = positive Gross Profit × shopkeeper commission percentage.
- Net Profit = Gross Profit - commission - operating expenses.
- Drawings are not expenses and do not reduce Net Profit.
- Investor profit share is based on configured profit-share percentages, independent of opening capital.
- Closing capital = opening capital + allocated net profit - drawings.
- Close Books creates an immutable period-close record, records closing stock/cash/receivables/payables, allocates profit to investor capital, carries closing balances into the next period as opening balances, and is idempotent.
- Never delete historical transactions during close; use period IDs and opening/closing snapshots.

## Core double-entry behavior
Use stable `partyId`, `bookId`, `periodId`, and source-document IDs. Never match accounting records only by mutable names.

Credit sale:
- create invoice linked to a customer party
- debit Accounts Receivable
- credit Sales Revenue
- customer appears in Debtors and unified Parties
- no cash increase until receipt

Cash sale:
- debit selected cash/bank/payment account
- credit Sales Revenue
- appear in Sales and Day Book

Customer receipt:
- validate allocations against existing invoice ownership and open balances
- allocated amount reduces Accounts Receivable
- cash/bank/card account increases according to payment method
- accrual revenue does not increase again
- cash-basis revenue counts only allocated invoice amounts
- excess becomes Customer Advance, never revenue

Advance:
- debit selected payment account
- credit Customer Advances
- applying advance to an invoice reduces Customer Advances and Accounts Receivable; cash-basis recognition must use the allocation event

Mark paid:
- collect only the invoice's remaining open amount
- never double-collect partial payments

Payments:
- edit/delete from the UI; reversal must atomically reverse receipt, account movement, allocations, customer ledger, and invoice status

Purchases:
- cash purchase decreases selected payment account; credit purchase increases Accounts Payable
- supplier payment decreases cash/bank and Accounts Payable

Expenses:
- operating expenses reduce profit
- paid expenses reduce the selected payment account
- unpaid expenses create a payable

Credit/debit notes:
- update receivable and invoice settlement calculations
- credit notes reduce revenue/receivable; debit notes increase them

Accounts:
- cash in hand, bank, card/mobile clearing, accounts receivable, inventory, accounts payable, customer advances, commission payable, expenses, revenue, equity, drawings
- payment method must not automatically mean physical cash

## Reports
All reports must derive from the same authoritative journal/posting engine:
- Dashboard
- Sales register including cash and credit sales
- Receipts register
- Purchases register
- Cash/Bank book
- Day Book
- Customer/Debtor statements
- Supplier/Creditor statements
- P&L
- Balance Sheet
- Trial Balance with debit total, credit total, and difference (difference must be zero)
- tax report
- inventory/COGS report
- period close report
- custom report

Reports must show opening balance, period activity, and closing balance where relevant. They must reconcile: Assets = Liabilities + Equity and debits = credits.

## Custom Report Builder
Remove the fixed Staff report tab and replace it with Custom Reports. Users select:
- date/period
- sections and fields to include
- sales, purchases, receipts, expenses, cash, inventory, debtors, creditors, members, profit, tax, notes
- grouping and sorting
- portrait/landscape and branding

Reports must be printable/exportable as PDF, HTML, and text, and shareable through Android share sheet/WhatsApp. The AI assistant can explain and summarize any generated report.

## AI-first and voice-first UX
AI must work on-device where possible and use a user-selected provider/key for remote model calls. Provide safe confirmation before writes. Support natural language such as:
- “Record a cash sale of 500.”
- “Create a credit invoice for Amit.”
- “What is my net profit this period?”
- “Show unpaid customers.”
- “Close the books for March.”
Voice assistant should transcribe, show the interpreted action, ask confirmation for financial writes, execute through the same API as the UI, and read summaries aloud. AI must never bypass validation or write raw collections directly.

## Professional UI/UX
- coherent design system with consistent cards, tiles, typography, spacing, iconography, empty states, loading states, and error states
- polished home dashboard with configurable KPI cards
- bottom navigation based on active persona, not a fixed cluttered list
- consistent tap-to-open detail screens like Sales
- consistent Edit, Delete, Duplicate, Share, Print, and More actions
- accessible labels, good contrast, large touch targets, dark mode
- confirmation and undo for destructive actions
- hide irrelevant modules instead of showing empty clutter

## Technical architecture
- TypeScript strict enough to catch missing fields.
- Domain services for postings, receipts, allocation, period close, and reporting.
- UI calls domain API; UI never calculates authoritative balances.
- One transaction/unit-of-work for multi-collection writes with rollback.
- Migrations for existing on-device data and legacy `price`/`rate`, debtor references, receipts, and books.
- Audit log for corrections and period closes.

## Acceptance tests before release
Create tests for:
- credit sale → party → invoice → debtor → receivable
- cash sale → payment account → sales
- partial receipt → partial invoice status
- mark paid after partial receipt
- overpayment → customer advance
- apply advance → invoice and cash-basis revenue
- payment edit/delete reversal
- invoice edit/party rename
- cash vs bank/card posting
- cash/credit purchase and supplier payment
- expense posting and reversal
- credit/debit notes
- COGS with opening/purchases/closing stock
- drawings and capital close
- multiple books/personas isolation
- all reports reconciling
- AI/voice actions using the same validated API

## Delivery discipline
Plan first. Implement in small verified batches. Run typecheck and full tests after every batch. Use independent code review for accounting changes. Never push or trigger APK/AAB until the branch is clean, the remote SHA is verified, and all acceptance tests pass.
