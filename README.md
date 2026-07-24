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

## Building the APK / AAB

Builds run automatically in **GitHub Actions** on every push to `main`
(`.github/workflows/build-apk.yml`).

1. Push to `main` (or trigger the workflow manually from the Actions tab).
2. Wait for the green check (~15–25 min).
3. Open the run → **Artifacts**:
   - `Ledgr-AI-APK` — installable `.apk` for sideloading / testing on your phone.
   - `Ledgr-AI-AAB` — `.aab` bundle for **Google Play Store** upload.

### Installing the APK on your phone

1. Download and unzip the `Ledgr-AI-APK` artifact.
2. Transfer the `.apk` to your phone (WhatsApp/Drive/USB).
3. Enable "Install unknown apps" for your file manager, then tap the `.apk`.

### Signing (important for Play Store)

The CI currently generates a **fresh keystore each build** for testing convenience.
**Before your first Play Store upload**, you must switch to a **persistent keystore**:

1. Generate one locally:
   ```
   keytool -genkeypair -v -keystore ledgr-release.keystore \
     -alias ledgr -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Base64-encode it and store it as a GitHub **secret** (e.g. `RELEASE_KEYSTORE_B64`),
   plus secrets for the store/key passwords.
3. Update the workflow to decode the secret instead of generating a throwaway key.

⚠️ **Google Play requires every update to be signed with the same key forever.**
If you publish with a throwaway key you will not be able to update the app. Set up the
persistent keystore first. (Ask and this can be wired up for you.)

## Package identifier

`com.mbell.ledgr` — set once; cannot be changed after the first Play Store upload.

## Local development

```
cd frontend
npm install       # or yarn
npx expo start    # Metro dev server (debug)
```

Note: a **debug** build needs the Metro server running. The **release** APK/AAB embeds the
JS bundle and runs standalone with no server.
