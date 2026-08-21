CREATE TABLE IF NOT EXISTS sync_books (
  book_id TEXT PRIMARY KEY,
  book_epoch TEXT NOT NULL,
  epoch_number BIGINT NOT NULL DEFAULT 1,
  epoch_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_sequence BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sync_books ADD COLUMN IF NOT EXISTS epoch_number BIGINT NOT NULL DEFAULT 1;
ALTER TABLE sync_books ADD COLUMN IF NOT EXISTS epoch_started_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sync_books ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS sync_book_epochs (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_epoch TEXT NOT NULL,
  epoch_number BIGINT NOT NULL,
  start_sequence BIGINT NOT NULL,
  end_sequence BIGINT,
  previous_epoch TEXT,
  reason TEXT,
  advanced_by TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  PRIMARY KEY (book_id, book_epoch),
  UNIQUE (book_id, epoch_number)
);
INSERT INTO sync_book_epochs(book_id, book_epoch, epoch_number, start_sequence, started_at)
SELECT book_id, book_epoch, epoch_number, 1, epoch_started_at FROM sync_books
ON CONFLICT (book_id, book_epoch) DO NOTHING;

CREATE TABLE IF NOT EXISTS sync_events (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_epoch TEXT NOT NULL,
  book_sequence BIGINT NOT NULL,
  aggregate_revision BIGINT NOT NULL DEFAULT 1,
  op_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_sequence BIGINT NOT NULL,
  payload_hash TEXT NOT NULL,
  operation JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, book_sequence)
);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS book_epoch TEXT;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS aggregate_revision BIGINT NOT NULL DEFAULT 1;
UPDATE sync_events SET book_epoch = COALESCE(operation->>'bookEpoch', (SELECT book_epoch FROM sync_books WHERE sync_books.book_id = sync_events.book_id)) WHERE book_epoch IS NULL;
ALTER TABLE sync_events ALTER COLUMN book_epoch SET NOT NULL;
ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS sync_events_op_id_key;
ALTER TABLE sync_events DROP CONSTRAINT IF EXISTS sync_events_book_id_device_id_device_sequence_key;
CREATE UNIQUE INDEX IF NOT EXISTS sync_events_epoch_op_id_uidx ON sync_events(book_id, book_epoch, op_id);
CREATE UNIQUE INDEX IF NOT EXISTS sync_events_epoch_device_sequence_uidx ON sync_events(book_id, book_epoch, device_id, device_sequence);
CREATE INDEX IF NOT EXISTS sync_events_book_epoch_cursor_idx ON sync_events(book_id, book_epoch, book_sequence);
CREATE INDEX IF NOT EXISTS sync_events_epoch_aggregate_revision_idx ON sync_events(book_id, book_epoch, ((operation->>'aggregateId')), aggregate_revision);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  conflict_id BIGSERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_epoch TEXT NOT NULL,
  op_id TEXT NOT NULL,
  aggregate_id TEXT,
  canonical_op_id TEXT,
  reason TEXT NOT NULL,
  local_operation JSONB,
  canonical_event JSONB,
  base_revision BIGINT,
  canonical_revision BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'superseded')),
  resolution_type TEXT,
  resolution_op_id TEXT,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS book_epoch TEXT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS aggregate_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS canonical_op_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS local_operation JSONB;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS canonical_event JSONB;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS base_revision BIGINT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS canonical_revision BIGINT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS resolution_type TEXT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS resolution_op_id TEXT;
ALTER TABLE sync_conflicts ADD COLUMN IF NOT EXISTS resolved_by TEXT;
UPDATE sync_conflicts SET book_epoch = (SELECT book_epoch FROM sync_books WHERE sync_books.book_id = sync_conflicts.book_id) WHERE book_epoch IS NULL;
UPDATE sync_conflicts SET status = 'resolved' WHERE resolved_at IS NOT NULL AND status = 'open';
ALTER TABLE sync_conflicts ALTER COLUMN book_epoch SET NOT NULL;
CREATE INDEX IF NOT EXISTS sync_conflicts_inbox_idx ON sync_conflicts(book_id, book_epoch, status, created_at DESC);
WITH ranked_open_conflicts AS (
  SELECT conflict_id, ROW_NUMBER() OVER (PARTITION BY book_id, book_epoch, op_id, reason ORDER BY created_at, conflict_id) AS duplicate_number
  FROM sync_conflicts WHERE status = 'open'
)
UPDATE sync_conflicts AS conflict
SET status = 'superseded', resolved_at = COALESCE(conflict.resolved_at, now())
FROM ranked_open_conflicts AS ranked
WHERE conflict.conflict_id = ranked.conflict_id AND ranked.duplicate_number > 1;
CREATE UNIQUE INDEX IF NOT EXISTS sync_conflicts_open_dedupe_uidx ON sync_conflicts(book_id, book_epoch, op_id, reason) WHERE status = 'open';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sync_conflicts_status_check') THEN
    ALTER TABLE sync_conflicts ADD CONSTRAINT sync_conflicts_status_check CHECK (status IN ('open', 'resolved', 'superseded'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sync_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_epoch TEXT NOT NULL,
  through_sequence BIGINT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  aggregate_revisions JSONB NOT NULL DEFAULT '{}'::jsonb,
  projection_hash TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (book_id, book_epoch, through_sequence, payload_hash)
);
ALTER TABLE sync_snapshots ADD COLUMN IF NOT EXISTS aggregate_revisions JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE sync_snapshots AS snapshot
SET aggregate_revisions = COALESCE((
  SELECT jsonb_object_agg(revisions.aggregate_id, revisions.revision)
  FROM (
    SELECT event.operation->>'aggregateId' AS aggregate_id, MAX(event.aggregate_revision) AS revision
    FROM sync_events AS event
    WHERE event.book_id = snapshot.book_id
      AND event.book_epoch = snapshot.book_epoch
      AND event.book_sequence <= snapshot.through_sequence
      AND NULLIF(event.operation->>'aggregateId', '') IS NOT NULL
    GROUP BY event.operation->>'aggregateId'
  ) AS revisions
), '{}'::jsonb)
WHERE snapshot.aggregate_revisions = '{}'::jsonb;
CREATE INDEX IF NOT EXISTS sync_snapshots_latest_idx ON sync_snapshots(book_id, book_epoch, through_sequence DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_epoch TEXT NOT NULL,
  through_sequence BIGINT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  PRIMARY KEY (book_id, book_epoch, through_sequence)
);

CREATE TABLE IF NOT EXISTS sync_projection_hashes (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_epoch TEXT NOT NULL,
  through_sequence BIGINT NOT NULL,
  source_id TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, book_epoch, through_sequence, source_id)
);

CREATE TABLE IF NOT EXISTS sync_memberships (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'accountant', 'editor', 'viewer', 'auditor')),
  PRIMARY KEY (book_id, subject)
);
ALTER TABLE sync_memberships DROP CONSTRAINT IF EXISTS sync_memberships_role_check;
ALTER TABLE sync_memberships ADD CONSTRAINT sync_memberships_role_check CHECK (role IN ('owner', 'admin', 'accountant', 'editor', 'viewer', 'auditor'));

CREATE TABLE IF NOT EXISTS sync_devices (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  enrolled_epoch TEXT,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '90 days'),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  PRIMARY KEY (book_id, device_id)
);
ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS enrolled_epoch TEXT;
ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS revocation_reason TEXT;
ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE sync_devices SET expires_at = enrolled_at + interval '90 days' WHERE expires_at IS NULL;
ALTER TABLE sync_devices ALTER COLUMN expires_at SET NOT NULL;
UPDATE sync_devices SET enrolled_epoch = (SELECT book_epoch FROM sync_books WHERE sync_books.book_id = sync_devices.book_id) WHERE enrolled_epoch IS NULL;
ALTER TABLE sync_devices ALTER COLUMN enrolled_epoch SET NOT NULL;

ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE sync_devices ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE sync_memberships ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS sync_membership_locations (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  location_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, subject, location_id)
);
CREATE INDEX IF NOT EXISTS sync_membership_locations_subject_idx ON sync_membership_locations(book_id, subject);
CREATE INDEX IF NOT EXISTS sync_devices_book_status_idx ON sync_devices(book_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS sync_enrollment_codes (
  code_id UUID PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  location_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_device TEXT
);
CREATE INDEX IF NOT EXISTS sync_enrollment_codes_book_idx ON sync_enrollment_codes(book_id, expires_at, used_at);
