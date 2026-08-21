# Ledgr Private Sync: setup guide

## What this is

Private Sync is optional. Ledgr still works in Local-only mode without a server. When a business needs several phones, computers, POS devices, or shops to share one book, the business can run its own private sync service.

> The QR code is an invitation, not a password for the administrator. It contains a short-lived, one-time enrollment code and the server address. It never contains the administrator’s access token.

## Choose where the server will live

| Place | Good for | What must be true |
|---|---|---|
| A computer in the office | Testing or a small business that can keep one computer on | The computer must stay powered on and connected whenever other devices need sync. |
| A VPS | A business that needs access from different places | Use a public DNS name, HTTPS, updates, backups, and a firewall. |
| A NAS | A business that already keeps data on a Synology, QNAP, TrueNAS, or similar device | Docker and Compose must be supported, storage must be reliable, and remote access should use a secure VPN or HTTPS reverse proxy. |

The service is user-owned. Ledgr does not provide or require a Ledgr-hosted server.

## Minimum tested requirements

The bundled single-node package needs **2 CPUs, 2 GB RAM, 20 GB free disk, Docker Engine 24 or newer, and Docker Compose v2**. Production is better with 4 CPUs, 4 GB RAM, SSD storage, and a daily encrypted backup copied somewhere other than the server.

The advanced PostgreSQL package needs one sync node with at least **1 CPU and 1 GB RAM**, plus a PostgreSQL 16-compatible database with TLS and at least 10 GB of service disk. PostgreSQL must stay on a private network or private database endpoint.

Every deployment needs HTTPS through Caddy or another reverse proxy, an explicit CORS origin, restricted secret files with mode `0600`, and encrypted storage or an encrypted data volume. Never expose PostgreSQL directly to the public internet.

## Set up the server

1. Put the Ledgr repository or release package on the computer, VPS, or NAS.
2. Open `sync-server/deploy`.
3. Run the no-start check first: `./preflight.sh single-node` for the bundled package or `./preflight.sh advanced` for an external PostgreSQL database.
4. Copy the matching example configuration to `.env` and replace every example value.
5. Create the required secret files with long random values. Do not commit them or put them inside the app.
6. Configure the production identity provider with Authorization Code + PKCE and register `ledgr://sync-oidc` as the mobile redirect address.
7. Point a DNS name to the host and let Caddy obtain HTTPS. A private NAS can instead be reached over a trusted VPN, but the app still needs a valid HTTPS URL for normal remote use.
8. Start the matching package with `./install.sh` or `./install-advanced.sh`.
9. Check the public liveness address `/healthz`, then verify protected readiness and operations health with the operations token.
10. Make an encrypted Ledgr backup, complete a restore drill, and test two devices before enrolling real staff.

For complete commands, backup rules, upgrades, and rollback, use `sync-server/deploy/RUNBOOK.md` and `sync-server/deploy/RELEASE_CHECKLIST.md`.

## Connect the first device

1. Keep the source device in Local-only mode while checking the local book and making a fresh encrypted backup.
2. Open **Advanced Settings → Private sync**.
3. Choose **Set up my own server** and enter the server address and identity-provider details, or use the guided setup.
4. Ledgr checks the local integrity and recent encrypted backup before it allows the first snapshot.
5. If the server is empty, review the destination and explicitly publish the first snapshot.
6. If the server already contains the business, verify the Business Account identity before installing the validated snapshot.

Ledgr sends validated accounting operations. It never copies a raw SQLite file over PostgreSQL.

## Connect another device with QR

1. On the owner or administrator device, open **Advanced Settings → Private sync → Sync Administration**.
2. Choose the role and, when needed, the shop or location scope.
3. Tap **Create QR invitation**. The invitation expires after 15 minutes and can be used once.
4. On the new device, open **Advanced Settings → Private sync → Join an existing business**.
5. Tap **Scan QR invitation** and allow camera access.
6. Confirm the server address, role, and location scope shown on the new device.
7. Enter the new user’s sign-in details if the server uses OIDC, then tap **Join this business**.
8. Give the device a name such as `Front counter tablet` or `Owner laptop`.
9. Open Sync Health and wait for the first verified update.

The QR invitation does not give the new device owner access beyond the role and locations selected by the administrator. The code is single-use and expires automatically.

## If the server is offline

Keep recording work. The device stores local operations and retries later. If the queue shows an error, open Sync Health and follow the plain-language message. A conflict is not a deleted entry; it is a request for a person to review the accepted server result.

## If a device is lost

Open Sync Administration on an administrator device, find the device by its name, and revoke it. Revocation blocks future sync without deleting accounting history. Create a new QR invitation for the replacement device.

## The safety rules

Never share an administrator access token in a QR code, screenshot, chat, or document. Never publish PostgreSQL to the internet. Keep encrypted backups off the server as well as on it. Run a restore drill before an upgrade. If the server is unavailable, use Local-only work until health checks pass again.
