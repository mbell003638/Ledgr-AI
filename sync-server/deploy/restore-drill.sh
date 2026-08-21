#!/bin/sh
set -eu

: "${BACKUP_FILE:?BACKUP_FILE must point to an encrypted .dump.age backup}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE must point to the offline recovery identity}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must target an isolated empty drill database}"
: "${EXPECTED_RESTORE_DATABASE:?EXPECTED_RESTORE_DATABASE must name the isolated drill database}"
: "${ALLOW_DESTRUCTIVE_RESTORE_DRILL:?Set ALLOW_DESTRUCTIVE_RESTORE_DRILL to the documented confirmation}"

if [ "${ALLOW_DESTRUCTIVE_RESTORE_DRILL}" != "I_UNDERSTAND_THIS_DROPS_OBJECTS" ]; then
  echo "Refusing restore: destructive drill confirmation is invalid" >&2
  exit 1
fi
actual_database="$(psql "${RESTORE_DATABASE_URL}" --set=ON_ERROR_STOP=1 --tuples-only --no-align --command='SELECT current_database();')"
if [ "${actual_database}" != "${EXPECTED_RESTORE_DATABASE}" ]; then
  echo "Refusing restore: connected database does not match EXPECTED_RESTORE_DATABASE" >&2
  exit 1
fi
case "${actual_database}" in
  *_restore_drill) ;;
  *) echo "Refusing restore: drill database name must end with _restore_drill" >&2; exit 1 ;;
esac
if [ -n "${PRODUCTION_DATABASE_URL:-}" ] && [ "${RESTORE_DATABASE_URL}" = "${PRODUCTION_DATABASE_URL}" ]; then
  echo "Refusing restore: drill URL matches the production database URL" >&2
  exit 1
fi

manifest_file="${BACKUP_FILE}.manifest.age"
expected_backup_digest="$(tr -d '[:space:]' < "${BACKUP_FILE}.sha256")"
actual_backup_digest="$(sha256sum "${BACKUP_FILE}" | awk '{print $1}')"
expected_manifest_digest="$(tr -d '[:space:]' < "${manifest_file}.sha256")"
actual_manifest_digest="$(sha256sum "${manifest_file}" | awk '{print $1}')"
if [ "${actual_backup_digest}" != "${expected_backup_digest}" ] || [ "${actual_manifest_digest}" != "${expected_manifest_digest}" ]; then
  echo "Refusing restore: backup or reconciliation-manifest checksum does not match" >&2
  exit 1
fi
temporary_dump="$(mktemp)"
expected_manifest="$(mktemp)"
actual_manifest="$(mktemp)"
trap 'rm -f "${temporary_dump}" "${expected_manifest}" "${actual_manifest}"' EXIT
age --decrypt --identity "${AGE_IDENTITY_FILE}" --output "${temporary_dump}" "${BACKUP_FILE}"
age --decrypt --identity "${AGE_IDENTITY_FILE}" --output "${expected_manifest}" "${manifest_file}"
pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl --dbname="${RESTORE_DATABASE_URL}" "${temporary_dump}"
psql "${RESTORE_DATABASE_URL}" --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="SELECT json_build_object('books',(SELECT COUNT(*) FROM sync_books),'events',(SELECT COUNT(*) FROM sync_events),'max_sequence',(SELECT COALESCE(MAX(book_sequence),0) FROM sync_events),'event_hash',(SELECT md5(COALESCE(string_agg(payload_hash,',' ORDER BY book_id,book_sequence),'')) FROM sync_events),'snapshots',(SELECT COUNT(*) FROM sync_snapshots),'snapshot_hash',(SELECT md5(COALESCE(string_agg(payload_hash,',' ORDER BY book_id,book_epoch,through_sequence),'')) FROM sync_snapshots),'checkpoints',(SELECT COUNT(*) FROM sync_checkpoints),'checkpoint_hash',(SELECT md5(COALESCE(string_agg(event_hash,',' ORDER BY book_id,book_epoch,through_sequence),'')) FROM sync_checkpoints),'projection_hashes',(SELECT COUNT(*) FROM sync_projection_hashes),'projection_hash',(SELECT md5(COALESCE(string_agg(projection_hash,',' ORDER BY book_id,book_epoch,through_sequence,source_id),'')) FROM sync_projection_hashes),'conflicts',(SELECT COUNT(*) FROM sync_conflicts));" > "${actual_manifest}"
if ! diff -u "${expected_manifest}" "${actual_manifest}"; then
  echo "Restore drill failed: restored canonical counts or hashes differ from the encrypted backup manifest" >&2
  exit 1
fi
echo "Restore drill completed; retain the command output with the operational audit record."
