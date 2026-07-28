# Ledgr — Technical Blueprint

> A complete, code-accurate reference for rebuilding **Ledgr** from scratch.
> Ledgr is a standalone, offline-first bookkeeping app for small businesses.
> Everything below is derived directly from the source in `frontend/`.

---

## 1. Overview & Philosophy

Ledgr is an **Expo / React Native / TypeScript** bookkeeping app aimed at small businesses — shops, service providers, retailers, IT consultants, salons, handymen, and freelancers.

Four pillars define the product:

1. **Standalone / no backend.** There is no server. `src/api.ts` is a thin local wrapper over `src/db/local.ts`, which persists to the device via `@react-native-async-storage/async-storage`. (A `backend/` folder exists at the repo root but the mobile app never calls it — the app is fully self-contained.)
2. **On-device data.** Every collection is a JSON array stored under a namespaced AsyncStorage key (`ledgr:*`). Backups are just JSON files shared via the OS share sheet.
3. **AI-fast.** AI features (voice entry, receipt OCR, statement reconciliation, "Ask about your books") call the LLM **directly from the phone** using the user's **own API key**. A multi-provider router (`src/db/ai.ts`) supports Gemini, OpenAI, Anthropic, OpenRouter, and any custom OpenAI-compatible endpoint.
4. **Multi-persona.** Onboarding picks one of **7 business types**; the dashboard tile grid adapts (e.g. service businesses hide Inventory).

Design language: a deep-green brand (`#1C4030`), light/dark/system theming, card-based UI, KPI tiles, gifted-charts for bar/line/pie visualizations, and WhatsApp/PDF sharing throughout.

---

## 2. Tech Stack & Dependencies

**Runtime:** Expo SDK **54** · React Native **0.81.5** · React **19.1.0** · TypeScript **5.9.3** · New Architecture enabled (`newArchEnabled: true`).

Exact dependency versions from `package.json`:

| Package | Version | Purpose |
|---|---|---|
| `expo` | 54.0.35 | Core SDK |
| `expo-router` | 6.0.24 | File-based routing |
| `react` / `react-dom` | 19.1.0 | React |
| `react-native` | 0.81.5 | RN core |
| `@react-native-async-storage/async-storage` | 2.2.0 | **Data layer persistence** |
| `expo-secure-store` | 15.0.8 | Keychain for secrets (storage util) |
| `react-native-gifted-charts` | 1.4.77 | Bar / Line / Pie charts |
| `react-native-svg` | 15.12.1 | Chart rendering dep |
| `expo-linear-gradient` | 15.0.8 | Dashboard hero gradient |
| `expo-camera` | ~17.0.10 | Receipt scanning |
| `expo-image-picker` | ~17.0.11 | Photo capture / upload |
| `expo-audio` | ~1.1.1 | Voice recording |
| `expo-file-system` | ~19.0.23 | Base64 read, backup files |
| `expo-document-picker` | ~14.0.8 | Import backups / PDF statements |
| `expo-print` | ~15.0.8 | Invoice / summary PDF generation |
| `expo-sharing` | ~14.0.8 | Native share sheet |
| `expo-haptics`, `expo-blur`, `expo-image`, `expo-symbols`, `expo-splash-screen`, `expo-status-bar`, `expo-constants`, `expo-font`, `expo-linking`, `expo-web-browser`, `expo-system-ui` | (see package.json) | UI / platform |
| `@expo/vector-icons` | 15.1.1 | Ionicons |
| `@gorhom/bottom-sheet` | 5.2.14 | Bottom sheets |
| `react-native-gesture-handler` | 2.28.0 | Gestures |
| `react-native-reanimated` | 4.1.1 | Animation |
| `react-native-worklets` | 0.5.1 | Reanimated worklets |
| `react-native-safe-area-context` | 5.6.0 | Safe areas |
| `react-native-screens` | 4.16.0 | Native screens |
| `react-native-webview` | 13.15.0 | Web views |
| `react-native-web` | 0.21.0 | Web target |
| `date-fns` 4.1.0 / `dayjs` 1.11.13 | | Date formatting |

**Dev:** `eslint` 9.25.0, `eslint-config-expo` 10.0.0, `expo-doctor` 1.19.8, `@types/react` 19.1.10.
**Package manager:** Yarn 1.22.22. **Resolutions:** `@eslint/plugin-kit` 0.3.4, `postcss` 8.5.10, `uuid` 11.1.1.

**tsconfig:** extends `expo/tsconfig.base`, `strict: true`, path alias `@/*` → `./*`.
**metro.config.js:** on-disk `FileStore` cache, `maxWorkers: 2`.

---

## 3. Architecture

### Data flow (writes & reads)

```
UI screen (app/**)
   │  calls
   ▼
api  (src/api.ts)        ← thin, stateless facade
   │  delegates
   ▼
db   (src/db/local.ts)   ← business logic + report engine
   │  read/write JSON
   ▼
AsyncStorage             ← keys "ledgr:<collection>", plus "ledgr:settings"
```

### AI flow

```
UI screen (voice / ask / bill-form / reconcile)
   │  api.parseCommand / ocrReceipt / transcribe / reconcileStatement / askBooks
   ▼
api.ts  →  getAIConfig()  (reads provider/key/model/baseUrl from AsyncStorage)
   ▼
ai.ts   (src/db/ai.ts)    ← multi-provider router
   ▼
call() → callGemini | callOpenAI | callAnthropic
   ▼
fetch()  → provider HTTPS endpoint  (user's own API key)
```

Key architectural rules encoded in the code:

- **Write serialization.** All mutating ops in `local.ts` chain onto a single `writeChain` promise via `serialize()` to prevent lost-update races between rapid read-modify-write sequences.
- **Two-phase cross-collection writes.** `createInvoice`/`deleteInvoice`/`markInvoicePaid` run *separate* `serialize()` calls for the invoice write and the debtor-ledger sync — deliberately, to avoid self-deadlock on the single write chain.
- **`api.ts` is stateless** and simply forwards to `db.*` and `ai.*`; the only logic it owns is the JS-side statement-reconciliation matcher and API-key stripping on backup export/import.
- **Config vs. data separation.** The AI provider config lives under its own AsyncStorage keys (`ai_provider`, `ai_api_key`, `ai_model`, `ai_base_url`) — *not* inside the `ledgr:settings` blob — with legacy-key migration from the old Gemini keys.

---

## 4. Data Model

All collections are JSON arrays. Keys defined in `local.ts`:

```
ledgr:suppliers  ledgr:bills  ledgr:sales  ledgr:payments
ledgr:inventoryChecks  ledgr:periods  ledgr:settings
ledgr:expenses  ledgr:debtors  ledgr:invoices
```

IDs: `` `${Date.now()}-${Math.random().toString(36).slice(2,10)}` ``. Timestamps: `new Date().toISOString()`. All monetary amounts are stored as raw numbers; currency is a *display* concern only (internally treated as USD — `toUsd()` just coerces to Number).

### Settings (`ledgr:settings`, object not array)

`getSettings()` returns defaults merged over stored values:

```ts
{
  googleApiKey: string,            // legacy; AI key now lives in ai_* keys
  managerCommissionPct: number,    // default 0.0
  currentPeriodStart: string,      // 'YYYY-MM-DD', default '1970-01-01'
  openingInventory: number,        // default 0
  openingCash: number,             // default 0
  openingCapital: number,          // combined partner investment, default 0
  partnerNames: string[],          // default [] (empty)
  extraAssets: {name:string,amount:number}[],
  extraLiabilities: {name:string,amount:number}[],
  currency: string,                // default 'USD' (15 supported)
  taxLabel: 'None'|'GST'|'VAT'|'Sales Tax'|'HST'|'PST'|'Custom',
  taxLabelCustom: string,
  taxRate: number,
  businessName, businessAddress, businessPhone, businessEmail, paymentDetails: string,
  hasOnboarded: boolean,           // onboarding gate
  businessType: string,            // one of the 7 personas
}
```

Supported currencies (`CURRENCIES`): USD $, INR ₹, EUR €, GBP £, AED د.إ, CAD CA$, AUD A$, NGN ₦, KES KSh, ZAR R, BDT ৳, PKR ₨, PHP ₱, MXN MX$, BRL R$.

### Supplier (`ledgr:suppliers`)

```ts
{ id, name, phone, notes, created_at }
```

`listSuppliers()` enriches each with computed `billsTotal`, `paymentsTotal`, and `balance = billsTotal − paymentsTotal` (payments filtered to `type === 'supplier_payment'`). `getSupplier(id)` additionally returns date-sorted `bills` and `payments` arrays.

### Bill (`ledgr:bills`) — a vendor purchase

```ts
{ id, supplierId, date, amount, currency, paymentType:'cash'|'credit',
  invoiceNo, notes, photo /* base64 */, created_at }
```

### Sale (`ledgr:sales`) — customer revenue

```ts
{ id, date, amount, currency, notes, paymentType?, created_at }
```

### Payment (`ledgr:payments`) — supplier payment OR partner drawing

```ts
{ id, date, amount, currency,
  type: 'supplier_payment' | 'drawing',
  supplierId?,     // when supplier_payment
  partnerName?,    // when drawing
  method,          // 'cash'|'bank'|'mobile' (free text)
  reference?, notes, created_at }
```

### Inventory check (`ledgr:inventoryChecks`)

```ts
{ id, date, expectedStock, actualStock, variance /* actual − expected */, notes, created_at }
```

### Period (`ledgr:periods`) — a closed accounting period snapshot

```ts
{ id, startDate, endDate, openingInventory, openingCash,
  totalSales, totalPurchases, grossProfit, managerCommissionPct,
  commission, drawings, supplierPayments, netProfit,
  closingInventory, closingCash, notes, closed_at }
```

### Expense (`ledgr:expenses`)

```ts
{ id, date, category, amount, notes, created_at }
```

### Debtor (`ledgr:debtors`) — a customer who owes money

```ts
{ id, name, phone, notes,
  payments: { id, amount, date, notes?, created_at }[],
  invoices: { id, invoiceNumber, date, amount, status }[],
  created_at }
```

### Invoice (`ledgr:invoices`)

```ts
{ id, invoiceNumber /* 'INV-0001' */, status:'unpaid'|'paid',
  clientName, clientPhone?, date, dueDate?,
  lines: { description, qty, rate }[],
  notes?, taxLabel?, taxRate?, total, paidAt?, created_at }
```

Invoice numbering: `createInvoice` scans existing `INV-####` numbers, takes the max sequence and increments, zero-padded to 4 digits — so deletes/imports never collide.

---

## 5. Accounting Engine

The accounting model is **locked**. It uses **periodic inventory** (physical stock counts drive COGS, not per-item tracking).

### Core formulas

```
COGS         = opening stock + purchases − closing stock        (periodic inventory)
GrossProfit  = Sales − COGS
Commission   = GrossProfit × commission%      (only if GrossProfit > 0)
NetProfit    = GrossProfit − Commission − Expenses [− Drawings]
PartnerShare = NetProfit / 2
Capital      = openingCapital + share − Drawings   (per-partner drawings, combined investment pool)
```

Two functions compute profit with subtle differences — document both:

**`dashboard()`** — current-period, period-anchored (uses `currentPeriodStart`). COGS here is proxied by **totalPurchases** (not a full stock reconstruction), and Drawings is subtracted:

```
grossProfit = totalSales − totalPurchases
commission  = grossProfit > 0 ? grossProfit × pct/100 : 0
netProfit   = grossProfit − commission − drawings
cash        = openingCash + totalSales − supplierPayments − drawings
inventoryValue = latest inventory check actualStock in period, else openingInventory
liabilities = totalPurchases − supplierPayments + commission
assets      = cash + inventoryValue + extraAssetsTotal
totalLiabilities = liabilities + extraLiabTotal
netWorth    = assets − totalLiabilities
openingBalance = openingCash + openingInventory
closingBalance = assets
```
Only bills/sales/payments with `date >= currentPeriodStart` are included. `salesTrend` = last 7 daily sales totals.

**`pnlRange(from, to)`** — the *true* periodic-inventory P&L over an arbitrary date range:

```
openingStock = actualStock of latest inventory check strictly BEFORE `from`
               (else settings.openingInventory)
closingStock = actualStock of latest inventory check on/before `to`
               (else falls back to openingStock)
hasClosingCount = at least one check on/before `to`
cogs   = hasClosingCount ? (openingStock + purchases − closingStock) : purchases
grossProfit = revenue − cogs
commission  = grossProfit > 0 ? grossProfit × pct/100 : 0
netProfit   = grossProfit − commission − expenses − drawings
```
Note: before the first stock take, COGS falls back to purchases so profit isn't overstated.

### Worked example (pnlRange with a stock count)

Opening stock $2,000 · Purchases $5,000 · Closing stock $2,500 · Sales $9,000 · commission% 10 · Expenses $800 · Drawings $1,000:

```
COGS        = 2000 + 5000 − 2500 = 4500
GrossProfit = 9000 − 4500        = 4500
Commission  = 4500 × 10%         = 450
NetProfit   = 4500 − 450 − 800 − 1000 = 2250
PartnerShare= 2250 / 2           = 1125 each
```

### Capital statement (`capitalStatement()`)

```
closingCapital = openingCapital + netProfit − totalDrawings
```
Per-partner drawings are attributed by matching `payment.partnerName` (case-insensitive) against `settings.partnerNames`; unmatched → `otherDrawings`. Returns `{ openingCapital, netProfit, totalDrawings, closingCapital, partners:[{name,drawings}], otherDrawings }`.

### Reports built on top of `dashboard()`

- **`pnl()`** — `{ revenue, cogs, grossProfit, managerCommissionPct, commission, drawings, netProfit }`.
- **`balanceSheet()`** — `assets{cash, inventory, extra[], total}`, `liabilities{suppliersPayable, extra[], total}`, `equity` (= netWorth).
- **`trialBalance()`** — debits `[Cash, Inventory, Purchases, Drawings]`, credits `[Sales Revenue, Suppliers Payable]`.
- **`drawingsHistory()`** — every `type:'drawing'` payment with partner attribution, newest first.
- **`monthlyProfitTrend(months=6)`** — array of `{month, label, profit}` calling `monthlySummary()` per month (chart data).
- **`assetDistribution()`** — pie slices `{label, value}` for Cash, Inventory, and each positive extra asset.
- **`creditorsReport(from?,to?)`** — per-supplier `{totalBilled, totalPaid, balance, transactions[]}`, sorted by balance desc.
- **`debtorsReport(from?,to?)`** — per-debtor `{totalInvoiced, totalPaid, balance}`, sorted by balance desc.
- **`monthlySummary(month 'YYYY-MM')`** — revenue, purchases, grossProfit, commission, drawings, netProfit, cashFlow (`revenue − supplierPayments − drawings − commission`), counts, top-5 suppliers, daily sales.
- **`dailySummary(date)`** — one day's revenue/purchases/grossProfit/supplierPayments/drawings, `netCash = revenue − supplierPayments − drawings`, and per-supplier bill breakdown.
- **`expectedInventory()`** — base (last audit `actualStock` or `openingInventory`) + purchases-since − sales-since.

### Period close (`closePeriod(actualStock, notes)`)

Snapshots the current `dashboard()` into `ledgr:periods`, writes a closing inventory check, then sets `currentPeriodStart` to *tomorrow* and carries `openingInventory = actualStock`, `openingCash = dashboard.cash` — rolling the balance forward.

### Backup / restore / reset

- **`exportBackup()`** — bundles all 9 collections + settings + `_meta{app:'ledgr', version:3, exportedAt}`. `api.exportBackup` strips `googleApiKey` and appends `geminiModel`.
- **`importBackup(data)`** — replace-mode; writes each array back and shallow-merges settings. `api.importBackup` deletes any leaked `googleApiKey` and restores the model name. Import UI validates `_meta.app === 'ledgr'`.
- **`resetAll()`** — wipes all 9 data collections but **preserves** settings (API key, partners, currency, tax, business profile, commission, extras, onboarding flag) and resets period pointers/opening balances to zero.

### Invoice ↔ Debtor sync (locked logic)

- **`createInvoice(inv)`** — Phase 1: create invoice with generated `INV-####`, `status:'unpaid'`. Phase 2 (separate `serialize`): if `clientName` present, find-or-create a debtor (normalized name match) and push `{id, invoiceNumber, date, amount:total, status:'unpaid'}` into `debtor.invoices`.
- **`markInvoicePaid(id)`** — sets invoice `status:'paid'`, `paidAt`. Then syncs: finds the matching entry in every debtor's `invoices`, flips it to `paid`, and appends a matching payment `{amount:inv.amount, date:today, notes:'Invoice … paid'}` so the outstanding balance settles.
- **`deleteInvoice(id)`** — deletes the invoice, then (separate `serialize`) removes its reference from any debtor's `invoices`.
- **`overdueInvoices()`** — `status==='unpaid' && dueDate < today`.

---

## 6. Feature Catalog (screens & routes)

Routing is **expo-router** file-based. `app/_layout.tsx` wraps everything in `ErrorBoundary → GestureHandlerRootView → SafeAreaProvider → ThemeProvider → ThemedStack`, registers all Stack screens (modals: bill-form, supplier-form, sale-form, payment-form, inventory-form, voice; cards: monthly-summary, reconcile, invoices, expenses, debtors, daybook, ask, onboarding), hides the splash after fonts load or a 5s safety timeout, and constrains width to 480px on wide web.

| Route | File | What it does |
|---|---|---|
| `/` | `app/index.tsx` | **Onboarding gate.** Reads `settings.hasOnboarded`; redirects to `/(tabs)` or `/onboarding`. |
| `/onboarding` | `app/onboarding.tsx` | 3-step wizard: business type (7 personas) → business name → currency; sets `hasOnboarded`, `businessType`, preset `taxLabel`. |
| `/(tabs)` | `app/(tabs)/_layout.tsx` | Bottom tabs: Home, Bills, Partners, Reports, Settings, Staff. Renders a floating `VoiceFab`. |
| `/(tabs)` → Home | `app/(tabs)/index.tsx` | **Dashboard**: net-profit hero (gradient), Profit Flow breakdown, shareable daily summary card (WhatsApp) with day navigation, KPI tiles (Sales/Purchases/Cash/Inventory), persona-filtered app grid, sales-trend BarChart. |
| Bills tab | `app/(tabs)/bills.tsx` | List of vendor bills (supplier name, date, cash/credit, amount); tap → edit. |
| Partners tab | `app/(tabs)/suppliers.tsx` | Supplier list with avatar initials + running balance (Owed/Settled). |
| Reports tab | `app/(tabs)/reports.tsx` | 7 segments: P&L, Balance, Trial, Capital, Drawings, Creditors, Debtors + date-range presets (This Month / Last Month / This Quarter / This Year / All Time). LineChart (profit trend), PieChart (asset distribution), WhatsApp reminders for creditors/debtors. |
| Settings tab | `app/(tabs)/settings.tsx` | AI provider picker + key + model (+ base URL for custom) + Test Connection; Backup/Restore (export & share / import file); appearance (light/dark/system); commission %; opening capital; partners (add/remove); custom assets & liabilities; business profile; currency (15); tax label + rate; Danger Zone reset. |
| Staff tab | `app/(tabs)/employee-report.tsx` | **Employee report**: inventory-flow "should-rest-in-shop" statement per current or closed period, with a toggle to reveal Net Profit & commission. |
| `/bill-form` | `app/bill-form.tsx` | Create/edit a bill; **Scan/Upload receipt → OCR** auto-fills supplier (find-or-create), amount, invoice #, date. |
| `/sale-form` | `app/sale-form.tsx` | Create/edit a daily sale (date, amount, notes). |
| `/payment-form` | `app/payment-form.tsx` | Create/edit a payment: supplier_payment (pick supplier) or drawing (pick partner chip / type name), method, notes. |
| `/inventory-form` | `app/inventory-form.tsx` | Stock audit: shows expected value, enter actual, live variance; also **Close Period & Carry Forward**. |
| `/expenses` | `app/expenses.tsx` | Expense list + add/edit/delete (category, amount, date, notes). |
| `/debtors` | `app/debtors.tsx` | Debtor list + detail (balance, invoiced/paid, payment timeline); record payment; WhatsApp reminder. |
| `/invoices` | `app/invoices.tsx` | Invoice list + create/edit (line items, tax from settings), detail view, **PDF via expo-print**, WhatsApp share, mark paid, overdue banner. |
| `/daybook` | `app/daybook.tsx` | Unified transaction ledger (sales, bills, payments, drawings, expenses, invoices) grouped by date with daily in/out totals. |
| `/monthly-summary` | `app/monthly-summary.tsx` | Month picker → KPI grid, top suppliers; share as text or **PDF**. |
| `/ask` | `app/ask.tsx` | **Ask about your books** chat. Builds a data snapshot, calls `askBooks`, renders answer, and on a proposed `action` shows a confirm dialog then applies it. |
| `/voice` | `app/voice.tsx` | **AI voice entry**: record → transcribe → parseCommand → draft → confirm & save (bill/sale/supplier_payment/drawing/inventory). |
| `/reconcile` | `app/reconcile.tsx` | Photo/image/**PDF** of a supplier statement → AI extract → matched / missing-in-Ledgr (one-tap import) / not-on-statement. |
| `/supplier/[id]` | `app/supplier/[id].tsx` | Supplier statement: balance, bills+payments timeline, add bill/pay, reconcile, edit. |
| `/supplier-form` | `app/supplier-form.tsx` | Create/edit/delete supplier. |

Shared UI (`src/components/UI.tsx`): `ScreenHeader`, `Card`, `KpiTile`, `Row`, `Divider`, `Empty`. Theme via `src/context/ThemeContext.tsx` (`useTheme`, `useThemeMode`, persisted `theme_mode`). Formatting helpers in `src/theme.ts`: `fmt(n, symbol='$')` (2-dp `toLocaleString`), `getCurrencySymbol(code)` (re-exported from local.ts), `shortDate(iso)`.

---

## 7. AI Layer

### Config (`AIConfig`)

```ts
type ProviderId = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'custom';
interface AIConfig { provider: ProviderId; apiKey: string; model: string; baseUrl?: string; }
```

Stored under AsyncStorage keys `ai_provider`, `ai_api_key`, `ai_model`, `ai_base_url`. `getAIConfig()` migrates legacy `gemini_api_key`/`gemini_model` and falls back to `settings.googleApiKey`; default model `gemini-2.0-flash-001`.

### Providers (`PROVIDERS`)

| id | label | default base URL | default model | api family | vision | audio |
|---|---|---|---|---|---|---|
| gemini | Google Gemini | `…/v1beta` (generativelanguage) | gemini-2.0-flash-001 | gemini | ✓ | ✓ |
| openai | OpenAI (GPT) | `https://api.openai.com/v1` | gpt-4o-mini | openai | ✓ | ✗ |
| anthropic | Anthropic (Claude) | `https://api.anthropic.com/v1` | claude-3-5-sonnet-latest | anthropic | ✓ | ✗ |
| openrouter | OpenRouter | `https://openrouter.ai/api/v1` | google/gemini-2.0-flash-001 | openai | ✓ | ✗ |
| custom | Custom (OpenAI-compatible) | (user-supplied) | (user-supplied) | openai | ✓ | ✗ |

### Transport

`call(cfg, prompt, parts?, jsonSchema?)` dispatches by api family:

- **`callGemini`** — POST `…/models/{model}:generateContent?key=…`; `generationConfig.temperature=0`; if a schema is passed, sets `responseMimeType:'application/json'` + `responseSchema`. Images/audio go as `inlineData{mimeType,data(base64)}` parts.
- **`callOpenAI`** — POST `{base}/chat/completions`, `Authorization: Bearer`, `temperature:0`; images become `image_url` data URLs; schema → `response_format:{type:'json_object'}`. OpenRouter adds `HTTP-Referer` + `X-Title` headers. **Audio not supported inline.**
- **`callAnthropic`** — POST `{base}/messages`, `x-api-key`, `anthropic-version:2023-06-01`, `max_tokens:2048`; images as `{type:'image',source:{base64…}}`; JSON requested via prompt suffix.

`parseJson()` strips ```` ```json ```` fences and slices to the outer `{…}` before `JSON.parse`.

### Functions

- **`testKey(cfg)`** — sends "Reply with the single word: OK"; returns `{ok, reply}`.
- **`parseCommand(cfg, text)`** — voice-command NLU → JSON `{intent:'bill'|'sale'|'supplier_payment'|'drawing'|'inventory'|'unknown', date, amount, currency, supplierName, partnerName, paymentType, notes, summary}` (schema-constrained; today's date injected).
- **`ocrReceipt(cfg, imageBase64, mimeType)`** — receipt extraction → `{supplierName, date, amount, currency, invoiceNo, rawText}`.
- **`transcribe(cfg, audioBase64, mimeType)`** — **Gemini-only** (throws a helpful 400 for other providers) → `{transcript}`.
- **`reconcileStatementAI(cfg, imageBase64, mimeType)`** — statement OCR → `{supplierName, entries:[{date, amount, type:'bill'|'payment'|'unknown', description, reference}], totalOnStatement}`. The **JS matcher** lives in `api.ts`: matches on ±3 days and ≤1% amount tolerance, producing `{matched, missingInLedgr, notOnStatement}`.
- **`askBooks(cfg, question, dataContext)`** — returns `{answer, action}` where `action` is `null` or a **proposed** change.

### Confirm-and-apply pattern (`askBooks`)

The model may propose **one** action from: `add_expense`, `add_sale`, `add_bill`, `add_debtor`, `add_debtor_payment`, `create_invoice`, each with a one-line `confirm` string. The app **never auto-writes** — `app/ask.tsx` pops an `Alert` ("Apply this change?") and only on **Apply** runs `applyAction()`, which calls the corresponding `api.create*`. Missing required fields → the model must ask in `answer` and set `action:null`. The prompt embeds an `APP_GUIDE` (so it can explain the app) and an `ACTION_SPEC`; the data snapshot is a JSON of cash/inventory/netWorth/YTD P&L/top creditors/debtors/expenses-by-category/open invoices.

The **original direct Gemini implementation** survives at `src/db/gemini.ts` (same schemas, hard-coded `generativelanguage` base URL) — superseded by the multi-provider `ai.ts` but kept for reference.

---

## 8. Business-Type Personas

Chosen during onboarding (`app/onboarding.tsx`), stored as `settings.businessType`. Each carries a default tax label:

| key | label | default tax |
|---|---|---|
| `shop` | Shop / Retail | GST |
| `service` | Service Business | VAT |
| `it_consultant` | IT Consultant | VAT |
| `freelancer` | Freelancer | VAT |
| `salon` | Salon / Spa | VAT |
| `handyman` | Handyman / Contractor | VAT |
| `vendor` | Vendor / Trader | GST |

Dashboard tile visibility (`HIDDEN_TILES` in `app/(tabs)/index.tsx`):

| persona | hidden tiles |
|---|---|
| `service` | inventory |
| `salon` | inventory |
| `handyman` | inventory |
| `it_consultant` | inventory, bills, suppliers |
| `freelancer` | inventory, bills, suppliers |
| `shop` / `vendor` | *(none — full grid)* |

Full tile set: Purchases(bills), Sales, Payments, Creditors(suppliers), Invoices, Debtors, Expenses, Inventory, Day Book, Reports, Monthly Report, Ask AI, AI Assistant(voice). Rationale (from code comments): service personas hold no stock; pure-service personas (IT/freelancer) lean on Invoices+Debtors over supplier Purchases/Creditors.

---

## 9. Build & Deploy

**App identity** (`app.json`): name **Ledgr**, slug `frontend`, version 1.0.0, portrait, scheme `frontend`, `userInterfaceStyle:'automatic'`, `newArchEnabled:true`. iOS `bundleIdentifier` and Android `package` are both **`com.mbell.ledgr`**. Android permissions: `CAMERA`, `RECORD_AUDIO`, `INTERNET`; adaptive icon background `#1C4030`; `edgeToEdgeEnabled`. Plugins: expo-router, expo-audio, expo-camera, expo-image-picker, expo-splash-screen. `experiments.typedRoutes: true`. Web bundler metro, output `single`.

**CI build** — `.github/workflows/build-apk.yml` ("Build Ledgr AI Android"), triggers on push to main/master and `workflow_dispatch`:

1. Checkout → setup Node 20 → setup Java **JDK 17 (temurin)** → setup Android SDK.
2. `yarn install --frozen-lockfile` (in `frontend`).
3. `npx expo prebuild --platform android --no-install` (generates the native android project).
4. Generate a self-signed release keystore (`ledgr-release.keystore`, alias `ledgr`, passwords `ledgr123`) via `keytool`.
5. Append `MYAPP_RELEASE_*` to `gradle.properties`, then run `scripts/ci-sign.py` which patches `android/app/build.gradle` to add a `release` signingConfig and switch release builds from the debug key.
6. `./gradlew assembleRelease` and `./gradlew bundleRelease`, both `-PreactNativeArchitectures=arm64-v8a`.
7. Upload artifacts **Ledgr-AI-APK** (`…/apk/release/*.apk`) and **Ledgr-AI-AAB** (`…/bundle/release/*.aab`), 30-day retention.

Local dev scripts (`package.json`): `start` (`expo start`), `android`, `ios`, `web`, `lint`, `reset-project`; a `preinstall` cmd-guard runs `scripts/cmd-guard.js`.

---

## 10. Rebuild-From-Scratch Checklist

1. **Scaffold.** `npx create-expo-app` with the expo-router template; set Expo SDK 54, RN 0.81.5, React 19.1.0, TypeScript strict, `@/*` path alias. Enable New Architecture and `typedRoutes`.
2. **Install deps** exactly as §2 (async-storage, gifted-charts, svg, linear-gradient, camera, image-picker, audio, file-system, document-picker, print, sharing, secure-store, vector-icons, gesture-handler, reanimated, worklets, safe-area-context, screens).
3. **Configure `app.json`** — name Ledgr, package/bundle `com.mbell.ledgr`, permissions CAMERA/RECORD_AUDIO/INTERNET, splash + adaptive icon `#1C4030`, plugins list.
4. **Theme** — build `src/theme.ts` (light/dark palettes, spacing/radius/font scales, `fmt`, `shortDate`) and `src/context/ThemeContext.tsx` (persist `theme_mode`; `useTheme`/`useThemeMode`).
5. **Data layer** — implement `src/db/local.ts`: the `KEYS` map, `serialize()` write-chain, `readColl`/`writeColl`, `getSettings`/`updateSettings` with all defaults, `uuid`/`nowIso`, `CURRENCIES`/`TAX_LABELS`/`getCurrencySymbol`.
6. **CRUD** — suppliers (with enriched balances), a `makeCrud()` factory for bills/sales/payments, inventory (`expectedInventory`, `createInventory`, `closePeriod`), expenses, debtors (`addDebtorPayment`), invoices (numbering + debtor sync in `createInvoice`/`markInvoicePaid`/`deleteInvoice`).
7. **Report engine** — `dashboard`, `pnl`, `pnlRange` (periodic COGS), `balanceSheet`, `trialBalance`, `capitalStatement`, `drawingsHistory`, `monthlyProfitTrend`, `assetDistribution`, `monthlySummary`, `dailySummary`. Match the exact formulas in §5.
8. **Backup** — `exportBackup`/`importBackup` (`_meta.version:3`, replace mode) and `resetAll` (preserve settings). Add `src/utils/share.ts` (`shareJsonFile`, `pickJsonFile`, `sharePlainText`) with web/native branches.
9. **AI router** — `src/db/ai.ts`: `AIConfig`, `PROVIDERS`, `call`/`callGemini`/`callOpenAI`/`callAnthropic`, `parseJson`, and the public functions (`testKey`, `parseCommand`, `ocrReceipt`, `transcribe`, `reconcileStatementAI`, `askBooks` with `APP_GUIDE` + `ACTION_SPEC` + confirm-and-apply).
10. **API facade** — `src/api.ts`: `getAIConfig`/`setAIConfig` (+ legacy shims), the JS reconciliation matcher, and the `api` object forwarding to `db.*`/`ai.*` (stripping the API key on export/import).
11. **Navigation** — `app/_layout.tsx` (ErrorBoundary, providers, ThemedStack, splash timeout, 480px web cap), `app/index.tsx` (onboarding gate), `app/(tabs)/_layout.tsx` (6 tabs + VoiceFab).
12. **Onboarding** — `app/onboarding.tsx` with the 7 personas + tax presets + currency step.
13. **Screens** — build all screens in §6, wiring persona tile-hiding on the dashboard.
14. **AI screens** — voice (record→transcribe→parse→confirm), ask (snapshot→askBooks→confirm dialog→applyAction), bill-form OCR, reconcile (image/PDF).
15. **Sharing/PDF** — invoice + monthly-summary PDF via `expo-print`, WhatsApp deep links (`whatsapp://send?phone=…&text=…`).
16. **CI** — add `.github/workflows/build-apk.yml` and `scripts/ci-sign.py` for signed APK/AAB (arm64-v8a).
17. **Verify** — onboarding → add supplier → add bill/sale → run an inventory count → check dashboard net profit and Reports P&L match the §5 worked example → export/import a backup round-trip → configure an AI key, Test Connection, and try a voice entry + "Ask about your books" action.

---

## Roadmap: Accounting document completeness (CA-audit, ranked)

Confirmed by CA gap-analysis. Build order, verify (tsc + jest) between each:
1. **Receipts** — DONE. `receipts` collection, 3 modes, Cash Book bridge, derived invoice status, RCPT-####.
2. **Invoice revenue → P&L** — DONE. `settings.accountingBasis` cash/accrual toggle, basis-aware dashboard + pnlRange.
3. **Quote/Estimate** — DONE. `quotes` (QUO-####), non-posting, converts to invoice.
4. **Advance/Deposit receipts** — DONE. `advance` mode + getAdvanceCredit/applyAdvanceToInvoice (no double-count), debtor "Apply Deposit" UI.
5. **Credit/Debit Notes** — DONE. `creditNotes`/`debitNotes` (CN-/DN-####), fold into debtor balance+statement+accrual revenue, debtor-screen UI.
6. **Delivery Note/Challan** — DONE. `deliveryNotes` (DC-####), goods movement, no ledger, PDF challan.

Cross-cutting (DONE): scan-to-entry (camera/image) on receipts+invoices; customer statement compare (reconcile party='customer'); voice+AI actions (create_receipt/create_quote) + app-guide coverage.

Enhanced reporting (DONE): Tax report (GST/VAT output−input), Sales Register, Receipts Register — new segments in reports.tsx.

Backup format at v8. Test suite: 86 passing across 11 suites.

## Roadmap: Multiple Books (multi-account) — deferred track, non-destructive

Two distinct needs:
- **Multi-persona (one business, mixed activity):** change `settings.businessType` → `businessTypes: string[]`; dashboard `HIDDEN_TILES` becomes a UNION across selected personas. Same money pot, one P&L.
- **Multiple Books (separate sets of accounts, e.g. 2 retail points):** namespace storage. The ONLY seam is the key prefix in `backend.ts` (`ledgr:${c}` → `ledgr:${bookId}:${c}`, and `ledgr:settings` → `ledgr:${bookId}:settings`) + SQLite table/column. `local.ts` (all accounting logic) needs NO change — it only talks through the 4 backend primitives.
  - Phase 1: add `activeBook.ts` (default `"default"`); namespace keys; non-destructive migration adopts existing `ledgr:*` data as the "default" book. App behaves identically — shippable.
  - Phase 2: Books registry at `ledgr:__books__` `[{id,name,businessType,currency,createdAt}]`; Settings → "My Books" (new/rename/switch/delete biometric-gated); header book switcher; per-book backup/restore.
  - Phase 3 (optional): "All Books" consolidated dashboard; per-book logo/taxRegNo.
  - Rule of thumb: same money pot → multi-persona (one book); separate P&L → separate Books.

---

*End of blueprint. Source of truth: the `frontend/` tree — `src/db/local.ts`, `src/db/ai.ts`, `src/api.ts`, plus the `app/` screens.*
