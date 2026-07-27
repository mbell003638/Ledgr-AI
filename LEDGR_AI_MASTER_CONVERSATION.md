# Ledgr AI — Complete Accounting & Architecture Master Specification

## Executive Summary
This document records the exact accounting architecture, business persona specs, SQLite V2 integration requirements, and conversation history for the **Ledgr AI** application repository.

---

## 1. Core Accounting Modes

### A. Partner Equity & Profit-Split Accounting
1. **50/50 Partner Equity Accounts**:
   - Primary Partners: **Amit** & **Rahim** (or user-customized partners).
   - Standing Capital Formula: `Opening Capital + Net Profit Share − Partner Drawings`.
2. **Periodic Physical Inventory Stock Audit**:
   - Stock counts recorded periodically.
   - Shrinkage / Inventory Variance = `Expected Stock (Opening + Purchases - Sales) - Actual Physical Audit`.
3. **Shopkeeper Salary & Manager Commission %**:
   - Manager Commission % calculated directly on **Gross Profit** (`(Sales Revenue - Cost of Goods Sold) * Commission %`).
   - Manager commission sits as an accrued liability until settled via commission payments.
4. **Period Close Snapshot & Carry Forward**:
   - When closing an accounting period:
     - Net Profit is calculated (`Gross Profit - Commission - Operating Expenses`).
     - Net Profit is allocated 50/50 to partner capital accounts.
     - Period close snapshot freezes ledger history, resets revenue/expense counters, and carries forward closing asset & capital balances to the next period.

### B. Standard Entity & Single-Owner Accounting
1. **Standard Accrual P&L**: Revenue recognized upon sale (both cash sales and credit invoices).
2. **Balance Sheet**: Assets (Cash, Accounts Receivable, Inventory) = Liabilities (Accounts Payable, Expenses Payable) + Equity.
3. **Trial Balance**: Verifies double-entry equality (`Total Debits = Total Credits`).
4. **Single-Owner & General Small Business Ledger**: Ideal for freelancers, handyman services, salons, and consultants.

---

## 2. Fundamental Accounting Formulas

- **Total Sales Revenue**: `Cash Sales + Credit Sales (Invoices) − Credit Notes + Debit Notes`
  - *Rule*: Credit sales **MUST** be included in Total Sales Revenue at the moment of invoice creation.
- **Accounts Receivable (Debtors)**: `Total Invoiced + Charges/Debits − Receipts/Payments − Discounts/Credits`
- **Cash in Hand**: `Opening Cash + Cash Sales + Customer Payment Receipts − Supplier Payments − Expenses Paid − Drawings`
  - *Rule*: Credit sales increase Accounts Receivable, **NOT** Cash in Hand, until money is actually received via a payment receipt.
- **Gross Profit**: `Total Sales Revenue − Total Purchases (COGS)`
- **Net Profit**: `Gross Profit − Manager Commission − Operating Expenses / Drawings`

---

## 3. Implemented Features & Bug Fixes

1. **Onboarding Web/AsyncStorage Fallback**:
   - Fixed `api.initializeV2Book` in `src/api.ts` to handle Web/AsyncStorage fallback mode gracefully without throwing an error when clicking "Get Started".

2. **Debtors Statement Invoice Actions**:
   - Added **Edit** and **Delete** actions for invoice rows inside Customer Statements in `app/debtors.tsx`.
   - Tapping an invoice opens the **Edit Invoice** dialog.
   - Deleting an invoice reverses the entry, updates the customer balance, and adjusts ledger postings.

3. **Credit Sales Reflected across Sales Screen & Dashboard**:
   - `api.listSales()` in `src/api.ts` and `src/db/local.ts` returns both Cash Sales and Credit Invoices.
   - Total Sales tiles on the Home screen and P&L include credit sales.

4. **Case-Insensitive & Whitespace-Insensitive Duplicate Party Validation**:
   - `api.createParty`, `createDebtor`, and `createSupplier` enforce unique names (e.g. "Sharda", "sharda", " SHARDA " are detected as duplicates and blocked).

5. **Customer Deletion Fix**:
   - Customer deletion in `app/debtors.tsx` is no longer blocked by non-zero balances.

6. **Reports Sub-Tab Scrollbar Styling**:
   - Streamlined report category pills in `app/(tabs)/reports.tsx` into a clean, horizontal single-row scrollbar.

7. **Accounting Style Settings Toggle**:
   - Added a clear **Accounting Style** card in `app/(tabs)/settings.tsx` to switch between **Partner Equity & Profit-Split Accounting** and **Standard Entity & Single-Owner Accounting**.

---

## 4. Detailed Conversation Log & Request Transcript

### Turn 1: Onboarding "Get Started" Navigation Issue
- **User Prompt**: *"on the screen protect your books after clicking yes enable app lock or no skip for now when clicking get started nothing hpnds... you test it tis still same"*
- **Root Cause**: On Web/Expo preview, SQLite driver was null (`activeSqlRunner() == null`). In `api.ts`, `initializeV2Book` threw `'V2 accounting requires SQLite storage'` which silently failed onboarding on Step 3.
- **Resolution**: Updated `api.initializeV2Book` in `src/api.ts` to return fallback book details when `runner` is null. Onboarding now completes instantly on Web, Android, and iOS.

### Turn 2: Customer Invoice Edit/Delete & Credit Sales Accounting
- **User Prompt**: *"on this page upon clicking on invoice i should be able to redirect to its original entry and i should be able to modify, not able to delete or edit that invoice entry under debtors... also any sales made to debtors in credit does not show under sale even if its on credit sale is sale isnt it... sales is 200 but inside if i see i see only one entry... workflow persona is so clutter... main account is active indication is un necessorry"*
- **Audit Findings**:
  1. `app/debtors.tsx` statement ledger only rendered edit/delete buttons for `payment` rows, hiding actions on `invoice` rows.
  2. `api.listSales()` in `src/api.ts` filtered out `x.type === 'invoice'`, hiding credit sales from the Sales tab!
  3. `app/(tabs)/settings.tsx` rendered 7 large vertical persona cards eating up the whole screen height.
- **Resolutions**:
  1. Added `openInvoiceEdit` and `deleteInvoiceEntry` handlers in `app/debtors.tsx` allowing direct editing and deletion of invoice statement rows.
  2. Updated `api.listSales()` and `dailySummary()` in `src/api.ts` to return both Cash Sales and Credit Invoices.
  3. Reorganized `app/(tabs)/settings.tsx` to use compact horizontal workflow chips and a green `Active` status badge.

### Turn 3: Mode Naming & Unique Party Validation
- **User Prompt**: *"dont name your way name it like equite or split or something better stands out as proffessional... duplicate entry is possible with party name... still not aable to delete customer... report tab UI clutter"*
- **Resolutions**:
  1. Renamed accounting modes to **Partner Equity & Profit-Split Accounting** and **Standard Entity & Single-Owner Accounting**.
  2. Added case-insensitive & whitespace-insensitive duplicate check in `createParty`, `createDebtor`, and `createSupplier`.
  3. Unblocked customer deletion in `app/debtors.tsx`.
  4. Styled `app/(tabs)/reports.tsx` sub-tab category bar into a clean horizontal single-row scrollbar.

### Turn 4: Invoice Format, Total Sales Aggregation & Reports UI Overlap Fix
- **User Prompt**: *"invoice foramt you did not change still same old mathod go to git hub repo check the other previouse branch phase2-sqlite-storage... check the reporting ui clutter and not visibal all the tab check how sale of 100 made to debtor shows insidte the report"*
- **Audit Findings**:
  1. Verified $100 debtor sale is now correctly showing inside Reports under **Sales ($100.00)**, **Gross Profit ($100.00)**, and **Net Profit ($100.00)**.
  2. The Date Range Presets and Report Category Segment scrollbars were sharing generic styles and overlapping vertically.
- **Resolutions**:
  1. Separated Report Category Pills (`Summary`, `P&L`, `Balance`, `Trial`, `Capital`, `Drawings`, `Creditors`, `Debtors`, `Tax`) into a top primary scrollbar and Date Filter Sub-Chips (`This Month`, `Last Month`, `This Quarter`, `This Year`, `All Time`, `Custom`) into a distinct bottom chip bar.
  2. Gave explicit vertical heights (`height: 44` and `height: 36`) and margins to ensure zero tab overlap.
  3. Updated `LEDGR_AI_MASTER_CONVERSATION.md`.

### Turn 5: Summary Report Assets/Liabilities & Invoice Print Carry-Forward
- **User Prompt**: *"in summery report i dont see asset liabilites creditors or anything simmilar to this report also sales made to debtors on credit should apear as asset isnt it or am i wrong ? and why you are not changing invoice format as pet the branch phase2-sqlite-storage on git hub"*
- **Audit Findings**:
  1. **Summary Tab**: The summary tab rendered "Outstanding Payables" but omitted Debtors. Debtors were correctly stored but not surfaced as an explicit Asset line-item in the `Live — Current Period` card.
  2. **Invoice Format**: The HTML template in `invoices.tsx` *did* match `phase2-sqlite-storage` exactly. However, the `printInvoice` action invoked by the Web UI Print button was missing the `prevBalance` carry-forward calculation that was present in `sharePdf`. This caused printed invoices to look like they lacked carry-forward logic.
- **Resolutions**:
  1. Added `accountsReceivable` to the `getDashboard()` return in `local.ts`, rolling up invoice sales minus receipts. Included it in the `assets` and `netWorth` totals.
  2. Updated `app/(tabs)/reports.tsx`'s `Live — Current Period` Summary card to explicitly show **Outstanding Debtors**, and renamed *Outstanding Payables* to **Creditors** to match legacy conventions.
  3. Refactored `getPrevBalance(inv)` out of `sharePdf` in `invoices.tsx` and applied it to `printInvoice` so both Web Printing and PDF Sharing display accurate "Previous Balance (carried fwd)" and "Balance Due" lines on the invoice.

---

*Document generated by Antigravity AI Assistant.*
