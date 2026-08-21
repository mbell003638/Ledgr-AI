#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"
fail() { echo "Ledgr upgrade refused: $*" >&2; exit 1; }
[ -f .env ] || fail "Missing deploy/.env; copy config.production.example first."
[ "${UPGRADE_BACKUP_CONFIRMED:-}" = "I_HAVE_A_VERIFIED_BACKUP_AND_RESTORE_DRILL" ] || fail "Set UPGRADE_BACKUP_CONFIRMED=I_HAVE_A_VERIFIED_BACKUP_AND_RESTORE_DRILL after completing the documented restore drill."
[ "${SYNC_WRITES_QUIESCED:-}" = "I_HAVE_STOPPED_ALL_SYNC_WRITERS" ] || fail "Set SYNC_WRITES_QUIESCED=I_HAVE_STOPPED_ALL_SYNC_WRITERS during the maintenance window."
command -v docker >/dev/null 2>&1 || fail "Docker is required."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
[ -s secrets/metrics_token ] || fail "Missing secrets/metrics_token."
[ -s secrets/database_url ] || fail "Missing secrets/database_url."
./preflight.sh "${DEPLOYMENT_MODE:-single-node}"
backup_command="${BACKUP_COMMAND:-./backup.sh}"
backup_status_file="${BACKUP_STATUS_FILE:-/backups/status.json}"
backup_started="$(date -u +%s)"
SYNC_WRITES_QUIESCED=I_HAVE_STOPPED_ALL_SYNC_WRITERS bash -c "${backup_command}"
[ -s "${backup_status_file}" ] || fail "Pre-upgrade backup did not publish ${backup_status_file}."
grep -q '"status":"healthy"' "${backup_status_file}" || fail "Pre-upgrade backup status is not healthy."
backup_verified="$(sed -n 's/.*"verifiedAt":"\([^"]*\)".*/\1/p' "${backup_status_file}" | head -1)"
[ -n "${backup_verified}" ] || fail "Pre-upgrade backup has no verification timestamp."
backup_verified_epoch="$(date -u -d "${backup_verified}" +%s 2>/dev/null || echo 0)"
[ "${backup_verified_epoch}" -ge "${backup_started}" ] || fail "Pre-upgrade backup verification predates this upgrade attempt."
docker compose config --quiet
docker compose up -d --build
docker compose ps
echo "Upgrade applied after a verified pre-upgrade backup. Verify /healthz, authenticated /readyz, /v1/ops/health, and a two-device sync before reopening normal operations."
