import type { Tx } from '../../db/pool.js';

/**
 * Remaining tickets are stored as several counter rows ("shards") per event instead of one.
 * Concurrent buyers lock different shards, so they no longer queue behind a single row.
 */
export const TICKETS_PER_SHARD = 100;
export const MAX_SHARDS = 16;

export const shardCountFor = (capacity: number) =>
  Math.min(MAX_SHARDS, Math.max(1, Math.floor(capacity / TICKETS_PER_SHARD)));

export interface Shard {
  shard: number;
  remaining: number;
}

/** Locks every shard in a fixed order, which is what keeps two such callers from deadlocking. */
export async function lockShards(tx: Tx, eventId: string): Promise<Shard[]> {
  const { rows } = await tx.query<Shard>(
    'SELECT shard, remaining FROM event_inventory WHERE event_id = $1 ORDER BY shard FOR UPDATE',
    [eventId],
  );
  return rows;
}

async function writeShards(tx: Tx, eventId: string, shards: Shard[]) {
  if (shards.length === 0) return;
  await tx.query(
    `UPDATE event_inventory i
        SET remaining = u.remaining
       FROM unnest($2::int[], $3::int[]) AS u(shard, remaining)
      WHERE i.event_id = $1 AND i.shard = u.shard`,
    [eventId, shards.map((s) => s.shard), shards.map((s) => s.remaining)],
  );
}

export const totalRemaining = (shards: Shard[]) => shards.reduce((sum, s) => sum + s.remaining, 0);

/** Takes `quantity` tickets from locked shards, fullest first. The caller must have checked the total. */
export async function takeFromShards(tx: Tx, eventId: string, shards: Shard[], quantity: number) {
  let needed = quantity;
  const changed: Shard[] = [];
  for (const shard of [...shards].sort((a, b) => b.remaining - a.remaining)) {
    if (needed === 0) break;
    const taken = Math.min(shard.remaining, needed);
    if (taken > 0) {
      changed.push({ shard: shard.shard, remaining: shard.remaining - taken });
      needed -= taken;
    }
  }
  await writeShards(tx, eventId, changed);
}

/** Adds (positive) or removes (negative) capacity. The caller must have checked that removal fits. */
export async function resizeShards(tx: Tx, eventId: string, shards: Shard[], delta: number) {
  if (delta === 0) return;
  if (delta < 0) return takeFromShards(tx, eventId, shards, -delta);

  const base = Math.floor(delta / shards.length);
  const extra = delta % shards.length;
  await writeShards(
    tx,
    eventId,
    shards.map((s, i) => ({ shard: s.shard, remaining: s.remaining + base + (i < extra ? 1 : 0) })),
  );
}
