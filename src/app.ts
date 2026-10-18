import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyRateLimit from '@fastify/rate-limit';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import type { Db } from './db/pool.js';
import { isPoolExhausted } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { registerAuth } from './plugins/auth.js';
import type { Queues } from './queue/index.js';
import { authRoutes } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { bookingRoutes } from './modules/bookings/routes.js';
import { createBookingService } from './modules/bookings/service.js';
import { eventRoutes } from './modules/events/routes.js';
import { createEventService } from './modules/events/service.js';
import { healthRoutes } from './modules/health/routes.js';

export interface AppDeps {
  env: Env;
  db: Db;
  redis: Redis;
  queues: Queues;
}

export async function buildApp({ env, db, redis, queues }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : { level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 100 * 1024,
    // Longer than the 60s idle timeout of common load balancers, so they never reuse a closed socket.
    keepAliveTimeout: 65_000,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode === 503) reply.header('retry-after', '1');
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((issue) => ({
        field: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
        message: issue.message,
      }));
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details } });
    }
    if (isResponseSerializationError(err)) {
      request.log.error({ err }, 'response did not match schema');
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
    if (isPoolExhausted(err)) {
      request.log.warn('database pool exhausted');
      return reply
        .status(503)
        .header('retry-after', '1')
        .send({ error: { code: 'SERVER_BUSY', message: 'The server is busy, please retry shortly' } });
    }
    const { statusCode, message } = err as FastifyError;
    if (typeof statusCode === 'number' && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'REQUEST_FAILED', message } });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: `${request.method} ${request.url} does not exist` } }),
  );

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Event Booking API',
        description: 'Organizers publish events. Customers browse them and book tickets.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  // Load shedding: past this many concurrent requests, fail fast so clients can back off
  // instead of waiting in a queue until they time out.
  let inFlight = 0;
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) return;
    if (inFlight >= env.MAX_IN_FLIGHT) {
      throw new AppError(503, 'SERVER_BUSY', 'The server is at capacity, please retry shortly');
    }
    inFlight++;
    reply.raw.once('close', () => {
      inFlight--;
    });
  });

  await app.register(fastifyRateLimit, { global: false, redis, nameSpace: 'rate-limit:', skipOnError: true });
  await registerAuth(app, { secret: env.JWT_SECRET, expiresIn: env.JWT_EXPIRES_IN });

  await app.register(healthRoutes({ db, redis }));
  await app.register(authRoutes(createAuthService({ db }), env.AUTH_RATE_LIMIT_PER_MINUTE));
  await app.register(eventRoutes(createEventService({ db, queues })));
  const bookingService = createBookingService({ db, queues, log: app.log });
  app.addHook('onClose', () => bookingService.flushPending());
  await app.register(bookingRoutes(bookingService));

  return app;
}
