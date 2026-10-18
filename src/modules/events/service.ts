import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { EventChanges } from '../../emails/templates.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { toPage, type Pagination } from '../../lib/schemas.js';
import type { Queues } from '../../queue/index.js';
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

export function createEventService({ db, queues }: { db: Db; queues: Queues }) {
  async function getOwnedEvent(eventId: string, organizerId: string) {
    const { rows } = await db.query<EventRow>('SELECT * FROM events WHERE id = $1', [eventId]);
    const row = rows[0];
    if (!row) throw notFound('Event');
    if (row.organizer_id !== organizerId) throw forbidden('You can only manage your own events');
    return row;
  }

  return {
    async create(organizerId: string, input: CreateEventInput) {
      const { rows } = await db.query<EventRow>(
        `INSERT INTO events (organizer_id, title, description, venue, starts_at, ends_at, capacity, available_tickets, price_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
         RETURNING *`,
        [
          organizerId,
          input.title,
          input.description,
          input.venue,
          input.startsAt,
          input.endsAt ?? null,
          input.capacity,
          input.priceCents,
        ],
      );
      return toEvent(rows[0]!);
    },

    async list(query: ListEventsQuery) {
      const pattern = query.q ? `%${escapeLike(query.q)}%` : null;
      const { rows } = await db.query<EventRow>(
        `SELECT * FROM events
          WHERE starts_at >= COALESCE($1::timestamptz, now())
            AND ($2::text IS NULL OR title ILIKE $2)
          ORDER BY starts_at, id
          LIMIT $3 OFFSET $4`,
        [query.from ?? null, pattern, query.limit + 1, query.offset],
      );
      return toPage(rows.map(toEvent), query);
    },

    async listByOrganizer(organizerId: string, pagination: Pagination) {
      const { rows } = await db.query<EventRow>(
        `SELECT * FROM events WHERE organizer_id = $1 ORDER BY starts_at DESC, id LIMIT $2 OFFSET $3`,
        [organizerId, pagination.limit + 1, pagination.offset],
      );
      return toPage(rows.map(toEvent), pagination);
    },

    async getById(eventId: string) {
      const { rows } = await db.query<EventRow>('SELECT * FROM events WHERE id = $1', [eventId]);
      if (!rows[0]) throw notFound('Event');
      return toEvent(rows[0]);
    },

    async update(eventId: string, organizerId: string, patch: UpdateEventInput) {
      const { updated, changes } = await withTransaction(db, async (tx) => {
        const { rows } = await tx.query<EventRow>('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId]);
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
        const sold = current.capacity - current.available_tickets;
        if (next.capacity < sold) {
          throw conflict('CAPACITY_BELOW_BOOKED', `Capacity cannot be lower than the ${sold} tickets already booked`);
        }

        const changes = diffVisibleFields(current, next);
        const capacityChanged = next.capacity !== current.capacity;
        if (Object.keys(changes).length === 0 && !capacityChanged) {
          return { updated: current, changes };
        }

        const result = await tx.query<EventRow>(
          `UPDATE events
              SET title = $2, description = $3, venue = $4, starts_at = $5, ends_at = $6,
                  capacity = $7, available_tickets = available_tickets + ($7 - capacity),
                  version = version + 1, updated_at = now()
            WHERE id = $1
            RETURNING *`,
          [eventId, next.title, next.description, next.venue, next.startsAt, next.endsAt, next.capacity],
        );
        return { updated: result.rows[0]!, changes };
      });

      if (Object.keys(changes).length > 0) {
        await notifyAttendees(updated, changes);
      }
      return toEvent(updated);
    },

    async listAttendees(eventId: string, organizerId: string, pagination: Pagination) {
      await getOwnedEvent(eventId, organizerId);
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

  async function notifyAttendees(event: EventRow, changes: EventChanges) {
    const { rows } = await db.query<{ customer_id: string }>(
      'SELECT DISTINCT customer_id FROM bookings WHERE event_id = $1',
      [event.id],
    );
    for (const { customer_id } of rows) {
      await queues.eventUpdate.add(
        'event-update-email',
        { eventId: event.id, customerId: customer_id, changes },
        { jobId: `event-update-${event.id}-${event.version}-${customer_id}` },
      );
    }
  }
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
