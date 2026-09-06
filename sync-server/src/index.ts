import { createServer } from "./server.js";
import { MemoryEventStore } from "./store.js";
import { OidcAuthenticator } from "./auth.js";
import { PostgresBookAuthorizer, PostgresEventStore, runSyncMigrations, type PgPool } from "./postgres.js";
import { DefaultAccountingArbitrator } from "./arbitration.js";
import { integerEnv, requireHttpsUrl, secretEnv } from "./config.js";
import { FixedWindowRateLimiter, SyncMetrics } from "./operations.js";
import pg from "pg";

const port = integerEnv("PORT", 8787, 1, 65_535);
const host = process.env.HOST ?? "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const databaseUrl = secretEnv("DATABASE_URL");
const operationsToken = secretEnv("METRICS_TOKEN");
const corsOrigin = process.env.CORS_ORIGIN?.trim();
if (isProduction && !databaseUrl) throw new Error("DATABASE_URL or DATABASE_URL_FILE is required in production");
if (isProduction && !operationsToken) throw new Error("METRICS_TOKEN or METRICS_TOKEN_FILE is required in production");
if (isProduction && (!corsOrigin || corsOrigin === "*")) throw new Error("an explicit CORS_ORIGIN is required in production");

let pool: PgPool | undefined;
let store: PostgresEventStore | MemoryEventStore;
let authorizer: PostgresBookAuthorizer | undefined;
if (databaseUrl) {
  pool = new pg.Pool({ connectionString: databaseUrl, max: integerEnv("DB_POOL_MAX", 10, 1, 100), ssl: process.env.DB_SSL === "require" ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false" } : undefined }) as unknown as PgPool;
  await runSyncMigrations(pool);
  store = new PostgresEventStore(pool);
  authorizer = new PostgresBookAuthorizer(pool, { enrollmentTtlDays: integerEnv("DEVICE_ENROLLMENT_TTL_DAYS", 90, 1, 3650) });
} else {
  store = new MemoryEventStore();
}

const issuer = requireHttpsUrl("OIDC_ISSUER", process.env.OIDC_ISSUER, isProduction);
const audience = process.env.OIDC_AUDIENCE;
const jwksUrl = requireHttpsUrl("OIDC_JWKS_URL", process.env.OIDC_JWKS_URL, isProduction);
const authenticator = issuer && audience && jwksUrl
  ? new OidcAuthenticator({ issuer, audience, jwksUrl })
  : undefined;
if (isProduction && !authenticator) throw new Error("OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URL are required in production");

const metrics = new SyncMetrics();
const rateLimiter = new FixedWindowRateLimiter(
  integerEnv("RATE_LIMIT_REQUESTS", 300, 1, 1_000_000),
  integerEnv("RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
);

// The arbitrator used to be gated on NODE_ENV while the `production` flag
// reported to clients was gated on configuration, so a deployment with a
// database and OIDC but NODE_ENV unset advertised accounting arbitration it
// was not running, and NoopAccountingArbitrator accepted unbalanced journals
// into the canonical log. One condition drives both.
const productionReady = Boolean(databaseUrl && authenticator);

const server = createServer(store, {
  authenticator,
  authorizer,
  arbitrator: productionReady ? new DefaultAccountingArbitrator(undefined, { requireState: true }) : undefined,
  recoveryStore: store,
  deviceAdministration: authorizer,
  production: productionReady,
  corsOrigin: corsOrigin ?? "*",
  operationsToken,
  metrics,
  rateLimiter,
  trustProxy: process.env.TRUST_PROXY === "true",
  maxBodyBytes: integerEnv("MAX_BODY_BYTES", 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  readiness: async () => {
    if (pool) await pool.query("SELECT 1");
  },
});
server.listen(port, host, () => console.log(JSON.stringify({ level: "info", event: "server_started", host, port, production: isProduction })));
const shutdown = async () => { server.close(); if (pool && "end" in pool) await (pool as unknown as { end(): Promise<void> }).end(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
