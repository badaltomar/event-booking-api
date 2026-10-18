import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
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
  db: Db;
  secret: string;
  expiresIn: string;
}

export async function registerAuth(app: FastifyInstance, { db, secret, expiresIn }: AuthOptions): Promise<void> {
  await app.register(fastifyJwt, { secret, sign: { expiresIn } });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid access token');
    }

    const { rows } = await db.query<{ role: Role }>('SELECT role FROM users WHERE id = $1', [request.user.sub]);
    if (!rows[0]) throw unauthorized('Account no longer exists');
    request.user.role = rows[0].role;
  });

  app.decorate('requireRole', (...roles: Role[]) => async (request: FastifyRequest) => {
    if (!roles.includes(request.user.role)) {
      throw forbidden(`This action requires one of the roles: ${roles.join(', ')}`);
    }
  });
}
