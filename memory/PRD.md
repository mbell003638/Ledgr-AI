# Ledgr — AI-Powered Shop Accounting (PRD)

## Overview
A mobile-first accounting app for small shop owners (rebranded from "Vocash" to **Ledgr** — Gen-Z-styled ledger). Inspired by Odoo's modular apps and Vocash/Dext AI assistants. Single-user, no auth. USD + Franc Congolese (CDF) with editable FC rate. Full dark mode support.

## Data Models (MongoDB)
- `suppliers` — vendor partners (name, phone, notes)
- `bills` — vendor purchases (supplierId, date, amount, currency USD/CDF, rate, credit/cash, invoiceNo, photo base64, ocrText)
- `sales` — daily customer revenue
- `payments` — supplier payments & partner drawings
- `inventoryChecks` — physical stock audits with expected vs actual variance
- `settings` — Google Gemini API key + FC rate

## Screens
- **Dashboard** (`/(tabs)/index.tsx`) — Net worth hero, KPIs (sales, purchases, cash, inventory), Odoo-style app tiles, 7-day sales trend chart
- **Bills** (`/(tabs)/bills.tsx`) — list + Add Bill modal with camera OCR
- **Suppliers** (`/(tabs)/suppliers.tsx`) — list with outstanding balances
- **Supplier Detail** (`/supplier/[id].tsx`) — timeline of bills + payments
- **Reports** (`/(tabs)/reports.tsx`) — P&L, Balance Sheet, Trial Balance
- **Settings** (`/(tabs)/settings.tsx`) — Gemini API key + FC rate + test-key button
- **Modal forms**: bill-form, supplier-form, sale-form, payment-form, inventory-form
- **Voice Assistant** (`/voice.tsx`) — record → Gemini transcribe → parse → confirm draft → auto-create transaction

## Integrations
- **Google Gemini API** (`gemini-2.5-flash`) via user-provided key stored in AsyncStorage + backend settings:
  - `/api/ai/parse-command` — text → structured accounting JSON
  - `/api/ai/ocr-receipt` — image → supplier/date/amount/invoiceNo
  - `/api/ai/transcribe` — audio → transcript
- **expo-audio** — voice recording (m4a)
- **expo-image-picker + expo-camera** — receipt photo capture
- **react-native-gifted-charts** — dashboard trend chart

## API Endpoints (all under `/api`)
- `GET/PUT /settings`, `POST /settings/test-key`
- `GET/POST/DELETE /suppliers`, `GET /suppliers/{id}` (with running balance & timeline)
- `GET/POST/DELETE /bills`, `/sales`, `/payments`, `/inventory`
- `GET /inventory/expected` — auto-computes expected stock
- `GET /dashboard` — KPIs & sales trend
- `GET /reports/pnl`, `/reports/balance-sheet`, `/reports/trial-balance`
- `POST /ai/parse-command`, `/ai/ocr-receipt`, `/ai/transcribe`

## Not Implemented (Future)
- Multi-currency beyond USD/CDF
- Multi-user auth
- Push notifications (only on user request)

## Recent additions
- **Manager Commission** — new setting `managerCommissionPct` (blank/manual). Dashboard, P&L, monthly summary all deduct commission (= grossProfit × pct/100) before Net Profit. Net Profit = Gross − Commission − Drawings.
- **Close Period & Carry-Forward** — new backend endpoint `POST /api/periods/close` + `periods` collection. On the Inventory Audit form, enter today's actual stock and tap "Close & Carry Forward…". Snapshots the current period (opening, sales, purchases, gross profit, commission, drawings, net profit, closing inventory, closing cash) into `periods`, then bumps `settings.currentPeriodStart` and sets `openingInventory`/`openingCash` for the next period.
- **Period-aware Dashboard** — all `/api/dashboard` aggregates now filter transactions by `date >= currentPeriodStart` so closed-period entries don't inflate current numbers. Response includes `openingBalance`, `openingCash`, `openingInventory`, `closingBalance`, `commission`, `netProfit`, `managerCommissionPct`, `periodStart`.
- **Reset All Data** — `POST /api/reset?confirm=YES` wipes all collections while preserving Gemini key + FC rate. Settings screen has a Danger-Zone card with a 2-tap confirmation flow.
- **New Dashboard UX** — Hero card now shows **NET PROFIT** with Opening / Closing / Net Worth footer. New "Profit Flow" card breaks down Sales → Purchases → Gross Profit → Commission → Drawings → Net Profit visually.
- **Dark mode** via `src/context/ThemeContext.tsx` with `light | dark | system` toggle in Settings.
- **Monthly Summary Export** — screen + endpoint + text/PDF share
- **Web / Laptop support** — centered mobile-frame on wide viewports
- **Backup & Restore** — JSON export/import, WhatsApp-shareable, cross-device
- **Daily Quick Summary widget** on Dashboard with WhatsApp share button
- **Gemini model upgraded** from deprecated `gemini-2.5-flash` to current `gemini-3.5-flash` (May 2026 replacement)
- **Edit & delete existing entries** — PUT endpoints for suppliers/bills/sales/payments. Each list row (Bills tab, supplier detail timeline) is tap-to-edit; each edit form has an Update + Delete button.
- **Upload receipt from gallery** — bill form now has both **Scan** (camera) and **Upload** (gallery) buttons. OCR runs on either.
- **Auto-create supplier from OCR** — when the receipt OCR detects a supplier name not in the database, Ledgr creates it automatically and selects it on the form.
- **Statement Reconciliation** (new): `/reconcile` screen accessible from a supplier's detail page. Photograph or upload the supplier's ledger/statement; Gemini extracts every line item; Ledgr compares against its own records and shows three lists: **Matched**, **On statement — missing from Ledgr** (with one-tap Import), **In Ledgr — not on statement**. Backend endpoint: `POST /api/ai/reconcile-statement`.
