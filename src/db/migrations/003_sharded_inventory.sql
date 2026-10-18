-- One counter row per event is a bottleneck: every buyer queues for the same row lock.
-- Tickets are now spread over several counter rows so buyers update different rows in parallel.
CREATE TABLE event_inventory (
  event_id  uuid     NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  shard     smallint NOT NULL,
  remaining integer  NOT NULL CHECK (remaining >= 0),
  PRIMARY KEY (event_id, shard)
) WITH (fillfactor = 50, autovacuum_vacuum_scale_factor = 0.01);

INSERT INTO event_inventory (event_id, shard, remaining)
SELECT e.id,
       s.shard,
       e.available_tickets / s.shards + CASE WHEN s.shard < e.available_tickets % s.shards THEN 1 ELSE 0 END
  FROM events e
 CROSS JOIN LATERAL (
   SELECT g AS shard, n AS shards
     FROM (SELECT LEAST(16, GREATEST(1, e.capacity / 100)) AS n) c, generate_series(0, c.n - 1) g
 ) s;

-- The remaining count now lives in event_inventory. Dropping the column also drops
-- the check constraint that tied it to capacity.
ALTER TABLE events DROP COLUMN available_tickets;
