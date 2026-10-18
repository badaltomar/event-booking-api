import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { EventChanges } from '../emails/templates.js';

export const QUEUE_NAMES = {
  bookingConfirmation: 'booking-confirmation',
  eventUpdate: 'event-update',
} as const;

export interface BookingConfirmationJob {
  bookingId: string;
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

export function createRedis(url: string): Redis {
  // BullMQ workers rely on blocking commands, which need request retries disabled.
  return new Redis(url, { maxRetriesPerRequest: null });
}

export interface Queues {
  bookingConfirmation: Queue<BookingConfirmationJob>;
  eventUpdate: Queue<EventUpdateEmailJob>;
  close(): Promise<void>;
}

export function createQueues(connection: Redis): Queues {
  const bookingConfirmation = new Queue<BookingConfirmationJob>(QUEUE_NAMES.bookingConfirmation, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  const eventUpdate = new Queue<EventUpdateEmailJob>(QUEUE_NAMES.eventUpdate, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return {
    bookingConfirmation,
    eventUpdate,
    close: async () => {
      await Promise.all([bookingConfirmation.close(), eventUpdate.close()]);
    },
  };
}
