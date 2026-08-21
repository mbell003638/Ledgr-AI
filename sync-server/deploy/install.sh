#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

fail() { echo "Ledgr private-sync preflight failed: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Engine with the Compose plugin first."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose version)."
[ -f .env ] || fail "Create deploy/.env from config.production.example and fill every production value."
[ -f secrets/postgres_password ] || fail "Missing deploy/secrets/postgres_password."
[ -f secrets/database_url ] || fail "Missing deploy/secrets/database_url."
[ -f secrets/metrics_token ] || fail "Missing deploy/secrets/metrics_token."

for secret in secrets/postgres_password secrets/database_url secrets/metrics_token; do
  [ -s "${secret}" ] || fail "Secret file ${secret} is empty."
  chmod 600 "${secret}"
done

set -a
# shellcheck disable=SC1091
. ./.env
set +a

[ "${SYNC_DOMAIN:-}" != "" ] || fail "SYNC_DOMAIN is required."
[ "${OIDC_ISSUER:-}" != "" ] || fail "OIDC_ISSUER is required."
[ "${OIDC_AUDIENCE:-}" != "" ] || fail "OIDC_AUDIENCE is required."
[ "${OIDC_JWKS_URL:-}" != "" ] || fail "OIDC_JWKS_URL is required."
[ "${CORS_ORIGIN:-}" != "" ] || fail "CORS_ORIGIN is required and must be an explicit origin."
[ "${CORS_ORIGIN}" != "*" ] || fail "CORS_ORIGIN cannot be wildcard in production."
case "${SYNC_DOMAIN}" in *example.com|*example.org|*example.net) fail "Replace the example SYNC_DOMAIN with a real DNS name.";; esac

# Compose config performs interpolation and catches malformed YAML before any service starts.
docker compose config --quiet
mkdir -p secrets
chmod 700 secrets

echo "Preflight passed. Starting the user-owned Ledgr sync stack..."
docker compose up -d --build

echo "Stack started. Verify https://${SYNC_DOMAIN}/healthz, then use the protected /readyz and /v1/ops/health endpoints with the operations token."
echo "Schedule deploy/backup.sh from a locked-down maintenance environment after configuring AGE_RECIPIENT and SYNC_WRITES_QUIESCED."
