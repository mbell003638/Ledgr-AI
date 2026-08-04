# Ledgr AI — Standalone Offline Shop Accounting

A single-user, on-device shop accounting app. **No backend server. No login. Works fully offline.**
Data lives on the phone (AsyncStorage). The only network calls are optional AI features
(voice/OCR) that go **directly** to Google Gemini using your own API key.

## Features

- Suppliers, bills, sales, payments, inventory
- Dashboard, P&L, balance sheet, trial balance, monthly/daily summaries
- Period close & carry-forward
- **Backup / Restore** — export all data as a JSON file, share via WhatsApp, import on another device
- AI (optional): voice-command entry, receipt OCR, statement reconciliation (Google Gemini)
- USD-only currency
- Light / dark / system theme

## Data & privacy

- All accounting data is stored locally on the device via AsyncStorage.
- Nothing is uploaded to any server we run — there is no server.
- The Gemini API key is stored locally and **stripped from backup files** before sharing.

## AI setup (optional)

1. Get a free Gemini API key at [aistudio.google.com](https://aistudio.google.com).
2. Open the app → **Settings** → paste the key → **Test API Key**.
3. Without a key, all non-AI features still work fully offline.

## Backup / Restore

- **Export & Share** (Settings): writes `ledgr-backup-YYYY-MM-DD.json` and opens the share
  sheet — pick WhatsApp, Drive, email, etc.
- **Import File** (Settings): pick a previously exported backup to restore. This **replaces**
  current data; after import, pull-to-refresh or reopen a screen to see restored records.

Backups include the **full double-entry (V2) ledger** — the chart of accounts and every
journal entry — in addition to the record collections (suppliers, bills, sales, payments,
inventory, invoices, etc.). Restoring re-hydrates the complete accounting state so reports
(P&L, balance sheet, trial balance) reconcile exactly as they did on the source device. The
Gemini API key is still **stripped** from the exported file before sharing.

## Building the APK / AAB

Builds run in **GitHub Actions** via `.github/workflows/build-apk.yml`. The
workflow is **manually dispatched** (Actions tab → *Build Ledgr AI Android* →
*Run workflow*). Type-check and unit tests run first as a `test` job; the build
job only starts if they pass.

1. Trigger the workflow from the **Actions** tab.
2. Wait for the green check (~15–25 min).
3. Open the run → **Artifacts**:
   - `Ledgr-AI-APK` — installable `.apk` for sideloading / testing on your phone.
   - `Ledgr-AI-AAB` — `.aab` bundle for **Google Play Store** upload.

> If no release keystore secret is configured, the artifacts are named
> `Ledgr-AI-APK-testsigned` / `Ledgr-AI-AAB-testsigned` — see **Release signing**
> below.

### Installing the APK on your phone

1. Download and unzip the `Ledgr-AI-APK` artifact.
2. Transfer the `.apk` to your phone (WhatsApp/Drive/USB).
3. Enable "Install unknown apps" for your file manager, then tap the `.apk`.

## Release signing

⚠️ **Google Play requires every update to be signed with the same key forever.**
If you ship with a throwaway key you can never update the app. The workflow supports
two signing modes and picks automatically based on whether the release keystore
secrets are present.

### Play-Store signing (persistent keystore)

Configure these four **repository secrets** (Settings → Secrets and variables →
Actions). When all four are present, the workflow decodes your keystore and signs
the APK/AAB with it, and the artifacts are named `Ledgr-AI-APK` / `Ledgr-AI-AAB`.

| Secret | What it is |
| --- | --- |
| `RELEASE_KEYSTORE_B64` | Base64 of your persistent `.keystore` file |
| `RELEASE_KEY_ALIAS` | The key alias inside the keystore |
| `RELEASE_STORE_PASSWORD` | The keystore (store) password |
| `RELEASE_KEY_PASSWORD` | The key password |

Generate a keystore once and base64-encode it:

```
keytool -genkeypair -v -keystore ledgr-release.keystore \
  -alias ledgr -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 ledgr-release.keystore   # paste output into RELEASE_KEYSTORE_B64
```

Keep the original `.keystore` file and passwords backed up somewhere safe and
**out of the repo** — losing them means you can never update the published app.
Secret values are consumed via the runner's `env:` mapping and are never printed
to the build log.

### Test-signed fallback (no secrets configured)

If the secrets above are **not** set, the workflow still produces installable
builds by generating a throwaway keystore at build time, but it:

- prints a prominent `⚠ TEST-SIGNED BUILD — NOT for Play Store …` warning, and
- suffixes the artifacts as `Ledgr-AI-APK-testsigned` / `Ledgr-AI-AAB-testsigned`.

**Never upload a `-testsigned` build to the Play Store.** These are for
sideloading and QA only. Configure the four secrets before your first store upload.

## Package identifier

`com.ahem.ledgrai` — the Android `package` and iOS `bundleIdentifier` (in
`frontend/app.json`). Set once; **cannot be changed** after the first Play Store
upload.

## Local development

```
cd frontend
npm install       # or yarn
npx expo start    # Metro dev server (debug)
```

Note: a **debug** build needs the Metro server running. The **release** APK/AAB embeds the
JS bundle and runs standalone with no server.
