# Ledgr — Complete Implementation Blueprint

> **Purpose:** Give this document to any AI (Claude, GPT, Gemini, etc.) or developer, and they should be able to rebuild the entire app from scratch. Every architectural decision, data model, endpoint, screen, and third-party integration is documented here.

---

## 1. Product Overview

**Ledgr** is a mobile-first (also runs on laptop web) shop accounting app for small shop owners. Inspired by Odoo's modular apps and Vocash/Dext AI receipt assistants. Single-user, no auth. Two currencies: **USD** and **CDF** (Franc Congolese) with an editable exchange rate.

### Core value props
1. **Odoo-style modular home** with app tiles (Bills, Sales, Payments, Partners, Inventory, Reports, AI Assistant, Monthly Report, Settings)
2. **AI voice assistant** — dictate transactions like "Sold 250 today", "Paid Rahim 1000 USD"
3. **AI receipt OCR** — scan or upload a receipt photo; supplier/date/amount are auto-extracted; new suppliers auto-created
4. **AI statement reconciliation** — photograph a supplier's statement/ledger; app extracts every line item and compares against internal records, flagging matches/missing/extras
5. **Backup & Restore** — export JSON, share via WhatsApp/email, import on any other device (cross-device sync without cloud auth)
6. **Financial reports** — P&L, Balance Sheet, Trial Balance + monthly summary with **share as PDF** and daily-summary WhatsApp share widget
7. **Full dark mode** with light/dark/system toggle

---

## 2. Tech Stack

| Layer | Choice | Version |
|---|---|---|
| Mobile framework | Expo (React Native) | SDK 54 |
| Routing | expo-router (file-based) | 6.x |
| Backend | FastAPI (Python) | 0.117+ |
| Database | MongoDB (Motor async driver) | 6+ |
| AI | Google Gemini API (direct) via `google-genai` SDK | 1.20.0, model **`gemini-3.5-flash`** |
| Voice recording | expo-audio | 1.1+ |
| Camera / gallery | expo-camera, expo-image-picker | 17 / 17 |
| Charts | react-native-gifted-charts + react-native-svg | 1.4 / 15 |
| Share / files | expo-sharing, expo-print, expo-document-picker, expo-file-system/legacy | 14 / 15 / 14 / — |
| Icons | @expo/vector-icons (Ionicons) | bundled |
| Storage | @react-native-async-storage/async-storage | bundled |

**Frontend routes are file-based**, all under `/app/frontend/app/`. Backend all routes prefixed with `/api`.

---

## 3. Data Model (MongoDB collections)

All documents have a UUID `id` field. Timestamps are ISO strings in UTC.

### `suppliers`
```ts
{
  id: string,          // uuid
  name: string,
  phone?: string,
  notes?: string,
  created_at: string,  // ISO
}
```

### `bills` (vendor purchases)
```ts
{
  id: string,
  supplierId: string,
  date: "YYYY-MM-DD",
  amount: number,
  currency: "USD" | "CDF",
  rate: number,                    // FC rate captured at time of entry
  paymentType: "credit" | "cash",
  invoiceNo?: string,
  notes?: string,
  photo?: string,                  // base64 (optional)
  ocrText?: string,
  created_at: string,
}
```

### `sales`
```ts
{
  id: string,
  date: "YYYY-MM-DD",
  amount: number,
  currency: "USD" | "CDF",
  rate: number,
  notes?: string,
  created_at: string,
}
```

### `payments` (supplier payments + partner drawings)
```ts
{
  id: string,
  date: "YYYY-MM-DD",
  amount: number,
  currency: "USD" | "CDF",
  rate: number,
  type: "supplier_payment" | "drawing",
  supplierId?: string,     // present if type=supplier_payment
  partnerName?: string,    // present if type=drawing
  method: string,          // "cash" | "bank" | "mobile" | free text
  reference?: string,
  notes?: string,
  created_at: string,
}
```

### `inventoryChecks`
```ts
{
  id: string,
  date: "YYYY-MM-DD",
  expectedStock: number,   // USD value auto-computed
  actualStock: number,     // physical count USD value
  variance: number,        // actual - expected
  notes?: string,
  created_at: string,
}
```

### `settings` (single doc with `_id: "app"`)
```ts
{
  googleApiKey: string,    // user's Gemini API key
  fcRate: number,          // 1 USD = fcRate CDF (default 2500)
}
```

**Rules:**
- Never expose `_id` in responses — always project it out (`{"_id": 0}`)
- Always store amounts in their original currency; convert to USD only in aggregate calculations using `to_usd(amount, currency, rate)`

---

## 4. Currency Conversion Utility (backend)

```python
def to_usd(amount, currency, rate):
    if currency == "USD":
        return float(amount)
    r = rate or fc_rate or 1.0
    return float(amount) / r if r else 0.0
```

Every aggregate endpoint (dashboard, reports, supplier balances) uses this to normalize amounts to USD.

---

## 5. Complete API Reference (all under `/api`)

### Settings
| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | `/settings` | — | `{googleApiKey, fcRate}` |
| PUT | `/settings` | `{googleApiKey?, fcRate?}` | updated doc |
| POST | `/settings/test-key` | header: `x-gemini-api-key` | `{ok, reply}` or 400 |

### Suppliers
| Method | Path | Notes |
|---|---|---|
| GET | `/suppliers` | list, each includes `balance`, `billsTotal`, `paymentsTotal` (auto-calculated in USD) |
| POST | `/suppliers` | `{name, phone?, notes?}` |
| GET | `/suppliers/{id}` | includes `bills[]`, `payments[]`, `balance`, `billsTotal`, `paymentsTotal` |
| PUT | `/suppliers/{id}` | `{name, phone?, notes?}` |
| DELETE | `/suppliers/{id}` | |

### Bills
| Method | Path |
|---|---|
| GET | `/bills` |
| POST | `/bills` |
| PUT | `/bills/{id}` |
| DELETE | `/bills/{id}` |

Body for POST/PUT:
```ts
{ supplierId, date, amount, currency, rate, paymentType, invoiceNo?, notes?, photo?, ocrText? }
```

### Sales
| Method | Path |
|---|---|
| GET | `/sales` |
| POST | `/sales` — `{date, amount, currency, rate, notes?}` |
| PUT | `/sales/{id}` |
| DELETE | `/sales/{id}` |

### Payments
| Method | Path |
|---|---|
| GET | `/payments` |
| POST | `/payments` — see `payments` schema above |
| PUT | `/payments/{id}` |
| DELETE | `/payments/{id}` |

### Inventory
| Method | Path | Notes |
|---|---|---|
| GET | `/inventory` | list |
| GET | `/inventory/expected` | returns `{expected, lastAudit, purchasesSince, salesSince}` — computes expected = lastActualStock + purchases − sales since last audit |
| POST | `/inventory` | `{date, expectedStock, actualStock, notes?}` — server computes `variance = actual - expected` |
| DELETE | `/inventory/{id}` | |

### Dashboard & Reports
| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard` | `{assets, liabilities, netWorth, cash, inventoryValue, totalPurchases, totalSales, grossProfit, drawings, supplierPayments, suppliers, salesTrend[]}` — 7-day trend |
| GET | `/reports/pnl` | `{revenue, cogs, grossProfit, drawings, netProfit}` |
| GET | `/reports/balance-sheet` | `{assets:{cash, inventory, total}, liabilities:{suppliersPayable, total}, equity}` |
| GET | `/reports/trial-balance` | `{debits[], credits[]}` |
| GET | `/reports/monthly-summary?month=YYYY-MM` | full monthly stats + top suppliers + daily series |
| GET | `/reports/daily-summary?date=YYYY-MM-DD` | single-day KPI card data |

### Backup
| Method | Path | Notes |
|---|---|---|
| GET | `/backup/export` | Full DB dump: `{suppliers, bills, sales, payments, inventoryChecks, settings, _meta:{app:"ledgr", version:1, exportedAt}}` |
| POST | `/backup/import` | `{...collections, mode: "replace"|"merge"}` — replace wipes + inserts, merge upserts by id |

### AI (all require Gemini key via header `x-gemini-api-key` or saved in settings.googleApiKey — return 401 if missing)
| Method | Path | Purpose |
|---|---|---|
| POST | `/ai/parse-command` | `{text}` → structured intent JSON `{intent, date, amount, currency, supplierName?, partnerName?, paymentType?, notes, summary}` |
| POST | `/ai/ocr-receipt` | `{imageBase64, mimeType}` → `{supplierName, date, amount, currency, invoiceNo, rawText}` |
| POST | `/ai/transcribe` | `{audioBase64, mimeType}` → `{transcript}` |
| POST | `/ai/reconcile-statement` | `{imageBase64, mimeType, supplierId?}` → `{extracted, matched[], missingInLedgr[], notOnStatement[]}` |

**AI implementation pattern:**
```python
from google import genai
from google.genai import types as gtypes

client = genai.Client(api_key=key)
resp = client.models.generate_content(
    model="gemini-3.5-flash",
    contents=[prompt, gtypes.Part.from_bytes(data=img, mime_type=mime)],
    config=gtypes.GenerateContentConfig(
        temperature=0,
        response_mime_type="application/json",
        response_schema=SCHEMA_DICT,
    ),
)
data = json.loads(resp.text)
```

`response_schema` uses standard JSON Schema — see `server.py` for `PARSE_SCHEMA`, `OCR_SCHEMA`, `TRANSCRIBE_SCHEMA`, `STATEMENT_SCHEMA`.

---

## 6. Reconciliation Algorithm

Given extracted entries (list of `{date, amount, type, description, reference}`) and our records for the same supplier:

```python
def match(entry, pool):
    # Tolerant match: dates within ±3 days AND amount within 1%
    e_date, e_amt = parse(entry.date), float(entry.amount)
    for o in pool:
        o_date, o_amt = parse(o.date), float(o.amount)
        if abs((e_date - o_date).days) > 3: continue
        if abs(o_amt - e_amt) / max(e_amt, 1) > 0.01: continue
        return o
    return None
```

Returns 3 lists to the client:
- **matched**: found in both
- **missingInLedgr**: on statement, not in our books (with an Import button)
- **notOnStatement**: in our books, not on statement (potential dispute)

---

## 7. Frontend Architecture

### File tree (relevant files only)
```
/app/frontend/
├── app.json                        # Expo config (name: "Ledgr", permissions, plugins)
├── package.json                    # dependencies
├── app/
│   ├── _layout.tsx                 # Root: SafeAreaProvider + ThemeProvider + Stack
│   │                               # On web >=768px width, wraps app in 480px centered column
│   ├── index.tsx                   # Redirect to /(tabs)
│   ├── (tabs)/
│   │   ├── _layout.tsx             # 5 bottom tabs + VoiceFab FAB
│   │   ├── index.tsx               # Dashboard — hero, daily-summary widget, KPIs, app tiles, sales trend
│   │   ├── bills.tsx               # Bills list (tap row to edit, FAB adds new)
│   │   ├── suppliers.tsx           # Partners list (balance badges)
│   │   ├── reports.tsx             # P&L / Balance / Trial Balance segmented
│   │   └── settings.tsx            # Gemini key + FC rate + backup/restore + appearance
│   ├── bill-form.tsx               # Add/edit bill (scan + upload buttons, OCR auto-creates supplier)
│   ├── supplier-form.tsx           # Add/edit partner
│   ├── sale-form.tsx               # Add/edit sale
│   ├── payment-form.tsx            # Add/edit payment (supplier or drawing)
│   ├── inventory-form.tsx          # Physical audit entry with variance auto-calc
│   ├── supplier/[id].tsx           # Partner detail: balance + timeline (bills+payments) + reconcile btn
│   ├── monthly-summary.tsx         # Month picker, KPIs, top suppliers, share text/PDF
│   ├── voice.tsx                   # Voice recorder → transcribe → parse → confirm → save
│   └── reconcile.tsx               # Camera/upload → statement OCR → 3 comparison lists
├── src/
│   ├── theme.ts                    # lightColors, darkColors, spacing, radius, fmt(), shortDate()
│   ├── api.ts                      # api.<method>() wrapper around fetch with x-gemini-api-key header
│   ├── context/ThemeContext.tsx    # ThemeProvider, useTheme(), useThemeMode()
│   ├── components/
│   │   ├── UI.tsx                  # ScreenHeader, Card, KpiTile, Row, Divider, Empty
│   │   └── VoiceFab.tsx            # Floating mic button
│   ├── utils/
│   │   └── share.ts                # sharePlainText, shareJsonFile, pickJsonFile (mobile+web)
│   └── hooks/use-icon-fonts.ts     # Font preload (existing Emergent helper)
```

### Design tokens
Palette (light):
- surface `#F6F7F5`, surfaceSecondary `#FFFFFF`, surfaceTertiary `#EAECE7`
- onSurface `#111513`, muted `#8A938E`
- brandPrimary `#1C4030` (sage green), brandSecondary `#4A6E5C`, brandTertiary `#D6E5DB`
- success `#2D6B45`, warning `#B87A1E`, error `#B83A2E`
- border `#E2E5DF`

Palette (dark): sage-on-charcoal, background `#0E1210`.

Spacing: 4, 8, 12, 16, 24, 32, 48. Radius: 6, 12, 20, 999.

### Dark mode implementation
- `ThemeContext` holds `mode: 'light'|'dark'|'system'`, persisted to AsyncStorage as `theme_mode`
- Every screen: `const theme = useTheme(); const styles = useMemo(() => makeStyles(theme), [theme]);`
- `makeStyles(theme)` is defined at module scope, returns `StyleSheet.create({...})`
- **CRITICAL**: helper components declared outside the main component must receive `theme` and `styles` as props (e.g. `RowKV`, `DKV`, `StatCell`) — otherwise you get a runtime `ReferenceError: Property 'styles' doesn't exist`

### Web/laptop support
- `app.json` has `"web": { "bundler": "metro", "output": "single" }`
- `_layout.tsx` uses `useWindowDimensions()`; when width ≥ 768 on web, wraps in a centered 480 px column with drop shadow
- `share.ts` provides cross-platform helpers: uses `navigator.share` on web, `expo-sharing` on mobile; uses `<input type=file>` on web, `expo-document-picker` on mobile

---

## 8. Environment Variables

### Backend `/app/backend/.env`
```
MONGO_URL=mongodb://localhost:27017
DB_NAME=ledgr
```

### Frontend `/app/frontend/.env`
```
EXPO_PUBLIC_BACKEND_URL=https://<preview-or-prod-url>
```
Emergent-managed (do not modify):
```
EXPO_TUNNEL_SUBDOMAIN=...
EXPO_PACKAGER_HOSTNAME=...
EXPO_PACKAGER_PROXY_URL=...
```

---

## 9. Implementation Plan (Phased)

### Phase 1 — Foundation (backend + settings + suppliers)
1. Scaffold FastAPI with Motor + MongoDB
2. Add settings CRUD + `/settings/test-key` (call Gemini with "Reply OK")
3. Add suppliers CRUD (auto-compute `balance` from bills − payments)
4. Frontend: expo-router with 5 tabs, ThemeProvider (light+dark), Settings screen with Gemini key input

### Phase 2 — Transactions (bills, sales, payments, inventory)
1. Add bills/sales/payments/inventory CRUD endpoints
2. Frontend forms with USD/CDF currency toggle
3. Supplier detail page with timeline
4. Add PUT endpoints from day one so edit is native, not bolted on

### Phase 3 — Dashboard & reports
1. `/api/dashboard`, `/api/reports/pnl`, `/balance-sheet`, `/trial-balance`, `/monthly-summary`, `/daily-summary`
2. Dashboard hero + KPI grid + tiles + sales-trend chart
3. Reports segmented view
4. Monthly summary screen with **share as PDF** via `expo-print` + `expo-sharing`
5. Daily quick-summary widget on dashboard with **WhatsApp share** button

### Phase 4 — AI (Gemini direct API)
1. `/api/ai/parse-command` — text → intent JSON (voice command NLP)
2. `/api/ai/ocr-receipt` — image → supplier/amount/date auto-fill
3. `/api/ai/transcribe` — audio → transcript
4. Voice screen: record via expo-audio → base64 → transcribe → parse → confirm → save
5. Bill form: Scan + Upload buttons → OCR → auto-create supplier if new

### Phase 5 — Reconciliation
1. `/api/ai/reconcile-statement` — image + supplierId → extract line items → match algorithm → 3 lists
2. Reconcile screen with camera/upload → 3 sections (matched, missing, extras) with per-item Import button

### Phase 6 — Cross-device sync
1. `/api/backup/export` (full JSON dump) + `/api/backup/import` (replace/merge modes)
2. Settings backup card: Export → share JSON via WhatsApp; Import → pick file → restore
3. Cross-platform share helper (`src/utils/share.ts`)

### Phase 7 — Polish
1. Full dark mode (context + useMemo(makeStyles) pattern)
2. Laptop/web centered layout
3. Rebrand from initial name to final ("Ledgr")

---

## 10. Gemini Integration (Direct API)

**Model:** `gemini-3.5-flash` (previous `gemini-2.5-flash` was deprecated May 2026 for new users).

**Key acquisition:** User obtains an API key from https://aistudio.google.com/apikey and pastes it in Settings.

**Request flow:**
1. Frontend stores key in AsyncStorage (`gemini_api_key`)
2. Every API request sends header `x-gemini-api-key: <key>`
3. Backend also stores key in `settings.googleApiKey` as fallback
4. Backend helper `get_api_key(header)` — prefers header, falls back to settings, raises 401 if neither

**Structured output:** Every AI call uses `response_mime_type="application/json"` + a `response_schema` (JSON schema dict). This eliminates prompt-engineered JSON parsing errors.

**Multi-modal:**
- Text: pass `contents=prompt_string`
- Text + image: `contents=[prompt, gtypes.Part.from_bytes(data=img_bytes, mime_type="image/jpeg")]`
- Text + audio: same pattern with `mime_type="audio/m4a"`

---

## 11. Build & Deploy Notes

### Development
- Backend: `uvicorn server:app --host 0.0.0.0 --port 8001`
- Frontend: `yarn expo start --port 3000` (Metro bundler)
- MongoDB: local instance (default connection)

### Production build (via Emergent)
- User clicks **Publish** → deploys to Emergent cloud with production URL
- User then clicks **Generate Android build** → Emergent produces an APK
- Or **Generate iOS build** → produces `.ipa` for TestFlight
- Emergent manages the Expo EAS build backend; user doesn't need own Expo/EAS account

### Permissions (app.json)
```json
"ios": {
  "infoPlist": {
    "NSCameraUsageDescription": "Scan receipts to auto-fill vendor bills",
    "NSMicrophoneUsageDescription": "Dictate transactions hands-free",
    "NSPhotoLibraryUsageDescription": "Attach receipt photos to bills"
  }
},
"android": {
  "permissions": ["CAMERA", "RECORD_AUDIO"]
}
```

---

## 12. Testing

Run backend regression: `pytest backend/tests/ -v` → should give **60/60 passing** covering CRUD, aggregates, backup, PUT, and AI 401/400 flows.

---

## 13. Extension Ideas (roadmap parking lot)

- **Multi-user auth + cloud sync** — replaces manual JSON backup
- **Chat-style AI assistant** (voice + text combined) with persistent history — the natural next step; agent calls tool functions to query/mutate data
- **Product SKU inventory** — track stock by item, not lump USD value
- **Multi-currency support** beyond USD/CDF
- **Auto FC-rate fetch** from a public FX API
- **Recurring bills / subscriptions**
- **Push notifications** for outstanding-balance reminders (Emergent-managed, requires deployed build)

---

## 14. Key Design Decisions & Gotchas

1. **`_id` exclusion** — always project `{"_id": 0}` in Motor queries; never spread a MongoDB doc unmodified into a response
2. **`datetime.now(timezone.utc)`**, not `datetime.utcnow()`
3. **Dark mode helper components** must receive `theme` and `styles` as props (see Section 7)
4. **Expo File System** — use `expo-file-system/legacy` for the classic `readAsStringAsync` API; the new File API in SDK 54 is different
5. **`gemini-3.5-flash`** — not `2.5-flash` (deprecated for new users)
6. **Share on web** — use `navigator.share` with clipboard fallback; on mobile use `expo-sharing`
7. **Document picker** — dynamic import (`await import("expo-document-picker")`) to avoid loading on web where it isn't needed
8. **Font preload** — Emergent's `useIconFonts` hook + `SplashScreen.preventAutoHideAsync()` must remain in `_layout.tsx` for Ionicons to render on Android

---

## End of blueprint

Companion file: `ledgr-source.tar.gz` (full source archive, excludes `node_modules`, `.git`, `.expo`).
