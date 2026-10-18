import type { Db, Tx } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { EventChanges } from '../../emails/templates.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { toPage, type Pagination } from '../../lib/schemas.js';
import type { Queues } from '../../queue/index.js';
import { lockShards, resizeShards, shardCountFor, totalRemaining } from './inventory.js';
import type { CreateEventInput, ListEventsQuery, UpdateEventInput } from './schemas.js';

interface EventRow {
  id: string;
  organizer_id: string;
  title: string;
  description: string;
  venue: string;
  starts_at: Date;
  ends_at: Date | null;
  capacity: number;
  available_tickets: number;
  price_cents: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** Every event read goes through this so availability is always the sum of the inventory shards. */
const SELECT_EVENT = `
  SELECT e.*, COALESCE(inv.available, 0)::int AS available_tickets
    FROM events e
    LEFT JOIN LATERAL (
      SELECT SUM(remaining) AS available FROM event_inventory WHERE event_id = e.id
    ) inv ON true`;

export const toEvent = (row: EventRow) => ({
  id: row.id,
  organizerId: row.organizer_id,
  title: row.title,
  description: row.description,
  venue: row.venue,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at?.toISOString() ?? null,
  capacity: row.capacity,
  availableTickets: row.available_tickets,
  priceCents: row.price_cents,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

async function findEvent(db: Db | Tx, eventId: string): Promise<EventRow | undefined> {
  const { rows } = await db.query<EventRow>(`${SELECT_EVENT} WHERE e.id = $1`, [eventId]);
  return rows[0];
}

export function createEventService({ db, queues }: { db: Db; queues: Queues }) {
  return {
    async create(organizerId: string, input: CreateEventInput) {
      const shards = shardCountFor(input.capacity);
      const { rows } = await db.query<EventRow>(
        `WITH created AS (
           INSERT INTO events (organizer_id, title, description, venue, starts_at, ends_at, capacity, price_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *
         ), stock AS (
           INSERT INTO event_inventory (event_id, shard, remaining)
           SELECT created.id, g, $7::int / $9::int + CASE WHEN g < $7::int % $9::int THEN 1 ELSE 0 END
             FROM created, generate_series(0, $9::int - 1) g
         )
         SELECT created.*, created.capacity AS available_tickets FROM created`,
        [
          organizerId,
          input.title,
          input.description,
          input.venue,
          input.startsAt,
          input.endsAt ?? null,
          input.capacity,
          input.priceCents,
          shards,
        ],
      );
      return toEvent(rows[0]!);
    },

    async list(query: ListEventsQuery) {
      const pattern = query.q ? `%${escapeLike(query.q)}%` : null;
      const { rows } = await db.query<EventRow>(
        `${SELECT_EVENT}
          WHERE e.starts_at >= COALESCE($1::timestamptz, now())
            AND ($2::text IS NULL OR e.title ILIKE $2)
          ORDER BY e.starts_at, e.id
          LIMIT $3 OFFSET $4`,
        [query.from ?? null, pattern, query.limit + 1, query.offset],
      );
      return toPage(rows.map(toEvent), query);
    },

    async listByOrganizer(organizerId: string, pagination: Pagination) {
      const { rows } = await db.query<EventRow>(
        `${SELECT_EVENT} WHERE e.organizer_id = $1 ORDER BY e.starts_at DESC, e.id LIMIT $2 OFFSET $3`,
        [organizerId, pagination.limit + 1, pagination.offset],
      );
      return toPage(rows.map(toEvent), pagination);
    },

    async getById(eventId: string) {
      const event = await findEvent(db, eventId);
      if (!event) throw notFound('Event');
      return toEvent(event);
    },

    async update(eventId: string, organizerId: string, patch: UpdateEventInput) {
      const updated = await withTransaction(db, async (tx) => {
        // NO KEY UPDATE does not block the foreign key checks of concurrent bookings.
        const { rows } = await tx.query<EventRow>('SELECT * FROM events WHERE id = $1 FOR NO KEY UPDATE', [eventId]);
        const current = rows[0];
        if (!current) throw notFound('Event');
        if (current.organizer_id !== organizerId) throw forbidden('You can only manage your own events');

        const next = {
          title: patch.title ?? current.title,
          description: patch.description ?? current.description,
          venue: patch.venue ?? current.venue,
          startsAt: patch.startsAt ? new Date(patch.startsAt) : current.starts_at,
          endsAt: patch.endsAt === undefined ? current.ends_at : patch.endsAt === null ? null : new Date(patch.endsAt),
          capacity: patch.capacity ?? current.capacity,
        };
        if (next.endsAt && next.endsAt <= next.startsAt) {
          throw badRequest('endsAt must be after startsAt');
        }

        const changes = diffVisibleFields(current, next);
        const capacityDelta = next.capacity - current.capacity;
        if (Object.keys(changes).length === 0 && capacityDelta === 0) {
          return (await findEvent(tx, eventId))!;
        }

        if (capacityDelta !== 0) {
          const shards = await lockShards(tx, eventId);
          const sold = current.capacity - totalRemaining(shards);
          if (next.capacity < sold) {
            throw conflict('CAPACITY_BELOW_BOOKED', `Capacity cannot be lower than the ${sold} tickets already booked`);
          }
          await resizeShards(tx, eventId, shards, capacityDelta);
        }

        const result = await tx.query<{ version: number }>(
          `UPDATE events
              SET title = $2, description = $3, venue = $4, starts_at = $5, ends_at = $6,
                  capacity = $7, version = version + 1, updated_at = now()
            WHERE id = $1
            RETURNING version`,
          [eventId, next.title, next.description, next.venue, next.startsAt, next.endsAt, next.capacity],
        );
        const { version } = result.rows[0]!;

        // Queued before COMMIT so a failed enqueue rolls the update back and the organizer can retry.
        // The worker waits for this version to be visible, so it never reacts to a rolled back update.
        if (Object.keys(changes).length > 0) {
          await queues.eventUpdateFanout.add(
            'fan-out',
            { eventId, version, changes },
            { jobId: `event-update-${eventId}-${version}` },
          );
        }
        return (await findEvent(tx, eventId))!;
      });
      return toEvent(updated);
    },

    async listAttendees(eventId: string, organizerId: string, pagination: Pagination) {
      const owner = await db.query<{ organizer_id: string }>('SELECT organizer_id FROM events WHERE id = $1', [eventId]);
      if (!owner.rows[0]) throw notFound('Event');
      if (owner.rows[0].organizer_id !== organizerId) throw forbidden('You can only manage your own events');

      const { rows } = await db.query<{
        id: string;
        customer_id: string;
        name: string;
        email: string;
        quantity: number;
        total_cents: number;
        created_at: Date;
      }>(
        `SELECT b.id, b.customer_id, u.name, u.email, b.quantity, b.total_cents, b.created_at
           FROM bookings b
           JOIN users u ON u.id = b.customer_id
          WHERE b.event_id = $1
          ORDER BY b.created_at DESC, b.id
          LIMIT $2 OFFSET $3`,
        [eventId, pagination.limit + 1, pagination.offset],
      );
      return toPage(
        rows.map((r) => ({
          bookingId: r.id,
          customerId: r.customer_id,
          customerName: r.name,
          customerEmail: r.email,
          quantity: r.quantity,
          totalCents: r.total_cents,
          bookedAt: r.created_at.toISOString(),
        })),
        pagination,
      );
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;

interface NextValues {
  title: string;
  description: string;
  venue: string;
  startsAt: Date;
  endsAt: Date | null;
}

/** Only fields a customer can see are reported; capacity changes stay internal. */
function diffVisibleFields(current: EventRow, next: NextValues): EventChanges {
  const changes: EventChanges = {};
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  if (next.title !== current.title) changes.title = { from: current.title, to: next.title };
  if (next.description !== current.description) {
    // The email only says the description changed, so the text is not copied into every job payload.
    changes.description = { from: null, to: null };
  }
  if (next.venue !== current.venue) changes.venue = { from: current.venue, to: next.venue };
  if (iso(next.startsAt) !== iso(current.starts_at)) {
    changes.startsAt = { from: iso(current.starts_at), to: iso(next.startsAt) };
  }
  if (iso(next.endsAt) !== iso(current.ends_at)) {
    changes.endsAt = { from: iso(current.ends_at), to: iso(next.endsAt) };
  }
  return changes;
}
