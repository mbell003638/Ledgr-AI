CREATE TABLE IF NOT EXISTS sync_books (
  book_id TEXT PRIMARY KEY,
  book_epoch TEXT NOT NULL,
  next_sequence BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_events (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  book_sequence BIGINT NOT NULL,
  aggregate_revision BIGINT NOT NULL DEFAULT 1,
  op_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  device_sequence BIGINT NOT NULL,
  payload_hash TEXT NOT NULL,
  operation JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, book_sequence),
  UNIQUE (book_id, device_id, device_sequence)
);

CREATE INDEX IF NOT EXISTS sync_events_book_cursor_idx ON sync_events(book_id, book_sequence);
CREATE INDEX IF NOT EXISTS sync_events_aggregate_revision_idx ON sync_events(book_id, ((operation->>'aggregateId')), aggregate_revision);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  conflict_id BIGSERIAL PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_memberships (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (book_id, subject)
);

CREATE TABLE IF NOT EXISTS sync_devices (
  book_id TEXT NOT NULL REFERENCES sync_books(book_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (book_id, device_id)
);

ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS aggregate_revision BIGINT NOT NULL DEFAULT 1;
