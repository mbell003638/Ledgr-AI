# Ledgr-AI — Master App System Prompt & Product Specification

> **Single Source of Truth** for Ledgr AI. Captures the complete history, requirements, accounting logic, schema definitions, and prompt specification for present and future development.

---

## 1. Executive Summary & Vision

**Ledgr-AI** is a mobile-first, AI-assisted, offline-capable accounting and bookkeeping application built with **React Native (Expo SDK 54)** and **SQLite (`expo-sqlite`)**.

It is designed for a **global audience** of small business owners, retail shopkeepers, freelancers, handy men, service providers, and multi-partner retail businesses.

### Core Principles
1. **AI & Voice-First UX:** Ultra-simple natural language voice and text input for users who are not tech-savvy or accounting-trained.
2. **Dual Accounting Engine:**
   - **Mode A: Shop Partnership Mode (Investor & Shopkeeper Model)**
     - Periodic physical inventory audits (irregular intervals).
     - 50/50 Partner Capital Accounts (e.g. Amit & Rahim with different opening stakes, e.g. $90,184.97 & $109,942.12).
     - Shopkeeper (Aheshan) salary + commission % on Gross Profit.
     - Net Profit = Gross Profit - Commission - Expenses (Drawings reduce Capital, NOT Net Profit).
     - Books close snapshot with closing balances carried forward to next period as opening balances.
   - **Mode B: Standard Accounting Mode (Regular Way)**
     - Standard Accrual/Cash P&L, Balance Sheet, Trial Balance, Debtors, Creditors, Equity.
3. **Unified Parties System:**
   - Single authoritative `v2_parties` table tracking both Customers (Debtors / Accounts Receivable) and Suppliers (Creditors / Accounts Payable).
   - Prevents duplicate party names; seamlessly auto-links transactions across Sales, Invoices, Receipts, Bills, and Payments.
4. **Dynamic Business Personas & Multi-Book Accounts:**
   - Onboarding allows choosing personas (Retail, Wholesale, Salon, Handyman, Tech/Freelancer, Vendor, Custom).
   - Multi-account switcher dropdown in Settings & Header to toggle between separate business accounts.
5. **Custom Report Builder & Executive PDF Generator:**
   - Replaces fixed staff tabs with a custom report builder.
   - Check/uncheck sections (P&L, Balance Sheet, Trial Balance, Inventory & COGS Flow, Debtors, Creditors, Partner Capital).
   - Generates beautifully styled corporate PDF reports and WhatsApp text summaries.

---

## 2. Complete Double-Entry Accounting Engine Specs

```
                    ┌─────────────────────────┐
                    │     Sales & Invoices    │
                    └────────────┬────────────┘
                                 │
             ┌───────────────────┴───────────────────┐
             ▼                                       ▼
    [Cash Sale]                             [Credit Sale (Invoice)]
    Debit: Cash in Hand (1000)              Debit: Accounts Receivable (1100)
    Credit: Sales Revenue (4000)            Credit: Sales Revenue (4000)
                                                     │
                                                     ▼
                                            [Customer Receipt]
                                            Debit: Cash in Hand (1000)
                                            Credit: Accounts Receivable (1100)
```

### Formula Engine
- **COGS (Cost of Goods Sold)** = Opening Inventory + Purchases - Closing Inventory
- **Gross Profit** = Total Sales Revenue - COGS
- **Manager Commission** = Positive Gross Profit × Commission %
- **Operating Net Profit** = Gross Profit - Manager Commission - Operating Expenses
- **Ending Partner Capital (Partner A)** = Opening Capital(A) + (Net Profit × Share%(A)) - Drawings(A)
- **Ending Partner Capital (Partner B)** = Opening Capital(B) + (Net Profit × Share%(B)) - Drawings(B)
- **Balance Sheet Equality**: `Total Assets (Cash + Inventory + Receivables) = Total Liabilities (Payables + Commission Payable) + Total Partner Capital`

---

## 3. Database Schema (`v2_*` SQLite)

```sql
v2_books (id, name, style, basis, created_at)
v2_personas (book_id, persona_id, active)
v2_parties (id, book_id, name, phone, email, roles, archived)
v2_accounts (id, book_id, code, name, type, payment_method, active)
v2_periods (id, book_id, start_date, end_date, status, close_snapshot)
v2_sources (id, book_id, type, date, reference, metadata)
v2_journal_entries (id, book_id, period_id, source_id, date, memo, posted_at, reversal_of)
v2_journal_lines (id, journal_id, account_id, party_id, debit, credit, memo)
v2_members (id, book_id, name, opening_contribution, current_capital, profit_share_pct)
v2_close_books (id, book_id, period_id, closed_at, snapshot, journal_id)
```

---

## 4. User Request History & Design Evolution

1. **Phase 1: Foundation & Voice Parsing**
   - Offline AsyncStorage + SQLite schema, Gemini API integration for voice command parsing.
2. **Phase 2: Customer/Debtor Linkage & Cash Correction**
   - Replaced disconnected sales logic with credit sales (Invoices) linked to Debtors.
   - Separated cash sales vs credit sales so cash in hand is never overstated.
3. **Phase 3: Retail Partnership Accounting (User's Shop Model)**
   - Implemented Amit & Rahim partner capital accounts, Aheshan manager commission %, physical stock audit reconciliation, and period close roll-forward.
4. **Phase 4: Dual Accounting Styles & Multi-Persona Onboarding**
   - Added Support for both "Retail Partnership" and "Standard Accounting".
   - Built Persona system (Retail, Services, Tech, Vendor) and Multi-Book account switcher.
5. **Phase 5: Executive PDF Reports & UI Harmonization**
   - Built Custom Report builder replacing rigid staff tabs.
   - Upgraded PDF engine with styled HTML/CSS matching executive accounting standards.

---

## 5. Verification Guidelines

Before any deployment or release:
1. `npx tsc --noEmit` must return zero TypeScript errors.
2. All Jest tests must pass.
3. Ensure no hardcoded secrets or API keys in repository source files.
