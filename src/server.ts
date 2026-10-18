import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { createMailer } from './lib/mailer.js';
import { createQueues, createRedis } from './queue/index.js';
import { startWorkers } from './workers/index.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL, env.DB_POOL_MAX);
const redis = createRedis(env.REDIS_URL);
const queues = createQueues(redis);
const app = await buildApp({ env, db, redis, queues });

if (env.RUN_MIGRATIONS) {
  await migrate(db, (msg) => app.log.info(msg));
}

const workers =
  env.PROCESS_ROLE === 'api'
    ? null
    : startWorkers({
        db,
        mailer: createMailer(env),
        connection: redis,
        concurrency: env.WORKER_CONCURRENCY,
        log: app.log,
      });

if (env.PROCESS_ROLE !== 'worker') {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}
app.log.info({ role: env.PROCESS_ROLE, mailDriver: env.MAIL_DRIVER }, 'service started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await workers?.close();
    await queues.close();
    await redis.quit();
    await db.end();
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
