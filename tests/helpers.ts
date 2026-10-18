import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import type { Email, Mailer } from '../src/lib/mailer.js';
import type { Role } from '../src/lib/schemas.js';
import { createQueues, createRedis } from '../src/queue/index.js';
import { startWorkers } from '../src/workers/index.js';

export class MemoryMailer implements Mailer {
  readonly sent: Email[] = [];

  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  mailer: MemoryMailer;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/booking_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

export async function createTestContext(): Promise<TestContext> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256',
    MAIL_DRIVER: 'json',
    DB_POOL_MAX: '20',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
  });
  const db = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
  await migrate(db);

  const redis = await createRedis(env.REDIS_URL, 'client');
  const workerConnection = await createRedis(env.REDIS_URL, 'worker');
  await redis.flushdb();
  const queues = createQueues(redis);
  const app = await buildApp({ env, db, redis, queues });
  await app.ready();

  const mailer = new MemoryMailer();
  const workers = await startWorkers({ db, mailer, queues, connection: workerConnection, concurrency: 5, log: app.log });

  return {
    app,
    db,
    mailer,
    async reset() {
      await db.query('TRUNCATE bookings, events, users CASCADE');
      await redis.flushdb();
      mailer.sent.length = 0;
    },
    async close() {
      await app.close();
      await workers.close();
      await queues.close();
      await workerConnection.quit();
      await redis.quit();
      await db.end();
    },
  };
}

let counter = 0;

export async function registerUser(app: FastifyInstance, role: Role, name = `${role} ${++counter}`) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { name, email: `${role}${counter}-${Date.now()}@example.com`, password: 'password123', role },
  });
  const body = res.json<{ token: string; user: { id: string; email: string } }>();
  return { token: body.token, id: body.user.id, email: body.user.email, name };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function createEvent(app: FastifyInstance, token: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/events',
    headers: bearer(token),
    payload: {
      title: 'Test Conference',
      venue: 'Main Hall',
      startsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      capacity: 100,
      priceCents: 2500,
      ...overrides,
    },
  });
  return res.json<{ id: string; availableTickets: number }>();
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
