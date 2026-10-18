import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Role } from '../lib/schemas.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireRole: (...roles: Role[]) => (request: FastifyRequest) => Promise<void>;
  }
}

interface AuthOptions {
  secret: string;
  expiresIn: string;
}

/**
 * Tokens are stateless: the signature and expiry prove identity and role, so no database
 * lookup happens per request. The trade-off is that a deleted user or changed role is only
 * noticed once the (short lived) token expires.
 */
export async function registerAuth(app: FastifyInstance, { secret, expiresIn }: AuthOptions): Promise<void> {
  await app.register(fastifyJwt, { secret, sign: { expiresIn } });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid access token');
    }
  });

  app.decorate('requireRole', (...roles: Role[]) => async (request: FastifyRequest) => {
    if (!roles.includes(request.user.role)) {
      throw forbidden(`This action requires one of the roles: ${roles.join(', ')}`);
    }
  });
}
