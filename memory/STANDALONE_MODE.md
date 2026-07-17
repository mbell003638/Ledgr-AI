# Ledgr — Standalone Mode (No Backend)

**Since v2.0, Ledgr runs entirely on-device.** No server, no MongoDB, no deployment cost.

## Architecture
- All accounting data (suppliers, bills, sales, payments, inventory, periods, settings) lives in AsyncStorage under `ledgr:*` keys
- All business logic (dashboard aggregates, P&L, balance sheet, monthly summary, daily summary, reconciliation matching, period close, backup/restore, reset) runs in TypeScript on the device (`src/db/local.ts`)
- Google Gemini AI (voice parsing, receipt OCR, transcription, statement reconciliation) is called **directly** from the app to `https://generativelanguage.googleapis.com/v1beta` using the user's API key stored in AsyncStorage (`src/db/gemini.ts`)
- The `src/api.ts` module exposes the same `api.*` interface as before — every screen still calls `api.listSuppliers()`, `api.dashboard()`, etc. Only the implementation moved from HTTP fetch to local functions
- The FastAPI backend is retained as a no-op stub at `/app/backend/server.py` (archived original in `/app/backend/_archived/server.py`) to keep Emergent's supervisor happy

## What this means for you
- **No hosting cost, no deploy step for the server** — click Publish → generate APK/IPA → install → app works
- **Fully offline** except when using Gemini AI features (voice, OCR, reconciliation)
- **Cross-device sync** = Backup Export JSON → share via WhatsApp → Import on other device (already built)
- **Gemini API key** is stored in AsyncStorage and included in the app's requests. Anyone who reverse-engineers your APK could extract it. Solution: remove the key from Settings before publishing the APK, or set it per-device after install.

## Gemini model
- Uses `gemini-flash-latest` alias, so it always picks the current best flash model without a code change.
