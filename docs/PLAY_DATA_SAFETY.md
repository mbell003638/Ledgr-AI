# Google Play Data Safety Worksheet

Review this worksheet against the final Play Console form and every enabled production feature before submission.

## App behavior

- Local-first accounting storage; no developer-operated backend.
- No advertising, analytics SDK, or cross-app tracking.
- Android operating-system backup is disabled.
- User-created JSON backups are explicit exports and are not encrypted by the app.
- Optional AI actions send user-selected content directly to the provider configured by the user.

## Data categories to declare

When AI features are available in the published build, conservatively disclose that the following data may leave the device for app functionality:

- Financial information: accounting records and relevant report context.
- Personal information: customer, supplier, investor, or business contact details present in the selected context.
- Photos and videos: receipt or document images selected for scanning.
- Audio: voice recordings created for transcription.
- Files and documents: documents selected for analysis.
- User-generated content: questions and command text sent to an AI provider.

The transfer is user-initiated, optional, encrypted in transit through HTTPS, and used for app functionality. Confirm whether the Play Console classifies each direct provider transfer as collection, sharing, or an applicable user-action exception; answer conservatively and consistently with the final UI and provider configuration.

## Data not used by Ledgr

- No ads or advertising profile.
- No analytics or crash-reporting SDK currently included.
- No sale of user data.
- No precise location collection.
- No contacts-address-book access.

## Required pre-submission checks

1. Publish the privacy policy at a stable public HTTPS URL.
2. Put that URL in Play Console and, if required, in the in-app store listing.
3. Recheck dependency and permission changes before every release.
4. Verify every AI provider used in production supports HTTPS and review its privacy terms.
5. Keep screenshots and Play declarations aligned with the released binary.
