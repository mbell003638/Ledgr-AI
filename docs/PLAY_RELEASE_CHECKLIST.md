# Google Play Release Checklist

## Identity and signing

- [ ] Confirm the permanent Android application ID. The current Codex build uses `com.ahem.ledgrai.codexsol` so it can coexist with Fable5-Opus.
- [ ] Create and securely archive the permanent upload keystore.
- [ ] Add `RELEASE_KEYSTORE_B64`, `RELEASE_KEY_ALIAS`, `RELEASE_STORE_PASSWORD`, and `RELEASE_KEY_PASSWORD` as GitHub repository secrets.
- [ ] Enroll in Play App Signing and retain secure recovery material.
- [ ] Never upload a `-testsigned` artifact to Google Play.

## Version and build

- [ ] Set the public version and ensure Android `versionCode` is greater than every prior upload.
- [ ] Run TypeScript, ESLint, Jest, Expo Doctor, and the production dependency audit.
- [ ] Dispatch the **Build Ledgr AI Android** GitHub workflow.
- [ ] Confirm the workflow identifies the build as Play-Store signed and produces an AAB.
- [ ] Install and smoke-test the matching release APK on a physical Android device.

## Functional smoke test

- [ ] Create a fresh book and enter opening cash, inventory, assets, liabilities, and investor capital.
- [ ] Verify Balance Sheet balances and opening inventory is not counted twice in COGS.
- [ ] Record cash in/out and verify Cash Book, P&L, and Balance Sheet.
- [ ] Record sales, purchases, customer receipts, supplier payments, advances, assets, and liabilities.
- [ ] Close a period with manager commission, settle part of the commission payable, and verify reports.
- [ ] Export and restore a backup; verify all books and V2 ledgers.
- [ ] Clear accounting data and verify parties, investors, transactions, periods, and V2 rows are removed.
- [ ] Enable App Lock, background/restore the app, and verify startup authentication.
- [ ] Test camera, gallery, microphone, PDF/share, and AI permission prompts only when invoked.

## Store listing and policy

- [ ] Publish `docs/PRIVACY_POLICY.md` at a stable public HTTPS URL.
- [ ] Complete Data Safety using `docs/PLAY_DATA_SAFETY.md` and the final binary.
- [ ] Complete content rating, target audience, ads declaration, app access, and financial-features declarations.
- [ ] Supply phone/tablet screenshots, icon, feature graphic, short description, and full description.
- [ ] Confirm support contact details and privacy-policy contact are monitored.
- [ ] Upload first to Internal testing, review pre-launch reports, then promote gradually.
