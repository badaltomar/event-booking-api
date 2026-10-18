import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errors } from '../../lib/schemas.js';
import { authResponse, loginBody, registerBody, userResponse } from './schemas.js';
import type { AuthService } from './service.js';

export function authRoutes(service: AuthService, attemptsPerMinute: number) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    // Password hashing is deliberately expensive, so these two routes are throttled per client IP.
    const rateLimit = { rateLimit: { max: attemptsPerMinute, timeWindow: '1 minute' } };

    r.post(
      '/auth/register',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Create an organizer or customer account',
          body: registerBody,
          response: { 201: authResponse, ...errors(400, 409, 429) },
        },
        config: rateLimit,
      },
      async (request, reply) => {
        const user = await service.register(request.body);
        const token = app.jwt.sign({ sub: user.id, role: user.role });
        return reply.status(201).send({ user, token });
      },
    );

    r.post(
      '/auth/login',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Exchange email and password for an access token',
          body: loginBody,
          response: { 200: authResponse, ...errors(400, 401, 429) },
        },
        config: rateLimit,
      },
      async (request) => {
        const user = await service.login(request.body);
        return { user, token: app.jwt.sign({ sub: user.id, role: user.role }) };
      },
    );

    r.get(
      '/auth/me',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Return the authenticated user',
          security: [{ bearerAuth: [] }],
          response: { 200: userResponse, ...errors(401) },
        },
        onRequest: [app.authenticate],
      },
      async (request) => service.getById(request.user.sub),
    );
  };
}
