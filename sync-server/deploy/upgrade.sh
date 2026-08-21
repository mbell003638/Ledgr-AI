#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
[ -f .env ] || { echo "Missing deploy/.env; copy config.production.example first." >&2; exit 1; }
[ "${UPGRADE_BACKUP_CONFIRMED:-}" = "I_HAVE_A_VERIFIED_BACKUP_AND_RESTORE_DRILL" ] || { echo "Refusing upgrade: set UPGRADE_BACKUP_CONFIRMED=I_HAVE_A_VERIFIED_BACKUP_AND_RESTORE_DRILL after completing the documented backup and restore drill." >&2; exit 1; }
docker compose config --quiet
docker compose up -d --build
docker compose ps
echo "Upgrade applied. Verify /healthz, authenticated /readyz, /v1/ops/health, and a two-device sync before reopening normal operations."
