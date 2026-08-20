# Ledgr self-hosted sync server (foundation)

This directory contains a small, dependency-light HTTP protocol reference for the planned offline-first sync feature. It accepts semantic operations, assigns a per-book monotonically increasing cursor, supports cursor-based pull, and makes retries idempotent by `opId` plus `payloadHash`.

It is deliberately **not production-ready accounting arbitration**. The current store is in-memory, there is no authentication or authorization, and it does not yet validate balanced journals, receipt allocation, inventory, period closing, or conflict policies. Do not use it with real financial data or expose it to the internet.

## Run locally

```sh
npm install
npm test
npm start
```

The server listens on `0.0.0.0:8787` by default. Set `PORT` and `HOST` to override. Endpoints:

- `GET /healthz`
- `GET /v1/capabilities`
- `POST /v1/sync/push` with `{ "bookId": "...", "operations": [...] }`
- `GET /v1/sync/pull?bookId=...&after=0&limit=100`

See `src/protocol.ts` for the versioned operation envelope. Clients should write their local ledger mutation and durable outbox row in one SQLite transaction, then retry the same `opId` until acknowledged.

## Production replacement boundary

Replace `MemoryEventStore` with a PostgreSQL-backed implementation behind the `EventStore` interface. A production implementation must authenticate users/devices, enforce book membership, validate dependencies and accounting invariants in one database transaction, append immutable canonical events, update projections, and retain conflict records. The server must use TLS (for example, Caddy), an OIDC provider with PKCE-compatible clients, rate/payload limits, encrypted backups, and restore drills. Never synchronize SQLite files directly.

Use Docker only as a development shape until the PostgreSQL implementation and security controls are complete:

```sh
docker build -t ledgr-sync-server .
docker run --rm -p 8787:8787 ledgr-sync-server
```
