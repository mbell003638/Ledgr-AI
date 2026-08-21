# Ledgr full 15-phase roadmap audit

**Branch:** `Manus`
**Audit commit baseline:** `b94af6e`
**Scope:** Full two-tier self-hosting roadmap, accounting platform behavior, UI/UX, security, deployment, recovery, and release readiness.

## Executive result

The full roadmap is implemented across the `Manus` branch and the audit cycles found no open critical accounting or data-loss defect in the reviewed code paths. The audit closed two actionable hardening findings during this pass: deployment scripts no longer execute arbitrary `.env` shell content, and protocol/version negotiation is included in the semantic-sync request boundary. Physical-device testing, clean-host Docker deployment, production credentials, signing, and store submission remain owner-controlled release gates.

## Phase coverage matrix

| Phase | Scope | Status | Evidence or implementation |
|---:|---|---|---|
| 1 | Product scope, success criteria, ten improvements, data ownership | Complete | Approved plan, Local-only/Private sync terminology, no-hosted-Ledgr boundary. |
| 2 | Tier 1 local-only experience | Complete | Offline-first workflows, local-only status, onboarding default, integrity and backup prerequisites. |
| 3 | Encrypted backups, retention, restore testing, recovery | Complete | Encrypted Backup & Recovery workspace, AES-GCM envelope, integrity hash, dry-run, history, audit events. |
| 4 | One-command/one-click deployment packaging | Complete | Guided installer, preflight, Compose validation, secrets directory, HTTPS edge, no public database port. |
| 5 | Bundled single-node private sync | Complete | PostgreSQL-backed single-node Compose profile, persistent volumes, backup status, health endpoints. |
| 6 | Advanced PostgreSQL deployment | Complete | External PostgreSQL Compose profile, TLS-intent gate, external identity/secrets documentation, advanced installer. |
| 7 | Device enrollment, QR/one-time codes, revocation, roles, locations | Complete | Short-lived single-use enrollment codes, device registry, revocation, role assignment, location scopes, server enforcement. |
| 8 | Health, offline queue, human-readable conflicts | Complete | Sync Health screen, global attention indicator, protected `/v1/ops/health`, business-language conflict inbox. |
| 9 | Local-to-private migration and hosted-ERP boundary | Complete | Guided migration wizard with integrity/backup gates, explicit publish/install, pending-work preservation, safe return to Local-only. |
| 10 | Requirements, upgrades, rollback, documentation, release gates | Complete | `preflight.sh`, pre-upgrade encrypted backup gate, version negotiation, requirements/checklist, rollback runbook. |
| 11 | Architecture/deployment specialist audit | Closed | Deployment topology, secret handling, TLS/CORS, backup, health, upgrade, rollback, and no-hosted-service review. |
| 12 | Accounting/sync/recovery specialist audit | Closed | Double-entry, immutable history, close periods, inventory, locations, POS, allocation, replay, recovery, and cross-book review. |
| 13 | Security/identity/privacy/self-host specialist audit | Closed | OIDC, bearer handling, device revocation, roles/scopes, CORS, rate limits, logs, secrets, database exposure, and `.env` execution review. |
| 14 | Mobile/web/UX/accessibility/device QA specialist audit | Closed with owner device dependency | Responsive screens, keyboard-safe fields, back navigation, global indicator, labels, conflict and migration controls. Physical device testing remains required. |
| 15 | Final release/documentation/regression/gap-closure audit | Closed with owner deployment dependency | This report, prior audit records, release checklist, runbook, full validation matrix, and explicit release dependency list. |

## Findings closed during this full audit

| Finding | Severity | Fix |
|---|---:|---|
| Deployment installers and preflight used shell sourcing for `.env`, which could execute unintended shell content. | High | Replaced executable sourcing with a constrained key/value reader for required deployment fields in `install-advanced.sh` and `preflight.sh`. |
| Generic preflight did not reject an empty CORS origin. | Medium | Added an explicit non-empty CORS requirement and retained wildcard rejection. |
| Upgrade did not reuse the complete preflight sequence. | High | `upgrade.sh` now runs the no-start preflight before the verified pre-upgrade backup and rebuild. |
| Sync version compatibility was not carried on client requests. | High | Client coordinator and recovery requests send protocol/payload headers; server returns actionable HTTP 426 for mismatches. |
| Migration and conflict controls needed stronger assistive labels. | Medium | Added explicit accessibility roles and labels to migration and conflict actions. |

## Specialist audit controls

### Accounting and recovery

The client and server test suites cover balanced journal arbitration, immutable posted history, audited correction lineage, period close, inventory, location transfer, invoice allocation, duplicate operation IDs, payload-hash mismatch, stale revisions, device sequence reuse, revoked devices, epochs, projection/checkpoint verification, wrong-book protection, and conflict resolution. The full server suite passed with 40 tests, and the frontend suite passed with 90 suites and 634 tests.

### Security and self-host operations

Source review found no ordinary logging of bearer tokens, passwords, authorization headers, or financial payloads in the reviewed paths. PostgreSQL has no published host port in either Compose profile. Production installers require explicit OIDC, CORS, domain, and secret configuration. The advanced profile requires TLS intent in the external database URL. The deployment package remains user-owned and does not introduce a Ledgr-operated server dependency.

### UX and cross-platform behavior

The audit verified local-only/private-sync progressive disclosure, migration states, queue and health surfaces, conflict explanations, explicit business actions, back navigation, small-screen-friendly cards, keyboard-safe text entry, and accessibility labels on critical actions. The global indicator appears only when private-sync attention is needed, so ordinary accounting screens are not cluttered.

## Final release dependencies

The following are not hidden implementation gaps and must be executed by the release owner on the target environment: Docker Compose startup on a clean host, PostgreSQL migration against the production-compatible version, external OIDC configuration, HTTPS certificate issuance and renewal, encrypted backup execution and isolated restore drill, two-device offline convergence, Android/iOS airplane-mode and background/foreground testing, TalkBack/VoiceOver verification, web keyboard testing, release signing, Play Store/App Store submission, and data-safety/privacy declarations.

## Final decision

**Implementation audit: pass.** No critical finding remains open in the reviewed application or sync-server implementation. **Public release readiness: conditional pass**, pending the owner-controlled deployment, hardware, credentials, signing, store, and disaster-recovery gates listed above.
