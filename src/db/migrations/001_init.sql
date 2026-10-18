CREATE TYPE user_role AS ENUM ('organizer', 'customer');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id      uuid NOT NULL REFERENCES users (id),
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  venue             text NOT NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,
  capacity          integer NOT NULL CHECK (capacity > 0),
  available_tickets integer NOT NULL,
  price_cents       integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_available_within_capacity CHECK (available_tickets >= 0 AND available_tickets <= capacity),
  CONSTRAINT events_ends_after_start CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE bookings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events (id),
  customer_id uuid NOT NULL REFERENCES users (id),
  quantity    integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
