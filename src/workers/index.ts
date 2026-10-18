import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import type { Mailer } from '../lib/mailer.js';
import { bookingConfirmation, eventUpdated } from '../emails/templates.js';
import { QUEUE_NAMES, type BookingConfirmationJob, type EventUpdateEmailJob } from '../queue/index.js';

interface WorkerDeps {
  db: Db;
  mailer: Mailer;
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

export function startWorkers({ db, mailer, connection, concurrency, log }: WorkerDeps): { close(): Promise<void> } {
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

  for (const worker of [confirmationWorker, eventUpdateWorker]) {
    worker.on('failed', (job, err) => {
      log.error({ queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err }, 'job failed');
    });
    worker.on('error', (err) => log.error({ queue: worker.name, err }, 'worker error'));
  }

  return {
    close: async () => {
      await Promise.all([confirmationWorker.close(), eventUpdateWorker.close()]);
    },
  };
}
