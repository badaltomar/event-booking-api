import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { EventChanges } from '../emails/templates.js';

export const QUEUE_NAMES = {
  bookingConfirmation: 'booking-confirmation',
  eventUpdateFanout: 'event-update-fanout',
  eventUpdate: 'event-update',
} as const;

export interface BookingConfirmationJob {
  bookingId: string;
}

/** One job per event update. A worker expands it into one email job per customer. */
export interface EventUpdateFanoutJob {
  eventId: string;
  version: number;
  changes: EventChanges;
}

export interface EventUpdateEmailJob {
  eventId: string;
  customerId: string;
  changes: EventChanges;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

/**
 * `worker` connections block while waiting for jobs, so they must retry forever.
 * `client` connections fail fast, so an API request errors out instead of hanging when Redis is down.
 * Resolves once the connection is usable, because a fail-fast client rejects commands sent earlier.
 */
export async function createRedis(url: string, kind: 'client' | 'worker'): Promise<Redis> {
  const redis =
    kind === 'worker'
      ? new Redis(url, { maxRetriesPerRequest: null })
      : new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });

  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });
  }
  return redis;
}

export interface Queues {
  bookingConfirmation: Queue<BookingConfirmationJob>;
  eventUpdateFanout: Queue<EventUpdateFanoutJob>;
  eventUpdate: Queue<EventUpdateEmailJob>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const options = { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS };
  const queues = {
    bookingConfirmation: new Queue<BookingConfirmationJob>(QUEUE_NAMES.bookingConfirmation, options),
    eventUpdateFanout: new Queue<EventUpdateFanoutJob>(QUEUE_NAMES.eventUpdateFanout, options),
    eventUpdate: new Queue<EventUpdateEmailJob>(QUEUE_NAMES.eventUpdate, options),
  };
  return {
    ...queues,
    close: async () => {
      await Promise.all(Object.values(queues).map((q) => q.close()));
    },
  };
}
