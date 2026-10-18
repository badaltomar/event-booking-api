import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { Mailer } from '../lib/mailer.js';
import { bookingConfirmation, eventUpdated } from '../emails/templates.js';
import {
  QUEUE_NAMES,
  type BookingConfirmationJob,
  type EventUpdateEmailJob,
  type EventUpdateFanoutJob,
  type Queues,
} from '../queue/index.js';

interface WorkerDeps {
  db: Db;
  mailer: Mailer;
  queues: Queues;
  connection: Redis;
  concurrency: number;
  log: FastifyBaseLogger;
}

interface BookingEmailRow {
  id: string;
  quantity: number;
  total_cents: number;
  customer_name: string;
  customer_email: string;
  title: string;
  venue: string;
  starts_at: Date;
}

const FANOUT_BATCH_SIZE = 1_000;

export async function startWorkers(deps: WorkerDeps): Promise<{ close(): Promise<void> }> {
  const { db, mailer, queues, connection, concurrency, log } = deps;

  const confirmationWorker = new Worker<BookingConfirmationJob>(
    QUEUE_NAMES.bookingConfirmation,
    async (job) => {
      const { rows } = await db.query<BookingEmailRow>(
        `SELECT b.id, b.quantity, b.total_cents,
                u.name AS customer_name, u.email AS customer_email,
                e.title, e.venue, e.starts_at
           FROM bookings b
           JOIN users u ON u.id = b.customer_id
           JOIN events e ON e.id = b.event_id
          WHERE b.id = $1`,
        [job.data.bookingId],
      );
      const row = rows[0];
      if (!row) return;

      await mailer.send({
        to: row.customer_email,
        toName: row.customer_name,
        ...bookingConfirmation({
          customerName: row.customer_name,
          bookingId: row.id,
          quantity: row.quantity,
          totalCents: row.total_cents,
          eventTitle: row.title,
          venue: row.venue,
          startsAt: row.starts_at,
        }),
      });
    },
    { connection, concurrency },
  );

  // Expands one "event updated" job into one email job per customer, a page at a time,
  // so a single email failing is retried on its own and never re-sends to everyone.
  const fanoutWorker = new Worker<EventUpdateFanoutJob>(
    QUEUE_NAMES.eventUpdateFanout,
    async (job) => {
      const { eventId, version, changes } = job.data;

      const { rows: events } = await db.query<{ version: number }>('SELECT version FROM events WHERE id = $1', [eventId]);
      if (!events[0]) return;
      if (events[0].version < version) {
        throw new Error('event update is not committed yet');
      }

      let cursor = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        const { rows } = await db.query<{ customer_id: string }>(
          `SELECT customer_id
             FROM bookings
            WHERE event_id = $1 AND customer_id > $2
            GROUP BY customer_id
            ORDER BY customer_id
            LIMIT $3`,
          [eventId, cursor, FANOUT_BATCH_SIZE],
        );
        if (rows.length === 0) break;

        await queues.eventUpdate.addBulk(
          rows.map(({ customer_id }) => ({
            name: 'event-update-email',
            data: { eventId, customerId: customer_id, changes },
            opts: { jobId: `event-update-${eventId}-${version}-${customer_id}` },
          })),
        );
        cursor = rows[rows.length - 1]!.customer_id;
      }
    },
    { connection, concurrency: 2 },
  );

  const eventUpdateWorker = new Worker<EventUpdateEmailJob>(
    QUEUE_NAMES.eventUpdate,
    async (job) => {
      const { rows } = await db.query<{ name: string; email: string; title: string }>(
        `SELECT u.name, u.email, e.title
           FROM users u, events e
          WHERE u.id = $1 AND e.id = $2`,
        [job.data.customerId, job.data.eventId],
      );
      const row = rows[0];
      if (!row) return;

      await mailer.send({
        to: row.email,
        toName: row.name,
        ...eventUpdated({ customerName: row.name, eventTitle: row.title, changes: job.data.changes }),
      });
    },
    { connection, concurrency },
  );

  const all = [confirmationWorker, fanoutWorker, eventUpdateWorker];
  for (const worker of all) {
    worker.on('failed', (job, err) => {
      log.error({ queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err }, 'job failed');
    });
    worker.on('error', (err) => log.error({ queue: worker.name, err }, 'worker error'));
  }

  return {
    close: async () => {
      await Promise.all(all.map((w) => w.close()));
    },
  };
}
