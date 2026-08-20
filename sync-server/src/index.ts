import { createServer } from "./server.js";
import { MemoryEventStore } from "./store.js";
import { OidcAuthenticator } from "./auth.js";
import { PostgresBookAuthorizer, PostgresEventStore, runSyncMigrations, type PgPool } from "./postgres.js";
import { DefaultAccountingArbitrator } from "./arbitration.js";
import pg from "pg";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");

const databaseUrl = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === "production";
let pool: PgPool | undefined;
let store: PostgresEventStore | MemoryEventStore;
let authorizer: PostgresBookAuthorizer | undefined;
if (databaseUrl) {
  pool = new pg.Pool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10), ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined }) as unknown as PgPool;
  await runSyncMigrations(pool);
  store = new PostgresEventStore(pool);
  authorizer = new PostgresBookAuthorizer(pool);
} else {
  if (isProduction && process.env.ALLOW_INSECURE_MEMORY_STORE !== "true") throw new Error("DATABASE_URL is required in production; memory store is for local development only");
  store = new MemoryEventStore();
}

const issuer = process.env.OIDC_ISSUER;
const audience = process.env.OIDC_AUDIENCE;
const jwksUrl = process.env.OIDC_JWKS_URL;
const authenticator = issuer && audience && jwksUrl
  ? new OidcAuthenticator({ issuer, audience, jwksUrl })
  : undefined;
if (isProduction && !authenticator && process.env.ALLOW_INSECURE_ANONYMOUS !== "true") throw new Error("OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URL are required in production");
if (isProduction && !process.env.CORS_ORIGIN) throw new Error("CORS_ORIGIN is required in production");

const server = createServer(store, {
  authenticator,
  authorizer,
  arbitrator: isProduction ? new DefaultAccountingArbitrator() : undefined,
  production: Boolean(databaseUrl && authenticator),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
});
server.listen(port, host, () => console.log(`Ledgr sync-server listening on ${host}:${port}`));
const shutdown = async () => { server.close(); if (pool && "end" in pool) await (pool as unknown as { end(): Promise<void> }).end(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
