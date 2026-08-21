#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
MODE="${1:-single-node}"
fail() { echo "Ledgr deployment preflight failed: $*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail "Docker Engine 24+ is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
free_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
[ "${free_kb:-0}" -ge 10485760 ] || fail "At least 10 GiB free disk is required for database, backups, and rollback evidence."
[ -f .env ] || fail "Create deploy/.env from the appropriate configuration template."
[ -s secrets/metrics_token ] || fail "Missing secrets/metrics_token."
[ -s secrets/database_url ] || fail "Missing secrets/database_url."
chmod 600 secrets/metrics_token secrets/database_url
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
[ -n "${CORS_ORIGIN}" ] || fail "CORS_ORIGIN is required."
[ "${CORS_ORIGIN}" != "*" ] || fail "CORS_ORIGIN must be explicit."
case "${MODE}" in
  single-node) docker compose config --quiet ;;
  advanced) grep -Eiq '(^|[?&])sslmode=(require|verify-ca|verify-full)($|&)' secrets/database_url || fail "Advanced DATABASE_URL must declare TLS sslmode."; docker compose -f docker-compose.advanced.yml config --quiet ;;
  *) fail "Mode must be single-node or advanced." ;;
esac
echo "Preflight passed for ${MODE}. No services were started."
