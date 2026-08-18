# Google Play Release Checklist

This checklist is for the current Ledgr Android application. An APK sideload test is not proof that the Play AAB is ready.

## Repository-verified configuration

- [x] Android ID is com.ahem.ledgrai.codexsol, separate from Fable5-Opus.
- [x] Display version is 1.0.0 and Android versionCode is 1.
- [x] Expo SDK 54 / React Native 0.81 targets and compiles against Android API 36.
- [x] Android OS backup is disabled.
- [x] Configured permissions are camera, microphone/audio support and internet; no location, contacts, SMS, call-log or broad-storage permission is configured.
- [x] Expo `blockedPermissions` strips READ/WRITE_EXTERNAL_STORAGE and SYSTEM_ALERT_WINDOW from the merged manifest. Confirm the signed AAB in App Bundle Explorer.
- [x] Camera, gallery and microphone access is requested when the related feature is invoked.
- [x] Build workflow is manual-only.
- [x] An AAB is created only when all permanent signing secrets are present.
- [x] Test output is named Ledgr-AI-APK-testsigned and must not be uploaded to Play.
- [x] Privacy policy and Data Safety working documents exist.
- [x] Settings includes a Privacy & Data link.

## Owner action: identity, account and signing

- [ ] Confirm com.ahem.ledgrai.codexsol and Ledgr are permanent.
- [ ] Complete Play Console identity verification and any Android developer verification registration required for the account.
- [ ] Create one permanent upload keystore and archive it and its passwords in at least two secure locations.
- [ ] Add RELEASE_KEYSTORE_B64, RELEASE_KEY_ALIAS, RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD as GitHub Actions secrets.
- [ ] Enroll in Play App Signing and retain upload-key recovery information.
- [ ] Ensure versionCode exceeds every artifact previously uploaded for this application ID.

## Automated QA gate

From `frontend/`:

```
npm run qa:release
```

That command is the Play-release software gate: Android package / backup / permission checks, ESLint, Expo Doctor, production `npm audit`, TypeScript, and the full Jest suite. Ansible is not used; this is a Node gate, not server provisioning.

A green gate is necessary and not sufficient. Device smoke, a signed AAB, and Play Internal testing remain owner steps below.

## Build and binary verification

- [ ] Manually dispatch Build Ledgr AI Android when ready.
- [ ] Confirm the run says Play-Store signed and produces Ledgr-AI-AAB.
- [ ] Never upload a test-signed artifact.
- [ ] Inspect the AAB in App Bundle Explorer and confirm target SDK 36, version code, package ID and merged permissions.
- [ ] Install and smoke-test the matching release APK on a physical Android device.
- [ ] Review the Play pre-launch report.

## Functional smoke test

- [ ] Enter opening cash, inventory, named assets, named liabilities and investor capital.
- [ ] Verify the Balance Sheet balances and opening inventory is not counted twice in COGS.
- [ ] Record cash in/out and verify Cash Book, P&L and Balance Sheet.
- [ ] Record sales, purchases, customer receipts, supplier payments, advances, assets and liabilities.
- [ ] Close a period with manager commission, partially settle the payable and verify reports.
- [ ] Export and restore a backup; verify all books and V2 ledgers.
- [ ] Clear accounting data and verify all parties, investors, transactions, periods and V2 rows are removed.
- [ ] Verify App Lock at startup and after background/restore.
- [ ] Test camera, gallery, microphone, PDF/share and enabled AI providers on the release build.
- [ ] Verify permission denial and re-request behavior.

## Owner action: listing and policy

- [ ] Publish docs/PRIVACY_POLICY.md at a stable public HTTPS URL controlled by the developer.
- [ ] Replace the in-app GitHub policy link if a different final URL is chosen.
- [ ] Complete Data Safety using docs/PLAY_DATA_SAFETY.md and the final AAB, including enabled AI-provider transfers.
- [ ] Complete the Financial features declaration. Ledgr records finances but does not provide loans, banking, investing, money transfer, insurance, crypto or payment processing.
- [ ] Complete content rating, target audience, ads and app-access declarations.
- [ ] Finalize docs/PLAY_STORE_LISTING.md and supply current screenshots and a feature graphic.
- [ ] Confirm support and privacy contacts are monitored.
- [ ] Upload first to Internal testing and promote gradually.
