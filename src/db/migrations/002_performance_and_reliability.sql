-- Read paths: browsing, "my bookings", attendee lists and the notification fan-out.
CREATE INDEX events_starts_at_idx ON events (starts_at);
CREATE INDEX events_organizer_starts_at_idx ON events (organizer_id, starts_at DESC);
CREATE INDEX bookings_event_customer_idx ON bookings (event_id, customer_id);
CREATE INDEX bookings_event_created_idx ON bookings (event_id, created_at DESC);
CREATE INDEX bookings_customer_created_idx ON bookings (customer_id, created_at DESC);

-- A retried POST with the same Idempotency-Key must not book twice.
ALTER TABLE bookings ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX bookings_idempotency_key_idx ON bookings (customer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Lets the email job run twice without sending twice, and lets a sweeper find lost jobs.
ALTER TABLE bookings ADD COLUMN confirmation_sent_at timestamptz;
CREATE INDEX bookings_unconfirmed_idx ON bookings (created_at) WHERE confirmation_sent_at IS NULL;
