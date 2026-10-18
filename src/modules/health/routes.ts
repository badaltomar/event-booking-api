import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../../db/pool.js';

export function healthRoutes({ db, redis }: { db: Db; redis: Redis }) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/health',
      {
        schema: {
          tags: ['Health'],
          summary: 'Liveness probe',
          response: { 200: z.object({ status: z.literal('ok') }) },
        },
      },
      async () => ({ status: 'ok' as const }),
    );

    r.get(
      '/health/ready',
      {
        schema: {
          tags: ['Health'],
          summary: 'Readiness probe that checks Postgres and Redis',
          response: {
            200: z.object({ status: z.literal('ready') }),
            503: z.object({ status: z.literal('unavailable'), failing: z.array(z.string()) }),
          },
        },
      },
      async (_request, reply) => {
        const checks = await Promise.allSettled([db.query('SELECT 1'), redis.ping()]);
        const failing = (['postgres', 'redis'] as const).filter((_, i) => checks[i]!.status === 'rejected');
        if (failing.length > 0) return reply.status(503).send({ status: 'unavailable', failing });
        return { status: 'ready' as const };
      },
    );
  };
}
