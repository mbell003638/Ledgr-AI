# Ledgr Codex — Local-First Business Accounting

Ledgr Codex is a mobile accounting app for small businesses. It keeps its authoritative double-entry books in on-device SQLite, works without a developer-operated backend, and can be used offline for all non-AI features.

## Features

- Sales, purchases, invoices, receipts, payments, expenses, inventory, assets and liabilities
- Cash Book, P&L, Balance Sheet, Trial Balance, partner capital and period-close reports
- Dynamic opening balances for cash, stock, named assets, named liabilities and investor capital
- Retail-partnership periods with physical inventory close and manager commission payable
- Multiple business books and configurable feature sets
- JSON backup and restore of the full accounting state
- Optional AI-assisted voice entry, OCR, reconciliation and questions about the books
- Multiple display currencies and light, dark or system theme

## Storage, privacy and AI

- The authoritative accounting ledger is stored locally in SQLite. AsyncStorage remains for preferences, compatibility and fallback paths.
- There is no Ledgr-operated backend, advertising SDK, analytics SDK or cross-app tracking.
- AI is optional. The user chooses Google Gemini, Anthropic, OpenRouter, or a custom HTTPS-compatible endpoint.
- AI requests go directly from the device to the selected provider when the user invokes an AI action.
- The AI API key is stored in the device secure credential store and excluded from exported backups.
- Android operating-system backup is disabled. User-created JSON backups are readable and should be handled securely.

See docs/PRIVACY_POLICY.md, docs/PLAY_DATA_SAFETY.md and docs/PLAY_RELEASE_CHECKLIST.md.

## Android identity

Current Codex Android identity:

- Display name: Ledgr Codex
- Application ID: com.ahem.ledgrai.codexsol
- Public version: 1.0.0
- Android version code: 1

The Codex ID intentionally differs from Fable5-Opus so both builds can be installed on one device. Confirm this permanent ID before the first Play upload; it cannot be changed after publication. The independent iOS bundle identifier is com.ahem.ledgrai.

## Android build workflow

.github/workflows/build-apk.yml is manual-only. A normal push does not start the APK/AAB workflow.

Before building, configure a permanent upload keystore through these GitHub repository secrets:

| Secret | Purpose |
| --- | --- |
| RELEASE_KEYSTORE_B64 | Base64-encoded permanent upload keystore |
| RELEASE_KEY_ALIAS | Alias inside the keystore |
| RELEASE_STORE_PASSWORD | Keystore password |
| RELEASE_KEY_PASSWORD | Key password |

With all four secrets, the workflow produces a release APK and Play-uploadable AAB. Without them, it creates only a throwaway test-signed APK named Ledgr-AI-APK-testsigned; it does not create an AAB.

Never upload a test-signed artifact to Google Play. Store the original keystore and passwords outside the repository in at least two secure recovery locations.

## Local verification

From the frontend directory run:

    npm ci
    npx tsc --noEmit
    npm run lint:ci
    npx jest --ci --runInBand
    npx expo-doctor
    npm audit --omit=dev --audit-level=high

For local development:

    cd frontend
    npm ci
    npx expo start

A release APK/AAB embeds the JavaScript bundle and does not require Metro.
