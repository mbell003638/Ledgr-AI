# Vocash — Odoo-Inspired Shop Accounting Suite (PRD)

## Overview
A mobile-first accounting app for small shop owners, inspired by Odoo's modular apps and Vocash/Dext AI assistants. Single-user, no auth. USD + Franc Congolese (CDF) supported with an editable FC exchange rate.

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
