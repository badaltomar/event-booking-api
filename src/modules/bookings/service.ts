import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/pool.js';
import { isUniqueViolation, withTransaction } from '../../db/pool.js';
import { Batcher } from '../../lib/batcher.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { toPage, type Pagination } from '../../lib/schemas.js';
import type { Queues } from '../../queue/index.js';
import { lockShards, takeFromShards, totalRemaining } from '../events/inventory.js';

interface BookingRow {
  id: string;
  event_id: string;
  customer_id: string;
  quantity: number;
  total_cents: number;
  created_at: Date;
}

interface BookingWithEventRow extends BookingRow {
  title: string;
  venue: string;
  starts_at: Date;
}

const toBooking = (row: BookingRow) => ({
  id: row.id,
  eventId: row.event_id,
  customerId: row.customer_id,
  quantity: row.quantity,
  totalCents: row.total_cents,
  createdAt: row.created_at.toISOString(),
});

const toBookingWithEvent = (row: BookingWithEventRow) => ({
  ...toBooking(row),
  event: { title: row.title, venue: row.venue, startsAt: row.starts_at.toISOString() },
});

/**
 * Fast path, one statement and one round trip. It picks a random inventory shard that has enough
 * tickets and is not locked by another buyer, takes the tickets from it, and records the booking.
 * Buyers working on different shards never wait for each other, and the row check makes selling
 * the same ticket twice impossible. It returns nothing when no free shard fits, which the slow
 * path below then resolves.
 */
const RESERVE_AND_BOOK = `
  WITH picked AS (
    SELECT i.shard, e.price_cents
      FROM event_inventory i
      JOIN events e ON e.id = i.event_id
     WHERE i.event_id = $1 AND i.remaining >= $3 AND e.starts_at > now()
     ORDER BY random()
     LIMIT 1
       FOR UPDATE OF i SKIP LOCKED
  ), reserved AS (
    UPDATE event_inventory i
       SET remaining = i.remaining - $3
      FROM picked
     WHERE i.event_id = $1 AND i.shard = picked.shard
    RETURNING picked.price_cents
  )
  INSERT INTO bookings (event_id, customer_id, quantity, total_cents, idempotency_key)
  SELECT $1, $2, $3, price_cents * $3, $4 FROM reserved
  RETURNING id, event_id, customer_id, quantity, total_cents, created_at`;

interface CreateBookingInput {
  eventId: string;
  customerId: string;
  quantity: number;
  idempotencyKey?: string;
}

export function createBookingService({ db, queues, log }: { db: Db; queues: Queues; log: FastifyBaseLogger }) {
  interface EventAvailability {
    price_cents: number;
    starts_at: Date;
    available: number;
  }

  /** Reads availability without taking locks, to tell a real rejection from a fast path miss. */
  async function inspectEvent(eventId: string): Promise<EventAvailability> {
    const { rows } = await db.query<EventAvailability>(
      `SELECT e.price_cents, e.starts_at,
              COALESCE((SELECT SUM(remaining) FROM event_inventory WHERE event_id = e.id), 0)::int AS available
         FROM events e WHERE e.id = $1`,
      [eventId],
    );
    if (!rows[0]) throw notFound('Event');
    return rows[0];
  }

  function rejectionFor(event: EventAvailability, quantity: number) {
    if (event.starts_at <= new Date()) return conflict('EVENT_STARTED', 'Booking is closed for this event');
    if (event.available === 0) return conflict('SOLD_OUT', 'This event is sold out');
    if (event.available < quantity) {
      return conflict('INSUFFICIENT_TICKETS', `Only ${event.available} tickets are left, you asked for ${quantity}`);
    }
    return null;
  }

  /**
   * Slow path, taken when the fast path found no free shard that fits on its own: another buyer
   * held the lock, or the order spans shards. It locks every shard in order, so it waits its turn
   * and can combine tickets from several shards. Rare, because most orders end on the fast path.
   */
  async function bookAcrossShards(input: CreateBookingInput, event: EventAvailability) {
    return withTransaction(db, async (tx) => {
      const shards = await lockShards(tx, input.eventId);
      const rejection = rejectionFor({ ...event, available: totalRemaining(shards) }, input.quantity);
      if (rejection) throw rejection;
      await takeFromShards(tx, input.eventId, shards, input.quantity);
      const { rows } = await tx.query<BookingRow>(
        `INSERT INTO bookings (event_id, customer_id, quantity, total_cents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, event_id, customer_id, quantity, total_cents, created_at`,
        [input.eventId, input.customerId, input.quantity, event.price_cents * input.quantity, input.idempotencyKey ?? null],
      );
      return rows[0]!;
    });
  }

  async function findByIdempotencyKey(customerId: string, key: string) {
    const { rows } = await db.query<BookingRow>(
      `SELECT id, event_id, customer_id, quantity, total_cents, created_at
         FROM bookings WHERE customer_id = $1 AND idempotency_key = $2`,
      [customerId, key],
    );
    return rows[0];
  }

  // Confirmation jobs are queued in groups, off the request path. A group lost to a Redis outage
  // is not fatal: the booking is already stored, and the reconcile job in the worker re-queues it.
  const confirmations = new Batcher<{ name: string; data: { bookingId: string }; opts: { jobId: string } }>(
    (jobs) => queues.bookingConfirmation.addBulk(jobs).then(() => undefined),
    (err, jobs) => log.error({ err, count: jobs.length }, 'could not queue booking confirmations'),
  );
  const enqueueConfirmation = (bookingId: string) =>
    confirmations.add({
      name: 'booking-confirmation',
      data: { bookingId },
      opts: { jobId: `booking-confirmation-${bookingId}` },
    });

  return {
    /** Sends any confirmation jobs still buffered. Call before closing the queues. */
    flushPending: () => confirmations.close(),

    async create({ eventId, customerId, quantity, idempotencyKey }: CreateBookingInput) {
      try {
        const { rows } = await db.query<BookingRow>(RESERVE_AND_BOOK, [
          eventId,
          customerId,
          quantity,
          idempotencyKey ?? null,
        ]);
        let booking = rows[0];
        if (!booking) {
          const event = await inspectEvent(eventId);
          const rejection = rejectionFor(event, quantity);
          if (rejection) throw rejection;
          booking = await bookAcrossShards({ eventId, customerId, quantity, idempotencyKey }, event);
        }

        enqueueConfirmation(booking.id);
        return { booking: toBooking(booking), replayed: false };
      } catch (err) {
        if (idempotencyKey && isUniqueViolation(err)) {
          const existing = await findByIdempotencyKey(customerId, idempotencyKey);
          if (existing) {
            if (existing.event_id !== eventId || existing.quantity !== quantity) {
              throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different booking');
            }
            return { booking: toBooking(existing), replayed: true };
          }
        }
        throw err;
      }
    },

    async listForCustomer(customerId: string, pagination: Pagination) {
      const { rows } = await db.query<BookingWithEventRow>(
        `SELECT b.id, b.event_id, b.customer_id, b.quantity, b.total_cents, b.created_at,
                e.title, e.venue, e.starts_at
           FROM bookings b
           JOIN events e ON e.id = b.event_id
          WHERE b.customer_id = $1
          ORDER BY b.created_at DESC, b.id
          LIMIT $2 OFFSET $3`,
        [customerId, pagination.limit + 1, pagination.offset],
      );
      return toPage(rows.map(toBookingWithEvent), pagination);
    },

    async getForCustomer(bookingId: string, customerId: string) {
      const { rows } = await db.query<BookingWithEventRow>(
        `SELECT b.id, b.event_id, b.customer_id, b.quantity, b.total_cents, b.created_at,
                e.title, e.venue, e.starts_at
           FROM bookings b
           JOIN events e ON e.id = b.event_id
          WHERE b.id = $1`,
        [bookingId],
      );
      const row = rows[0];
      if (!row) throw notFound('Booking');
      if (row.customer_id !== customerId) throw forbidden('You can only view your own bookings');
      return toBookingWithEvent(row);
    },
  };
}

export type BookingService = ReturnType<typeof createBookingService>;
