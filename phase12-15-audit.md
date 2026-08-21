# Specialist audit cycles: phases 12–15

**Branch:** `Manus`
**Scope:** Accounting, recovery, security, cross-platform QA, final release, and documentation review.
**Status:** Implementation findings closed; physical-device, clean-host, signing, and production-credential checks remain owner-controlled release dependencies.

## Phase 12 — Accounting integrity, sync safety, and recovery

The review rechecked client and server operation-level synchronization against double-entry balance, immutable history, period close, inventory, locations, POS/shop behavior, invoice allocation, duplicate replay, stale revisions, device sequences, epoch recovery, backup integrity, wrong-book protection, pending outbox recovery, and network failure behavior.

| Finding or control | Result | Evidence or remediation |
|---|---|---|
| Incompatible client could reach sync routes without an explicit negotiated version. | Closed | Client sends protocol/payload headers; server rejects mismatches with HTTP 426 before processing. |
| Unbalanced or historically mutating accounting operations. | Passed | Existing arbitration suite rejects unbalanced journals and historical overwrite, and accepts balanced journals. |
| Stale revisions, duplicate replay, and concurrent allocation. | Passed | Existing server tests cover idempotency, payload-hash reuse, stale aggregate revisions, invoice allocation, and concurrent settlement. |
| Location, stock, period-close, POS, and book boundaries. | Passed | Server-side operation authorization and accounting arbitration tests pass. |
| Backup corruption, wrong-book restore, and migration safety. | Passed | Existing encrypted-backup tests and migration contracts require integrity, recent verified backup, explicit publish/install, and no raw SQLite replacement. |

## Phase 13 — Security, identity, privacy, and self-host operations

The review checked OIDC issuer/audience/JWKS validation, bearer handling, device revocation, member roles, location scopes, CORS, request limits, rate limiting, secret files, logs, database exposure, backup handling, and user-owned deployment boundaries.

| Finding | Severity | Remediation | Status |
|---|---:|---|---|
| Generic preflight rejected wildcard CORS but did not reject an empty CORS origin. | Medium | Added an explicit non-empty `CORS_ORIGIN` requirement. | Closed |
| Upgrade flow did not reuse every deployment preflight check. | High | `upgrade.sh` now invokes `preflight.sh` before the pre-upgrade backup and rebuild. | Closed |
| Potential sensitive values in ordinary logs. | High check | Source audit found no token, password, authorization, or financial-payload logging patterns in the reviewed client/server paths. | Passed |
| Public database exposure. | High check | Compose profiles publish only HTTP/HTTPS through the edge; PostgreSQL has no host port. | Passed |
| Revoked-device or cross-location authorization bypass. | Critical check | Device revocation, role, book, and location-scope enforcement occurs server-side and is covered by tests. | Passed |
| Confusion between Ledgr-hosted service and self-hosting. | Medium | Deployment docs and migration UI explicitly state that the server is user-owned and a future hosted ERP is a separate product. | Closed |

## Phase 14 — Mobile, web, UX, accessibility, and device QA

The review checked local-only/private-sync navigation, migration states, queue and health status, conflict explanations, small-screen layout, keyboard-safe text entry, back navigation, and screen-reader labels.

| Finding | Remediation or limitation | Status |
|---|---|---|
| Migration and conflict actions needed explicit accessibility labels. | Added labels and button roles for migration, publish, install, Local-only return, and conflict resolution controls. | Closed |
| Offline status could be missed while working in another accounting screen. | Global compact sync-attention indicator links directly to Sync Health and appears only for queued, failed, or conflicted private-sync work. | Closed |
| Conflict inbox was too technical for business users. | Added business-language categories, accounting consequences, field differences, and explicit audited outcomes while retaining technical evidence. | Closed |
| Physical airplane-mode, background/foreground, TalkBack/VoiceOver, browser keyboard, and device-size validation. | Cannot be honestly simulated in this sandbox. The release checklist records these as required Android, iOS, and web owner-controlled tests. | Release dependency |

## Phase 15 — Final release, documentation, regression, and gap closure

The final review confirmed that roadmap documentation, deployment guides, release checklist, migration guide, health/operations surfaces, backup and restore procedures, conflict help, device enrollment, security boundaries, and audit records are present. All actionable findings from the four cycles above are closed or explicitly marked as owner-controlled release dependencies.

The final application and server regression matrix passed: strict lint, TypeScript compilation, full Jest, Expo Doctor, CI audit, web export, Android JavaScript bundle export, sync-server tests, deployment shell syntax, and Git whitespace checks. Docker startup, production PostgreSQL migrations, external OIDC, certificate issuance, backup/restore execution, physical devices, release signing, and Play Store submission remain the only checks requiring the owner’s infrastructure, credentials, or hardware.

## Audit exit decision

No critical implementation finding remains open in phases 12–15. The `Manus` branch is ready for the documented owner-controlled release validation sequence; this does not claim that a clean-host deployment, physical-device QA, signing, or public-store submission has already been completed.
