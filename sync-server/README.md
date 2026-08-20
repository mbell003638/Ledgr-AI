# Ledgr self-host sync server

This is an optional, user-owned synchronization service for Ledgr. It stores encrypted-transport uploads of the app's current Ledgr backup format per workspace. It does not run accounting SQL, mutate journal rows, or replace the on-device ledger. The Ledgr client validates and atomically restores a pulled snapshot through its existing backup-import path.

## Run locally

```bash
cd sync-server
LEDGR_SYNC_TOKEN='replace-with-a-long-random-token' npm start
```

The service listens on `http://127.0.0.1:8787` by default when run locally. For a phone to reach a computer on the same private network, use the computer's private LAN address and keep the service behind the local firewall.

## Run with Docker

```bash
docker build -t ledgr-self-host-sync .
mkdir -p ledgr-sync-data
docker run --name ledgr-sync \
  -p 8787:8787 \
  -e LEDGR_SYNC_TOKEN='replace-with-a-long-random-token' \
  -v "$PWD/ledgr-sync-data:/app/data" \
  ledgr-self-host-sync
```

For internet exposure, put the service behind HTTPS, a private VPN, or an authenticated reverse proxy. Do not expose an unauthenticated instance to the public internet. Set `LEDGR_SYNC_ALLOWED_ORIGIN` to the web app origin when using Ledgr in a browser. The default `*` is convenient for a private mobile endpoint but should be narrowed for public deployments.

## Client configuration

In Ledgr, open **Business Tools → Integrations → User-owned sync**. Enter the server URL, the same bearer token, and a workspace identifier. Test the connection, then use **Push local**, **Pull remote**, or **Sync now**. Automatic sync is opt-in and remains disabled by default.

The client continues to work without a network connection. A local edit made after the last successful sync is never silently overwritten by a pull. If the remote copy changed too, Ledgr reports a conflict and asks the user to choose either **Push local** or **Replace local with remote**.

## Stored data

The service stores one opaque Ledgr backup snapshot per workspace as a JSON file under `LEDGR_SYNC_DATA_DIR`. Use a private volume with restricted permissions and include it in the user's own backup plan. The service does not receive or store the sync bearer token. The snapshot contains the user's Ledgr book data, so the host administrator must be trusted.

## API

`GET /v1/sync/health` checks connectivity. `GET /v1/sync/pull?workspaceId=...` returns the latest snapshot. `POST /v1/sync/push` accepts a workspace identifier, device identifier, expected remote etag, snapshot hash, and Ledgr backup snapshot. The server uses optimistic concurrency and returns HTTP 409 when another device has changed the workspace.
