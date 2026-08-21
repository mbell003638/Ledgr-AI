#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
fail() { echo "Ledgr advanced-profile preflight failed: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[ -f .env ] || fail "Create deploy/.env from config.advanced.example."
[ -s secrets/database_url ] || fail "Missing or empty secrets/database_url."
[ -s secrets/metrics_token ] || fail "Missing or empty secrets/metrics_token."
chmod 600 secrets/database_url secrets/metrics_token
read_env() { sed -n "s/^${1}=\(.*\)$/\1/p" .env | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
SYNC_DOMAIN="$(read_env SYNC_DOMAIN)"
OIDC_ISSUER="$(read_env OIDC_ISSUER)"
OIDC_AUDIENCE="$(read_env OIDC_AUDIENCE)"
OIDC_JWKS_URL="$(read_env OIDC_JWKS_URL)"
CORS_ORIGIN="$(read_env CORS_ORIGIN)"
[ -n "${SYNC_DOMAIN}" ] || fail "SYNC_DOMAIN is required."
[ -n "${OIDC_ISSUER}" ] || fail "OIDC_ISSUER is required."
[ -n "${OIDC_AUDIENCE}" ] || fail "OIDC_AUDIENCE is required."
[ -n "${OIDC_JWKS_URL}" ] || fail "OIDC_JWKS_URL is required."
[ -n "${CORS_ORIGIN}" ] && [ "${CORS_ORIGIN}" != "*" ] || fail "CORS_ORIGIN must be an explicit origin."
grep -Eiq '(^|[?&])sslmode=(require|verify-ca|verify-full)($|&)' secrets/database_url || fail "The external DATABASE_URL must declare sslmode=require, verify-ca, or verify-full."
docker compose -f docker-compose.advanced.yml config --quiet
docker compose -f docker-compose.advanced.yml up -d --build
echo "Advanced PostgreSQL profile started. Verify /healthz, authenticated /readyz, /v1/ops/health, and restore evidence before enrollment."
