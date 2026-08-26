#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Desktop (macOS) or Docker Engine plus Compose (Linux) is required."
  echo "Install it from https://docs.docker.com/get-docker/ and run this installer again."
  exit 1
fi

mkdir -p secrets
if [ ! -f secrets/postgres_password ]; then
  openssl rand -base64 32 > secrets/postgres_password
fi
if [ ! -f secrets/metrics_token ]; then
  openssl rand -base64 32 > secrets/metrics_token
fi
if [ ! -f secrets/database_url ]; then
  password=$(tr -d '\n' < secrets/postgres_password)
  printf 'postgres://ledgr_sync:%s@postgres:5432/ledgr_sync\n' "$password" > secrets/database_url
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env. Set the server domain and OIDC values, then run this installer again."
  exit 0
fi

docker compose pull
docker compose up -d
echo "Ledgr self-host services are running. Check https://$(grep '^SYNC_DOMAIN=' .env | cut -d= -f2)/healthz"
