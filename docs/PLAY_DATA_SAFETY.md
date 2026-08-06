# Google Play Data Safety Worksheet

Review this worksheet against the final Android App Bundle and the exact Play Console questions. The developer is responsible for the final declaration.

## Verified behavior

- Accounting records are stored locally; Ledgr has no developer-operated backend.
- No advertising, analytics, crash-reporting or cross-app tracking SDK is included.
- Android operating-system backup is disabled.
- User-created JSON backups are explicit exports and are not encrypted by the app.
- AI credentials are stored in the device secure credential store and excluded from backups.
- Optional AI actions send selected content directly to the configured provider over HTTPS.
- Camera, photo/document and microphone access is initiated by the user.
- No location, address-book, SMS, call-log or broad-storage access is configured.

## Local data

The app can store financial records, party names and contact details, invoices, receipts, inventory, images/documents, voice recordings and preferences. Ordinary local accounting use does not send this data to Ledgr or a Ledgr-operated server.

An explicit JSON export sends the backup through the Android share destination selected by the user. That destination then handles the file under its own terms.

## Optional AI-provider transfer

Conservatively review these categories because the user may send them directly to an external AI provider:

- Financial information: records, transactions, balances and report context.
- Personal information: names, phone numbers, email addresses or other party details in selected content.
- Photos: selected receipt or document images.
- Audio: recordings created for transcription.
- Files and documents: statements or documents selected for analysis.
- User-generated content: questions, commands and notes.

Purpose: app functionality.
Initiation: optional and user-triggered.
Transport: HTTPS for supported production endpoints.
Retention and deletion: controlled by the selected AI provider and the user's provider account.

Do not automatically answer that no data is collected merely because Ledgr has no backend. Google Play requires third-party handling to be considered. Decide whether each provider transfer is collected, shared, or covered by a user-action exception using the current Play Console wording.

## Expected negative declarations, subject to final-AAB review

- No ads or advertising profile.
- No sale of user data.
- No location.
- No address-book contacts.
- No health data.
- No browsing history.
- No installed-app inventory.
- No advertising ID use identified in current dependencies.

## Before submission

1. Publish the policy at a stable public HTTPS URL and link it in Play Console and the app.
2. Inspect final dependencies and merged AAB permissions in App Bundle Explorer.
3. Review every enabled AI provider's privacy terms, retention controls and HTTPS endpoint.
4. Show clear disclosure immediately before any sensitive transfer users may not reasonably expect.
5. Keep screenshots, listing copy, policy and declarations aligned with the binary.
6. Repeat this review whenever a provider, SDK, permission or data flow changes.
