import type { Db } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { toPage, type Pagination } from '../../lib/schemas.js';
import type { Queues } from '../../queue/index.js';

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

export function createBookingService({ db, queues }: { db: Db; queues: Queues }) {
  return {
    async create(eventId: string, customerId: string, quantity: number) {
      const booking = await withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{
          available_tickets: number;
          price_cents: number;
          starts_at: Date;
        }>('SELECT available_tickets, price_cents, starts_at FROM events WHERE id = $1 FOR UPDATE', [eventId]);
        const event = rows[0];
        if (!event) throw notFound('Event');
        if (event.starts_at <= new Date()) throw conflict('EVENT_STARTED', 'Booking is closed for this event');
        if (event.available_tickets === 0) throw conflict('SOLD_OUT', 'This event is sold out');
        if (event.available_tickets < quantity) {
          throw conflict('INSUFFICIENT_TICKETS', `Only ${event.available_tickets} tickets are left`);
        }

        const inserted = await tx.query<BookingRow>(
          `INSERT INTO bookings (event_id, customer_id, quantity, total_cents)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [eventId, customerId, quantity, event.price_cents * quantity],
        );
        await tx.query('UPDATE events SET available_tickets = available_tickets - $2 WHERE id = $1', [
          eventId,
          quantity,
        ]);
        return inserted.rows[0]!;
      });

      await queues.bookingConfirmation.add(
        'booking-confirmation',
        { bookingId: booking.id },
        { jobId: `booking-confirmation-${booking.id}` },
      );
      return toBooking(booking);
    },

    async listForCustomer(customerId: string, pagination: Pagination) {
      const { rows } = await db.query<BookingWithEventRow>(
        `SELECT b.*, e.title, e.venue, e.starts_at
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
        `SELECT b.*, e.title, e.venue, e.starts_at
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
