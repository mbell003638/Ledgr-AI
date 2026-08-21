#!/bin/sh
set -eu

: "${POSTGRES_DB:=ledgr_sync}"
: "${POSTGRES_USER:=ledgr_sync}"
: "${BACKUP_DIR:=/backups}"
: "${AGE_RECIPIENT:?AGE_RECIPIENT must contain the offline backup public key}"
: "${SYNC_WRITES_QUIESCED:?Set SYNC_WRITES_QUIESCED=I_HAVE_STOPPED_ALL_SYNC_WRITERS after stopping the sync service}"

if [ "${SYNC_WRITES_QUIESCED}" != "I_HAVE_STOPPED_ALL_SYNC_WRITERS" ]; then
  echo "Refusing backup: stop every sync writer and acknowledge the maintenance window" >&2
  exit 1
fi

other_sessions="$(psql --dbname="${POSTGRES_DB}" --username="${POSTGRES_USER}" --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();" | tr -d '[:space:]')"
if [ "${other_sessions}" != "0" ]; then
  echo "Refusing backup: ${other_sessions} other database session(s) remain; dump and reconciliation manifest require one quiescent snapshot window" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${BACKUP_DIR}/ledgr-sync-${stamp}.dump.age"
temporary_dump="$(mktemp "${BACKUP_DIR}/.ledgr-sync-${stamp}.XXXXXX.dump")"
temporary_encrypted="${target}.tmp"
temporary_checksum="${target}.sha256.tmp"
manifest="${target}.manifest.age"
temporary_manifest="$(mktemp "${BACKUP_DIR}/.ledgr-sync-${stamp}.XXXXXX.manifest")"
temporary_manifest_encrypted="${manifest}.tmp"
temporary_manifest_checksum="${manifest}.sha256.tmp"
status_file="${BACKUP_STATUS_FILE:-${BACKUP_DIR}/status.json}"
temporary_status="${status_file}.tmp"
trap 'rm -f "${temporary_dump}" "${temporary_encrypted}" "${temporary_checksum}" "${temporary_manifest}" "${temporary_manifest_encrypted}" "${temporary_manifest_checksum}" "${temporary_status}"' EXIT
umask 077
pg_dump --format=custom --no-owner --no-acl --file="${temporary_dump}" --dbname="${POSTGRES_DB}" --username="${POSTGRES_USER}"
pg_restore --list "${temporary_dump}" >/dev/null
age --recipient "${AGE_RECIPIENT}" --output "${temporary_encrypted}" "${temporary_dump}"
mv "${temporary_encrypted}" "${target}"
psql --dbname="${POSTGRES_DB}" --username="${POSTGRES_USER}" --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT json_build_object('books',(SELECT COUNT(*) FROM sync_books),'events',(SELECT COUNT(*) FROM sync_events),'max_sequence',(SELECT COALESCE(MAX(book_sequence),0) FROM sync_events),'event_hash',(SELECT md5(COALESCE(string_agg(payload_hash,',' ORDER BY book_id,book_sequence),'')) FROM sync_events),'snapshots',(SELECT COUNT(*) FROM sync_snapshots),'snapshot_hash',(SELECT md5(COALESCE(string_agg(payload_hash,',' ORDER BY book_id,book_epoch,through_sequence),'')) FROM sync_snapshots),'checkpoints',(SELECT COUNT(*) FROM sync_checkpoints),'checkpoint_hash',(SELECT md5(COALESCE(string_agg(event_hash,',' ORDER BY book_id,book_epoch,through_sequence),'')) FROM sync_checkpoints),'projection_hashes',(SELECT COUNT(*) FROM sync_projection_hashes),'projection_hash',(SELECT md5(COALESCE(string_agg(projection_hash,',' ORDER BY book_id,book_epoch,through_sequence,source_id),'')) FROM sync_projection_hashes),'conflicts',(SELECT COUNT(*) FROM sync_conflicts));" > "${temporary_manifest}"
age --recipient "${AGE_RECIPIENT}" --output "${temporary_manifest_encrypted}" "${temporary_manifest}"
mv "${temporary_manifest_encrypted}" "${manifest}"
sha256sum "${target}" | awk '{print $1}' > "${temporary_checksum}"
mv "${temporary_checksum}" "${target}.sha256"
sha256sum "${manifest}" | awk '{print $1}' > "${temporary_manifest_checksum}"
mv "${temporary_manifest_checksum}" "${manifest}.sha256"
mkdir -p "$(dirname "${status_file}")"
cat > "${temporary_status}" <<EOF
{"status":"healthy","lastSuccessAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","verifiedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","backupFile":"$(basename "${target}")"}
EOF
mv "${temporary_status}" "${status_file}"
echo "Encrypted backup and reconciliation manifest written to ${target}"
