# Ledgr Two-Tier Self-Hosting Implementation Plan

**Document status:** Planning only — no implementation authorized by this document

**Product:** Ledgr

**Target branch:** `Manus` only

**Primary objective:** Make Ledgr the easiest and safest offline-first business finance and ERP platform to operate in either local-only mode or user-owned private multi-device mode.

---

## 1. Executive Summary

Ledgr should provide two clear hosting experiences without forcing every business to operate a server.

**Tier 1 — Local-only mode** is for a solo entrepreneur, freelancer, creator, startup, or one-shop business. The user installs Ledgr and works entirely on the device or browser. Accounting, inventory, reports, AI-assisted drafts, POS, and business workflows continue without internet. The user can create encrypted backups and move them to storage they control.

**Tier 2 — Guided private sync mode** is for businesses with multiple users, shops, registers, warehouses, or devices. The owner deploys a ready-made private Ledgr service on a NAS, office server, private VPS, or private cloud. Ledgr clients connect using HTTPS and optional OIDC/PKCE authentication. Devices synchronize validated semantic accounting operations rather than copying raw SQLite files or blindly replacing complete databases.

The two tiers must share the same application experience. A user should be able to start locally and later enable private synchronization without recreating the business, exporting raw database files, or losing history.

> **Core product promise:** Ledgr works without a server, works without internet, and can optionally synchronize through infrastructure controlled by the business owner.

The plan deliberately separates four concepts that must not be confused in the product UI:

| Concept | Meaning |
|---|---|
| Local-only operation | Ledgr runs on a device or browser with no remote service required. |
| Encrypted backup | A portable recovery copy of a business book, stored wherever the owner chooses. |
| Private synchronization | Multiple enrolled devices exchange validated operations through the owner’s server. |
| Full hosted ERP | A future centrally hosted server-based ERP interface and API. This is not the immediate target of this plan. |

---

## 2. Current State and Target State

### 2.1 Current foundation

The Manus branch already contains a local-first accounting application, a V2 accounting domain layer, an optional self-host synchronization foundation, semantic operation synchronization imported from `codex-sol`, device and conflict concepts, a PostgreSQL-capable sync-server package, route-level sync screens, and local integrations.

The current implementation should be treated as a foundation rather than a finished self-hosting product. The remaining work is primarily productization, deployment simplification, operational reliability, UI clarity, migration, backup automation, health visibility, device administration, and release testing.

### 2.2 Target state

The finished system must provide the following experience:

1. A new user can use Ledgr locally without understanding servers, databases, Docker, PostgreSQL, domains, or identity providers.
2. A growing business can enable private synchronization through a guided setup flow.
3. A technically capable administrator can deploy the advanced server package with one documented command or Docker Compose configuration.
4. A business can enroll Android, iOS, web, POS, warehouse, and accountant devices separately.
5. Each device can work offline and later synchronize validated operations.
6. Conflicts are visible, explainable, auditable, and explicitly resolved.
7. The owner can revoke a lost device without deleting the book or disconnecting all other devices.
8. Backups are encrypted, scheduled, independently stored, and periodically restore-tested.
9. The owner can monitor server health, database status, storage, certificate expiry, sync status, and backup status.
10. A business can migrate from local-only mode to private sync and back without corrupting or silently replacing accounting data.

---

## 3. Product Principles

### 3.1 Local-first by default

The app must never require the private server for ordinary local data entry. A temporary network failure must not prevent a user from recording a sale, expense, purchase, payment, receipt, stock movement, invoice, or other allowed workflow.

### 3.2 Semantic synchronization, not raw database replication

The synchronization layer must exchange validated business operations and their dependencies. It must not copy SQLite files between devices, execute SQL supplied by a client, or use silent last-write-wins behavior for accounting objects.

### 3.3 Explicit authority

The client validates locally. The server validates again. The server assigns canonical ordering and revision information. Only accepted operations become part of the shared synchronized book.

### 3.4 No silent overwrite

A first-time remote pull, stale update, incompatible book, rejected operation, or conflict must stop safely and explain what happened. Users must explicitly choose among available resolution options.

### 3.5 User-owned infrastructure

Ledgr must not require a Ledgr-operated cloud service for the private-sync tier. The user controls the server, database, domain, authentication configuration, backups, access policy, and network exposure.

### 3.6 Progressive disclosure

A solo business should see simple local backup options. A business that enables private sync should see server, device, health, and conflict tools. Advanced infrastructure settings must not clutter the core accounting interface.

### 3.7 Accounting integrity over convenience

A synchronization operation must never bypass journal validation, period-close rules, location rules, inventory constraints, audit history, or business-specific capability guards.

### 3.8 Recoverability over speed

The system should prefer a visible retry or conflict state over data loss, partial synchronization, or an apparently successful but incomplete operation.

---

## 4. User Personas and Hosting Recommendations

The onboarding experience should recommend a hosting tier based on business complexity without forcing the choice.

| Business profile | Default recommendation | Reason |
|---|---|---|
| Freelancer, creator, consultant, solo entrepreneur | Tier 1 local-only | One person, few devices, minimal operational overhead. |
| Startup or developer business | Tier 1 initially, Tier 2 when the team grows | Begin with simple local operation; add private sync when several people need the same book. |
| One retail shop | Tier 1 or Tier 2 | Tier 2 becomes useful for multiple registers, owner phone, accountant, and shop tablet. |
| Multiple retail shops | Tier 2 | Shared locations, registers, stock, and staff require controlled multi-device synchronization. |
| Dropshipper or marketplace seller | Tier 1 or Tier 2 | Tier 2 is useful when operations, support, accounting, and fulfillment users work on different devices. |
| Manufacturer or warehouse business | Tier 2 | Production, inventory, stock locations, purchasing, and accounting require multi-user continuity. |
| Import/export trader | Tier 2 | Trade, shipments, documents, costs, currencies, and accounting may be managed by distributed staff. |
| Accountant serving several businesses | Tier 2 with separate workspaces/books | Each legal business must remain isolated while the accountant uses an authorized device. |

The recommendation must remain reversible. The user must be able to continue with Tier 1 even when Tier 2 is recommended.

---

## 5. Tier 1 — Local-Only Mode

### 5.1 Required user experience

The user installs Ledgr, completes onboarding, selects a business persona, and immediately uses the core workflows. No server URL, workspace identifier, token, database, or account registration should be required.

The app should show a subtle status such as **Local-only mode** in Settings and Backup, not as a warning on every page. The status should explain that the user can enable private synchronization later.

### 5.2 Local capabilities

Local-only mode must support the complete selected capability set, including:

- Sales and POS.
- Purchases and supplier bills.
- Payments, receipts, expenses, invoices, quotes, and delivery notes.
- Accounts and contacts.
- Inventory, stock movements, physical counts, and shop-level closeouts.
- Manufacturing, projects, trade, marketplace, creator, payroll, assets, budgets, recurring workflows, and reports when enabled by the selected configuration.
- AI drafts that require validation and confirmation before any accounting write.
- All selected business metrics with honest missing-input states.
- Local reports and exports.
- Local CSV and document imports staged for review.

### 5.3 Encrypted backup experience

Add a dedicated **Backup & Recovery** workspace with three levels of use:

| User level | Experience |
|---|---|
| Basic | Export encrypted backup and import encrypted backup. |
| Recommended | Configure a backup location and recurring export reminders. |
| Advanced | Verify backup integrity, view backup history, test restore into a temporary book, and inspect retention status. |

The backup flow must:

1. Explain that backups contain sensitive financial data.
2. Require the user to choose or confirm a passphrase or supported key method.
3. Encrypt the backup before it leaves the device.
4. Include schema version, product version, book identity, export timestamp, integrity hash, and compatibility metadata.
5. Avoid storing the passphrase in ordinary preferences.
6. Refuse to import a corrupt, incomplete, incompatible, or wrong-book backup without an explicit recovery flow.
7. Preserve an immutable original backup file during restore attempts.
8. Provide a dry-run validation before destructive replacement.
9. Record restore events in the local audit history.

### 5.4 Local backup destinations

The first release should support:

- Device file storage.
- User-selected file export.
- Browser download on web.
- Import from a user-selected file.

Optional future integrations may support user-configured cloud drives, but Ledgr must not make a vendor cloud mandatory for backup.

### 5.5 Local-only limitations shown honestly

Local-only mode must explain that data is not automatically shared between devices. If the user wants several devices to see the same current book, they should enable private synchronization or manually transfer an encrypted backup.

The app must distinguish **manual backup transfer** from **multi-device synchronization** so a user does not assume that exporting one file creates live collaboration.

---

## 6. Migration Between Hosting Tiers

### 6.1 Local-only to private sync

Provide a guided **Enable private sync** wizard:

1. Explain what will be synchronized and what will remain device-local.
2. Run a local integrity check.
3. Require a current encrypted backup before enrollment.
4. Ask the user to enter or scan the private server connection details.
5. Test HTTPS, authentication, workspace compatibility, and server health.
6. Offer **Create new workspace from this book** or **Connect to existing workspace**.
7. Display a full summary of the selected book, locations, users, and approximate data scope.
8. Require explicit confirmation before the first publish or remote pull.
9. Publish operations or initialize the canonical workspace atomically.
10. Enroll the first device and display the resulting device identity.
11. Offer enrollment QR code or secure one-time code for additional devices.
12. Verify that a second device can pull and validate the book before marking migration complete.

### 6.2 Existing remote workspace to a new device

A new device must not automatically overwrite a local book. It must present:

- Remote workspace name.
- Legal/business identity.
- Last canonical sequence or checkpoint.
- Last server backup status if available.
- Device enrollment identity.
- Whether the local device contains any unsynchronized data.

The user must explicitly choose **Use remote workspace** or cancel.

### 6.3 Private sync to local-only

Disabling private sync must not delete local data. The app should:

1. Finish or explain pending operations.
2. Create an encrypted backup.
3. Warn that other devices will no longer receive changes from this device.
4. Revoke or retain the device enrollment according to the user’s choice.
5. Keep the local book usable.
6. Preserve a reconnection path to the same workspace.

### 6.4 Book separation and legal entities

The migration flow must warn users not to merge legally separate businesses into one book merely because they share an owner. Workspace and book identity must be explicit. A user may have several business books under one authenticated identity, but synchronized data must remain isolated by book.

---

## 7. Tier 2 — Guided Private Sync

### 7.1 Deployment goals

The private sync deployment must be available in two modes:

| Mode | Target user | Characteristics |
|---|---|---|
| Guided single-node mode | Small business or owner with limited IT support | One command or guided installer; bundled service configuration; sensible defaults; automated health checks and backups. |
| Advanced production mode | IT administrator, VPS operator, or larger organization | Explicit PostgreSQL, reverse proxy, OIDC, secrets, backups, monitoring, scaling, and upgrade controls. |

The single-node mode should use the same semantic protocol as advanced mode. It must not become a separate, weaker synchronization implementation.

### 7.2 Package contents

The ready-made deployment package should include:

- Private sync API service.
- PostgreSQL database configuration.
- Database migration runner.
- HTTPS reverse-proxy configuration.
- Authentication configuration template.
- Health and readiness endpoints.
- Structured logs and correlation IDs.
- Metrics endpoint or metrics export.
- Backup job configuration.
- Restore-drill helper.
- Upgrade and rollback documentation.
- Environment-variable example file with safe placeholders.
- Secure secrets directory or documented external secret mechanism.
- CORS and allowed-origin configuration.
- Device enrollment and revocation operations.

### 7.3 One-command installation target

The target technical administrator experience should be:

```text
1. Install Docker and Docker Compose.
2. Download the signed Ledgr private-sync release package.
3. Copy the production environment template.
4. Set the domain, database secret, administrator identity, and backup location.
5. Run the supplied deployment command.
6. Open the health URL and complete the guided first-run setup.
```

The exact command must be documented for every supported release. The installer should validate prerequisites before starting and fail before partial production deployment when a required secret, port, directory, or configuration value is missing.

### 7.4 Single-node defaults

Single-node mode should provide safe defaults for:

- One sync service process.
- One PostgreSQL instance.
- Persistent database volume.
- Persistent backup volume.
- HTTPS reverse proxy.
- Automatic restart after host reboot.
- Health checks.
- Daily encrypted backup with configurable retention.
- Explicit admin enrollment.
- No anonymous write access.
- No public database port.
- No default production credentials.

### 7.5 Advanced production mode

Advanced mode should support:

- External PostgreSQL.
- External identity provider.
- External secret manager.
- Separate application and database hosts.
- Private network or VPN-only access.
- Multiple service replicas where supported by the protocol.
- External object storage for encrypted backups.
- Centralized logs and metrics.
- Database replication or managed PostgreSQL where appropriate.
- Controlled maintenance windows.

The product must not claim high availability unless deployment documentation and automated tests prove the relevant failure behavior.

### 7.6 Server health and readiness

Expose separate health concepts:

| Endpoint/status | Purpose |
|---|---|
| Liveness | Process is running. |
| Readiness | Process can reach the database and serve requests. |
| Sync health | Operation ingestion, projection, conflict, and cursor services are functioning. |
| Backup health | Last backup succeeded, is readable, and has not exceeded retention or age limits. |
| Dependency health | Identity provider, database, storage, and certificate status. |

The client should show only user-relevant summaries. Administrators should have access to detailed diagnostics through the private server dashboard or protected admin endpoint.

---

## 8. Authentication, Security, and Device Management

### 8.1 Authentication modes

Support a staged path:

1. Guided private setup with a secure administrator enrollment flow.
2. OIDC Authorization Code with PKCE for normal user authentication.
3. Short-lived access tokens and refresh behavior appropriate to the client platform.
4. Device-specific enrollment identities.
5. Explicit device revocation.
6. Optional organization-managed roles and groups.

Bearer tokens or setup secrets must never be displayed again in plaintext after initial entry. The app should use platform secure storage where available and clearly explain browser storage limitations on web.

### 8.2 Device registry

Create a device-management screen containing:

- Device name.
- Device type and platform.
- First enrollment time.
- Last seen time.
- Last successful sync.
- Current sequence/cursor state.
- Assigned user.
- Assigned locations.
- Status: active, pending, revoked, expired, or recovery-required.
- Revoke action.
- Rename action.
- Re-enroll action.

A revoked device must be unable to push or pull new operations. Revocation must not delete historical operations or affect other devices.

### 8.3 Roles and locations

Separate authentication identity, business role, and location access.

| Layer | Example |
|---|---|
| User identity | Owner, accountant, manager, warehouse operator. |
| Role | Administrator, accountant, shop manager, cashier, warehouse user. |
| Business book | A legal business or accounting entity. |
| Location scope | Downtown shop, Airport shop, warehouse. |
| Device scope | Owner phone, POS tablet, accountant browser. |

Every role and location restriction must be enforced server-side as well as in the UI. UI hiding is not an authorization control.

### 8.4 Security baseline

The deployment must enforce:

- HTTPS in production.
- No public database port.
- Strong generated secrets.
- Secure cookie/token handling where applicable.
- Explicit CORS allowlist.
- Rate limiting for authentication and enrollment endpoints.
- Request size limits.
- Structured audit logs without secrets or financial payload leakage.
- Database encryption at rest where supported by the host.
- Encrypted backups.
- Device revocation.
- Dependency and container vulnerability scanning.
- Server-side schema and business-rule validation.
- No client-supplied SQL execution.
- No anonymous write access.
- Safe error messages that do not reveal credentials or internal database details.

### 8.5 Threat model

Document and test at least these threats:

| Threat | Required mitigation |
|---|---|
| Lost device | Device revocation and short-lived authorization. |
| Stolen bearer token | Rotation, revocation, secure storage, limited scope, and audit logs. |
| Replay of an accepted operation | Deterministic operation ID, payload hash, and idempotent replay. |
| Stale edit | Aggregate revision or equivalent conflict detection. |
| Cross-book data injection | Book membership, reference validation, and projection checks. |
| Forged device sequence | Device identity, epoch, monotonic sequence, and server verification. |
| Unbalanced journal | Server-side accounting arbitration before commit. |
| Malicious backup restore | Encrypted, integrity-checked, schema-checked, explicit restore flow. |
| Database exposure | Private network, firewall, no public database port, encrypted transport. |
| Backup theft | Encryption, separate credentials, and access-controlled backup storage. |

---

## 9. Semantic Synchronization Behavior

### 9.1 Operation lifecycle

Every synchronized mutation should follow a clear lifecycle:

```text
Local draft
  → local validation
  → durable outbox
  → authenticated upload
  → server validation and arbitration
  → canonical sequence assignment
  → accepted or rejected result
  → cursor-based pull by other devices
  → local application and verification
```

### 9.2 Required operation metadata

Each operation should contain or derive:

- Operation ID.
- Book ID.
- Device ID.
- Authenticated actor ID.
- Device sequence.
- Client-created timestamp.
- Aggregate type and aggregate ID.
- Aggregate revision or precondition.
- Payload hash.
- Canonical server sequence after acceptance.
- Dependency IDs where required.
- Protocol/schema version.
- Optional idempotency key.

### 9.3 Pull-before-push behavior

A device should pull applicable remote operations before pushing a local operation when the operation depends on a potentially changed aggregate. The client must not repeatedly push a stale mutation without refreshing the relevant state.

### 9.4 Conflict categories

The UI should classify conflicts in business language:

- Same invoice changed on two devices.
- Same stock quantity or count changed on two devices.
- Payment already allocated by another device.
- Location transfer changed after a local edit.
- Period closed before an offline operation was uploaded.
- Device revoked or enrollment expired.
- Book or schema version incompatible.
- Operation references an unknown or unauthorized object.

### 9.5 Conflict resolution

Do not provide only a generic “keep mine” button. The conflict workspace should show:

- What the local device attempted.
- What the server already accepted.
- Which fields differ.
- Which accounting consequences would result.
- Whether the local operation can be safely replayed.
- Whether a new audited correction is required.
- Whether the user needs accountant or administrator approval.

Resolution options may include:

- Retry against the latest state.
- Keep the canonical server result.
- Create an audited correction.
- Re-enter the transaction using the current period/location.
- Discard the local draft without deleting accepted history.

### 9.6 Accounting safety rules

The server must reject operations that:

- Produce unbalanced journal entries.
- Modify immutable posted history directly.
- Violate a closed-period rule.
- Use unauthorized accounts, parties, locations, or books.
- Create invalid stock quantities or references.
- Double-allocate invoices or receipts.
- Bypass multi-location requirements.
- Reuse an operation ID with a different payload.
- Use a stale aggregate revision where the operation is not independently mergeable.

---

## 10. Backup, Retention, and Restore Drills

### 10.1 Backup layers

Provide multiple layers rather than relying on one backup:

| Layer | Scope | Frequency |
|---|---|---|
| Client encrypted export | One business book on a device | User-triggered and before major migrations. |
| Server database backup | Central synchronized state | Automated daily at minimum; configurable for higher frequency. |
| Operation log backup | Semantic history and recovery data | Included in database and checkpoint backup strategy. |
| Configuration backup | Deployment settings, identity metadata, and role configuration | Before upgrades and on a recurring schedule. |
| Off-site encrypted copy | Disaster recovery | Configurable according to business risk. |

### 10.2 Retention policy

The administrator should configure retention by time and count. The UI must show:

- Last successful backup.
- Last verified backup.
- Oldest retained backup.
- Next scheduled backup.
- Backup size.
- Storage capacity.
- Encryption status.
- Restore-test status.

### 10.3 Restore process

A production restore must be a guided, explicit operation:

1. Select a backup.
2. Verify its integrity and encryption.
3. Confirm target workspace and version compatibility.
4. Create a pre-restore backup.
5. Stop or isolate writes while restoring.
6. Restore into a temporary environment first when possible.
7. Run database, operation, projection, accounting, and reference checks.
8. Require administrator confirmation before making the restored state active.
9. Reconcile device cursors and epochs.
10. Require devices to revalidate or re-enroll if necessary.
11. Record the restore event in the audit log.

### 10.4 Restore drills

The server package should include a documented restore drill that does not affect production. The drill must create a temporary database or isolated environment, restore a selected backup, run integrity checks, and report success or failure.

A backup that has never been restore-tested should be shown as **unverified** rather than healthy.

---

## 11. Health Dashboard and Administration

Create a protected **Private Server Health** view with two modes.

### 11.1 Business owner view

Show simple statuses:

- Private sync: connected, offline, degraded, or conflict.
- Last successful synchronization.
- Devices needing attention.
- Pending local operations.
- Open conflicts.
- Last successful backup.
- Last verified restore.
- Storage warning.
- Certificate warning.

### 11.2 Technical administrator view

Show:

- Service version.
- Database connectivity and migration version.
- Request and operation throughput.
- Failed operation count.
- Conflict rate.
- Average sync latency.
- Current canonical sequence.
- Device cursor lag.
- Storage usage.
- Backup age and verification results.
- Certificate expiry.
- Authentication provider status.
- Recent security events.
- Upgrade compatibility status.

Sensitive payloads and tokens must not appear in ordinary logs or dashboards.

---

## 12. Offline Queue and User Feedback

The app should provide a globally accessible but unobtrusive sync indicator.

| Status | User-facing meaning |
|---|---|
| Local-only | No private sync is configured. |
| Offline changes saved | Work is safe locally and waiting to synchronize. |
| Syncing | Operations are being uploaded or downloaded. |
| Synced | No pending work and latest checkpoint verified. |
| Needs attention | One or more operations require retry or conflict resolution. |
| Server unavailable | Local work continues; synchronization will retry later. |
| Device revoked | Contact the business administrator or re-enroll this device. |

The user should be able to open the status indicator and see the affected workflow, not merely a technical error code.

---

## 13. Migration from the Existing Manus Implementation

### 13.1 Preserve existing local books

Do not require users to reset or recreate existing books. Existing V2 accounting data, persona settings, locations, products, POS sessions, reports, AI preferences, and operational modules must remain intact.

### 13.2 Consolidate synchronization paths

The product should expose one primary semantic-sync experience. Older snapshot synchronization may remain available internally as a backup compatibility path only if it is clearly separated from live synchronization and tested. It must not be presented as the preferred multi-device sync method.

### 13.3 Schema and protocol versioning

Add explicit version negotiation for:

- Client schema.
- Server schema.
- Operation protocol.
- Projection/checkpoint format.
- Backup format.
- Authentication/device enrollment format.

Older clients must fail safely with an actionable upgrade message rather than partially applying operations.

### 13.4 Migration test matrix

Test at least:

- Existing local book → new private workspace.
- Existing private workspace → clean Android device.
- Existing private workspace → clean iOS device.
- Existing private workspace → clean web browser.
- One location → multiple locations.
- One POS register → multiple registers.
- Existing pending local operations during enrollment.
- Existing conflicts during protocol upgrade.
- Existing encrypted backup restored after upgrade.
- Server database restored while devices are offline.

---

## 14. Implementation Workstreams

The work should be delivered in controlled workstreams rather than one large unreviewed change.

| Workstream | Main deliverables |
|---|---|
| A. Hosting-mode foundation | Tier state model, local-only status, private-sync state, migration flags, and user-facing mode settings. |
| B. Encrypted backup | Portable encrypted backup format, integrity checks, import/export UI, restore dry-run, and restore audit events. |
| C. Guided setup | Private server setup wizard, connection test, workspace selection, first publish/pull confirmation, and migration flow. |
| D. Semantic sync client | Durable outbox, pull-before-push, cursors, retries, operation validation, conflict states, and recovery. |
| E. Semantic sync server | PostgreSQL migrations, canonical sequencing, arbitration, device enrollment, book authorization, and conflict persistence. |
| F. Device administration | Enrollment QR/code, device list, revoke, rename, re-enroll, roles, and locations. |
| G. Health and operations | Health endpoints, owner dashboard, admin dashboard, metrics, logs, backup status, and certificate checks. |
| H. Deployment packaging | Single-node Docker Compose, advanced production deployment, HTTPS proxy, secrets, backup jobs, and upgrade scripts. |
| I. Migration compatibility | Existing Manus data migration, protocol/version checks, rollback, and compatibility tests. |
| J. Documentation and support | Owner setup guide, administrator runbook, recovery guide, security guide, troubleshooting, and release notes. |

---

## 15. Suggested Delivery Phases

### Phase 0 — Product and safety baseline

Confirm hosting terminology, mode-selection UX, threat model, data ownership language, legal-entity isolation, and non-negotiable accounting invariants. No infrastructure behavior should be changed until these contracts are approved.

### Phase 1 — Tier 1 local-only hardening

Deliver encrypted backup/export/import, integrity checks, restore dry-run, recovery audit events, local-only status, and migration prerequisites. This phase must be independently useful even if private sync is disabled.

### Phase 2 — Private sync setup wizard

Deliver server connection testing, workspace discovery, first publish/pull confirmation, migration from local-only, device enrollment, and user-friendly status states.

### Phase 3 — Semantic sync reliability

Harden outbox durability, retries, pull-before-push, canonical sequence handling, cursor recovery, idempotency, stale revisions, conflict persistence, and replay verification.

### Phase 4 — Device, role, and location administration

Deliver device registry, QR enrollment, revocation, role assignment, location scopes, permission enforcement, and multi-location accounting tests.

### Phase 5 — Production server package

Deliver single-node Docker Compose, PostgreSQL migrations, HTTPS proxy configuration, OIDC/PKCE setup, generated secrets, health checks, automatic restart, backup jobs, and restore-drill scripts.

### Phase 6 — Health and operations dashboard

Deliver owner-facing sync/backup status, administrator health diagnostics, storage and certificate warnings, failed-operation visibility, and security event summaries.

### Phase 7 — Upgrade, recovery, and release readiness

Deliver version negotiation, migrations, rollback, backup compatibility, disaster recovery drills, performance tests, security tests, documentation, and owner-controlled release validation.

---

## 16. Testing Strategy

### 16.1 Client tests

Test:

- Local-only operation with no network.
- Encrypted backup creation and wrong-passphrase handling.
- Backup corruption detection.
- Restore dry-run and wrong-book rejection.
- Migration wizard state transitions.
- First remote pull protection.
- Durable outbox persistence across app restart.
- Retry and backoff behavior.
- Idempotent operation replay.
- Device-revoked behavior.
- Sync indicator states.
- Conflict message clarity.
- Multi-location operation scopes.
- Android, iOS, and web secure-storage differences.

### 16.2 Server tests

Test:

- Authentication and authorization.
- Device enrollment and revocation.
- Book isolation.
- Operation idempotency.
- Payload-hash mismatch rejection.
- Canonical sequence assignment.
- Cursor paging and recovery.
- Stale aggregate conflict handling.
- Journal balance arbitration.
- Closed-period rejection.
- Inventory and location validation.
- Invoice allocation protection.
- Audited correction lineage.
- Backup and restore behavior.
- Database migration and rollback.
- Rate limiting and request-size limits.

### 16.3 Integration tests

Test real client/server flows with:

- One device online.
- Two devices editing independent records offline.
- Two devices editing the same record offline.
- Device offline during server upgrade.
- Server unavailable during local posting.
- Database restore while devices are disconnected.
- Network timeout and retry.
- Partial response and duplicate response.
- Schema version mismatch.
- Large book and large operation batch.
- Multi-location stock counts and shop closeouts.

### 16.4 Performance targets

Define and measure targets before claiming production readiness. Suggested initial targets are:

| Scenario | Initial target |
|---|---:|
| Local transaction save | UI confirmation without waiting for network. |
| Sync status check | Perceived response within 2 seconds on a healthy local network. |
| Small operation upload | Completion within 5 seconds on a normal connection. |
| Conflict display | Visible to the user within one synchronization cycle. |
| First small-book bootstrap | Completion within 60 seconds on a normal local network. |
| Restore verification | Measured by book size; no unbounded memory assumption. |

These are product targets, not guarantees. Measure on representative Android, iOS, web, local-network, and VPS environments.

---

## 17. Release and Operational Gates

The feature must not be called production-ready until all applicable gates pass.

### Application gates

- TypeScript compilation passes.
- Strict lint passes with zero warnings.
- Full unit and integration test suite passes.
- Android release bundle builds with permanent package ID `com.ahem.ledgrai`.
- iOS release build succeeds in the owner’s Apple signing environment.
- Web export succeeds.
- Expo Doctor passes.
- UI tests cover local-only, setup, sync, conflict, device, backup, and health flows.
- Accessibility labels and keyboard behavior are verified.
- Offline behavior is tested on physical Android and iOS devices.

### Server gates

- Production Docker image builds reproducibly.
- Database migrations apply cleanly to a new installation and an existing installation.
- No default production secrets exist.
- HTTPS and allowed-origin checks are tested.
- Authentication and device revocation tests pass.
- Health and readiness endpoints pass.
- Backup job succeeds.
- Restore drill succeeds.
- Upgrade and rollback drill succeeds.
- PostgreSQL connection pool and transaction behavior are tested.
- Security scanning and dependency review pass.

### Data integrity gates

- No cross-book data leakage.
- No unbalanced journal accepted.
- No invalid location-scoped entry accepted.
- No closed-period mutation accepted.
- No duplicate operation changes accounting meaning.
- No conflict silently overwrites accepted history.
- No restore silently replaces the wrong book.
- Every correction remains auditable.

### Documentation gates

- Solo user guide is complete.
- Private sync administrator guide is complete.
- Docker Compose quick start is complete.
- VPS/NAS/private-network guidance is complete.
- Backup and restore guide is complete.
- Device enrollment and revocation guide is complete.
- Troubleshooting guide is complete.
- Security and data ownership documentation is complete.
- Upgrade and rollback runbook is complete.

---

## 18. Rollout Strategy

Use a staged rollout:

1. Internal developer testing with local-only mode.
2. Internal two-device sync testing on a private network.
3. Controlled alpha with one business and non-critical test books.
4. Beta with multiple locations and realistic offline periods.
5. Disaster recovery and restore drills using representative data.
6. Public release with private sync labeled as optional and documented limitations.
7. Post-release monitoring of conflicts, failed syncs, restore events, and device enrollment failures.

The first public release should default to local-only mode. Private sync should be opt-in until deployment reliability, recovery, and support processes have been demonstrated.

---

## 19. User-Facing Positioning

Use simple product language:

> **Local by default. Private when you need it.**

> Ledgr works on your device without internet. When your business grows, connect your own private sync server to keep multiple devices and locations coordinated. You control the server, data, backups, and access.

Avoid saying that every user needs to self-host. Avoid saying that the app is a complete centrally hosted ERP until a full server-based ERP interface is actually delivered. Distinguish the following labels in the UI:

- **Local-only mode**
- **Encrypted backup**
- **Private sync**
- **Server health**
- **Device management**
- **Conflict resolution**

---

## 20. Definition of Done

The two-tier self-hosting initiative is complete when:

1. A solo user can install Ledgr and use the full selected business workflow without creating an account or server.
2. The user can create and restore an encrypted backup safely.
3. The user can enable private sync later without recreating the book.
4. A guided installer can deploy the private sync service with safe defaults.
5. The private sync service uses PostgreSQL in production mode and HTTPS for client communication.
6. Devices can be enrolled, listed, scoped, and revoked.
7. Android, iOS, web, POS, warehouse, and accountant devices can work offline and synchronize later.
8. Semantic operations are validated locally and server-side.
9. Conflicts are explicit, explainable, auditable, and resolvable.
10. Multi-location stock and shop-close behavior remains correct during synchronization.
11. Automated encrypted backups and restore drills are available.
12. Owner and administrator health views are available.
13. Upgrade, rollback, migration, and recovery procedures are tested.
14. Full application and server validation gates pass.
15. Documentation is sufficient for both a solo business owner and a technical administrator.
16. The implementation never modifies `codex-sol`; all product changes are made on `Manus` only.

---

## 21. Recommended Next Action

Do not start by adding more synchronization endpoints. Start with **Phase 1: Tier 1 local-only hardening**, because every user benefits from reliable encrypted backups and recovery, and private sync depends on those safety guarantees.

After that, implement the **guided private sync setup wizard** and the **single-node deployment package** using the already-imported semantic synchronization protocol. Keep the advanced PostgreSQL/OIDC deployment available for larger businesses, but hide its complexity behind documentation and sensible defaults.

### References

[1]: https://github.com/avansaber/erpclaw "ERPClaw official repository and technical deployment reference"

[2]: https://www.erpclaw.ai/security/ "ERPClaw official security and self-hosting reference"

[3]: https://www.erpclaw.ai/pricing/ "ERPClaw official self-hosting and infrastructure overview"


---

## 22. Fifteen-Phase Execution Roadmap

The implementation must be executed in exactly **15 phases**. Phases 1–10 build the product and operational foundation. Phases 11–15 are mandatory repeated specialist audit-and-fix cycles. An audit phase is not complete merely because a report was written; every actionable finding must either be fixed, explicitly proven inapplicable, or documented as an owner-controlled release dependency.

### Phase 1 — Confirm scope, success criteria, and the ten self-hosting improvements

Create the final product contract for the two-tier model. Confirm that the scope includes one-command or one-click deployment, bundled single-node mode, advanced PostgreSQL deployment, QR device enrollment and revocation, encrypted backups and restore testing, health monitoring, offline queue and conflict UX, local-to-private migration, minimum requirements with upgrade and rollback procedures, and clear separation between backup, private synchronization, and future full hosted ERP.

Define measurable acceptance criteria, data-ownership language, legal-entity boundaries, supported deployment targets, supported client platforms, and the rule that all product changes occur on `Manus` only. Record explicit non-goals so implementation does not accidentally turn the app into a mandatory cloud ERP.

### Phase 2 — Finalize the Tier 1 local-only product experience

Make local-only mode complete and easy for a solo user. Confirm that onboarding, persona configuration, accounting workflows, reports, AI drafts, POS, locations, inventory, and enabled ERP modules work without server configuration or internet access.

Add a calm local-only status indicator, explain that no Ledgr cloud account is required, and provide an obvious but non-intrusive path to encrypted backup and future private sync. Test app restart, airplane mode, browser offline behavior, and local data recovery.

**Primary improvement addressed:** the lowest-cost and fastest no-server option for a single user.

### Phase 3 — Design and implement encrypted backups, retention, restore testing, and recovery

Deliver the complete Backup & Recovery workspace. Implement encrypted portable exports, integrity hashes, schema and version metadata, wrong-passphrase handling, wrong-book protection, corruption detection, restore dry-runs, pre-restore backups, audit events, retention rules, backup history, and restore-test status.

Define device export, user-selected file export, browser download, and import behavior. Add automated or guided recurring backup reminders in local-only mode. Ensure the system never presents an unverified backup as healthy and never performs destructive replacement without explicit confirmation.

**Primary improvement addressed:** automatic encrypted backups, retention settings, and visible restore testing.

### Phase 4 — Design and implement one-command and one-click deployment packaging

Create a signed, versioned deployment package that validates prerequisites, generates safe secrets, configures persistent volumes, starts services, exposes health checks, and provides an actionable setup URL. Offer Docker Compose as the advanced command-line path and a guided setup experience for less technical owners.

The package must fail before partial production deployment when required configuration is missing. It must include upgrade, rollback, backup, restore-drill, and troubleshooting commands. It must never ship default production credentials or expose PostgreSQL publicly.

**Primary improvement addressed:** one-command or one-click deployment instead of requiring users to understand Docker, PostgreSQL, TLS, and OIDC internals.

### Phase 5 — Design and implement bundled single-node private sync mode

Create a safe small-business deployment profile containing the private sync service, PostgreSQL, HTTPS reverse proxy, persistent volumes, automatic restart, health checks, generated secrets, backup jobs, and sensible defaults. Use the same semantic synchronization protocol as advanced deployment; do not create a weaker second sync engine.

Add a first-run wizard that creates or connects to a workspace, tests the server, confirms the business book, publishes or pulls explicitly, enrolls the first device, and displays the server status. Provide a simple way to upgrade from single-node mode to advanced external PostgreSQL without recreating the business.

**Primary improvement addressed:** bundled single-node mode for small businesses.

### Phase 6 — Design and implement advanced PostgreSQL deployment for larger businesses

Document and test a production profile with external PostgreSQL, external OIDC identity, external secrets, private networking or VPN, TLS, backup storage, monitoring, controlled migrations, and optional service replicas where the protocol supports them.

Define minimum and recommended resources, database connection limits, storage growth expectations, backup capacity, upgrade windows, and supported operating environments. Include explicit warnings that high availability is not claimed unless failover and recovery have been tested.

**Primary improvement addressed:** advanced PostgreSQL deployment for larger organizations.

### Phase 7 — Design and implement device enrollment, QR onboarding, revocation, roles, and locations

Build the device registry and enrollment workflow. Support QR codes or secure one-time enrollment codes, device naming, platform information, last-seen time, last-sync time, user assignment, role assignment, location scope, status, revocation, rename, and re-enrollment.

Ensure a revoked device cannot push or pull. Enforce user, role, book, and location permissions on the server as well as in the UI. Test owner phone, accountant browser, POS tablet, warehouse device, and multi-shop manager scenarios.

**Primary improvement addressed:** QR-code device enrollment and one-click device revocation.

### Phase 8 — Design and implement health monitoring, offline queue status, and human-readable conflicts

Create owner and administrator health views. Show sync state, pending operations, failed operations, conflicts, device attention, last successful sync, database status, storage, certificate expiry, backup status, restore-test status, and identity-provider status.

Add an unobtrusive global offline/sync indicator to Android, iOS, and web. Replace technical errors with business-language explanations. Build a conflict inbox showing local intent, accepted server state, field differences, accounting consequences, and safe resolution choices. Never use silent last-write-wins for accounting conflicts.

**Primary improvements addressed:** server health page, offline queue indicator, and human-readable conflict resolution.

### Phase 9 — Design and implement local-to-private migration and define the hosted-ERP boundary

Implement migration from local-only to private sync without manual raw database export. Require a local integrity check and encrypted backup first. Let users create a new workspace from the local book or connect to an existing workspace with explicit confirmation.

Protect users from accidental remote overwrite, preserve pending local operations, verify the second enrolled device, and provide a safe path to disable private sync without deleting local data. Clearly label local-only mode, encrypted backup, private synchronization, and future full hosted ERP as different products and workflows.

**Primary improvements addressed:** migration without manual raw database transfer and separation of backup, sync, and future hosted ERP.

### Phase 10 — Define minimum requirements, upgrades, rollback, documentation, and release gates

Publish exact minimum and recommended requirements for single-node, NAS, office server, VPS, and advanced PostgreSQL deployment. Document ports, domains, HTTPS, storage, memory, CPU, backups, identity, firewall, and supported operating systems.

Implement version negotiation, database migrations, compatibility checks, upgrade preflight, automatic pre-upgrade backup, rollback procedures, restore drills, and release notes. Create owner documentation, administrator runbooks, security guidance, device enrollment instructions, conflict-resolution help, and disaster-recovery procedures.

This phase establishes the complete pre-audit release gate for the ten improvements.

---

## 23. Mandatory Repeated Specialist Audit-and-Fix Cycles

The final five phases are deliberately repetitive. Each cycle must inspect the actual implementation, not merely restate the plan. Each cycle must produce a findings record, assign every finding to a specialist owner, implement fixes, add or update regression coverage, rerun the relevant validation, and re-check the previous cycle’s findings. A cycle may not be marked complete while a fix is unverified.

### Phase 11 — Audit Cycle 1: Architecture and deployment specialist review

A deployment and architecture specialist reviews the complete two-tier implementation against the ten improvement points. The review covers single-node packaging, advanced PostgreSQL mode, Docker Compose, secrets, TLS, service startup, persistent volumes, database migrations, deployment portability, health endpoints, and upgrade/rollback scripts.

The specialist must identify missing deployment steps, unsafe defaults, duplicated sync implementations, undocumented prerequisites, platform incompatibilities, and accidental dependence on Ledgr-hosted infrastructure. Findings are converted into fixes or explicit release blockers. The team rebuilds the package from a clean environment, starts it, runs health checks, creates a test workspace, and proves that the documented installation works.

**Exit criteria:** clean-install success, upgrade/rollback proof, no undocumented required step, no default production secret, and architecture findings closed or explicitly escalated.

### Phase 12 — Audit Cycle 2: Accounting integrity, sync safety, and data-recovery specialist review

An accounting and recovery specialist tests operation-level synchronization against double-entry, immutable history, period close, inventory, locations, POS sessions, shop close, invoice allocation, payroll, fixed assets, manufacturing, trade, projects, and multi-book isolation.

The specialist tests two-device offline edits, same-record conflicts, duplicate operation replay, stale revisions, device sequence reuse, server restore, backup corruption, wrong-book restore, pending outbox recovery, and network failure. The specialist verifies that every accepted operation remains auditable and that no conflict can silently overwrite financial history.

**Exit criteria:** all critical accounting invariants pass on client and server, recovery drills succeed, cross-book tests pass, and every data-loss or double-posting risk is closed or explicitly blocked from release.

### Phase 13 — Audit Cycle 3: Security, identity, privacy, and self-host operations specialist review

A security specialist reviews authentication, OIDC/PKCE, device enrollment, revocation, roles, locations, CORS, TLS, rate limits, secrets, logs, backups, database exposure, request validation, dependency vulnerabilities, and privacy disclosures.

The specialist attempts unauthorized cross-book access, forged actor identities, replayed operations, reused device sequences, revoked-device access, malformed payloads, oversized requests, token leakage, unsafe log output, public database exposure, and backup disclosure. The specialist also reviews the owner’s operational burden and produces a minimum secure deployment profile.

**Exit criteria:** security tests pass, sensitive values are not logged or exposed, revoked devices are denied, database access is private, documented minimum hardening is complete, and all high-severity findings are fixed before continuing.

### Phase 14 — Audit Cycle 4: Mobile, web, UX, accessibility, and device QA specialist review

A cross-platform QA and UX specialist reviews Android, iOS, and web behavior for local-only mode, setup wizard, backup/recovery, private sync, offline queue, health, device enrollment, role/location scope, and conflict resolution.

The specialist tests small screens, tablet layouts, web keyboard use, slow networks, airplane mode, app restart, background/foreground transitions, permission denial, QR enrollment, readable error states, screen-reader labels, focus order, color contrast, loading states, and navigation back behavior. The specialist confirms that infrastructure complexity does not clutter the accounting UI.

**Exit criteria:** critical workflows are usable on supported platforms, accessibility regressions are fixed, offline and reconnect behavior is understandable, no blocked route or misleading status remains, and mobile layouts remain uncluttered.

### Phase 15 — Audit Cycle 5: Final release, documentation, regression, and gap-closure specialist review

A release specialist performs an end-to-end final audit across all ten improvement points and all prior cycle findings. The specialist checks repository hygiene, branch discipline, versioning, release builds, web export, server packaging, documentation accuracy, deployment commands, backup/restore runbooks, migration instructions, support limitations, legal-entity language, and user-facing claims.

The specialist reruns the complete application and server validation suites, performs a clean installation from the published package, runs a local-only journey, runs a private-sync journey, executes a conflict scenario, completes a backup and restore drill, revokes a device, and verifies rollback documentation. Any new finding is assigned and fixed before final sign-off; if a finding is owner-controlled, it must be clearly labeled in the release checklist rather than hidden.

**Exit criteria:** all ten improvements are demonstrably implemented, all five audit cycles have closed their findings, all release gates pass, documentation matches the shipped behavior, and the product is ready for controlled release rather than merely code-complete.

---

## 24. Ten-Point Coverage Matrix

| Improvement requested | Planned phase(s) | Final audit coverage |
|---|---|---|
| One-command or one-click deployment | 4, 10 | 11, 15 |
| Bundled single-node mode | 5 | 11, 15 |
| Advanced PostgreSQL deployment | 6 | 11, 13, 15 |
| QR enrollment and revocation | 7 | 13, 14, 15 |
| Encrypted backups, retention, restore test | 3, 10 | 12, 13, 15 |
| Server health page | 8 | 11, 13, 15 |
| Offline queue and human conflict resolution | 8 | 12, 14, 15 |
| Local-to-private migration without raw database transfer | 9 | 12, 14, 15 |
| Minimum requirements, upgrade, rollback | 10 | 11, 15 |
| Clear backup/sync/future-hosted-ERP separation | 1, 2, 9, 10 | 14, 15 |

## 25. Audit Finding Protocol

Every audit cycle must write findings in a structured format:

| Field | Required content |
|---|---|
| Finding ID | Stable identifier such as `AUDIT-12-004`. |
| Specialist area | Architecture, accounting, security, UX, release, or another defined area. |
| Severity | Blocker, critical, high, medium, low, or informational. |
| Evidence | Test, file, deployment run, screenshot, log, or reproducible scenario. |
| Risk | What could fail, be misunderstood, or lose data. |
| Assigned fix | Specific implementation task and owner. |
| Regression test | Test that prevents recurrence. |
| Verification | Exact command, environment, or scenario used to verify the fix. |
| Status | Open, fixed, verified, accepted owner dependency, or rejected with evidence. |

A final release must have no unverified blocker or critical findings. Medium and low findings may remain only when they are documented, risk-assessed, and explicitly accepted for the release.

## 26. Revised Definition of Done

The initiative is complete only when all 15 phases are complete, all ten self-hosting improvements are implemented, the five audit cycles have been executed, every actionable finding has been fixed and verified, and the final release audit confirms that the documentation, deployment package, application behavior, server behavior, backups, migration, security model, and user-facing claims all match the shipped product.
