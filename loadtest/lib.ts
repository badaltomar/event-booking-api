import { createHmac } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';

export const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export function signToken(secret: string, userId: string, role: 'organizer' | 'customer', ttlSeconds = 24 * 3600): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: userId, role, iat: now, exp: now + ttlSeconds })}`;
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function connectDb(): pg.Pool {
  return new pg.Pool({ connectionString: required('DATABASE_URL'), max: 4 });
}

export interface QueueProbe {
  pending(): Promise<number>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/** Looks at the BullMQ queues without consuming anything. Returns null when Redis is not reachable from here. */
export function connectQueues(): QueueProbe | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  const queues = ['booking-confirmation', 'event-update', 'event-update-fanout'].map((n) => new Queue(n, { connection: redis }));
  return {
    async pending() {
      const counts = await Promise.all(queues.map((q) => q.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
      return counts.reduce((sum, c) => sum + Object.values(c).reduce((a, b) => a + b, 0), 0);
    },
    async clear() {
      await Promise.all(queues.map((q) => q.obliterate({ force: true })));
    },
    async close() {
      await Promise.all(queues.map((q) => q.close()));
      redis.disconnect();
    },
  };
}

export async function waitForDrain(probe: QueueProbe, timeoutMs = 120_000): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await probe.pending()) === 0) return (Date.now() - started) / 1000;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
