import type { Db } from '../../db/pool.js';
import { isUniqueViolation } from '../../db/pool.js';
import { conflict, notFound, unauthorized } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import type { Role } from '../../lib/schemas.js';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  password_hash: string;
  created_at: Date;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  createdAt: row.created_at.toISOString(),
});

// Verifying against a throwaway hash when the email is unknown keeps login timing uniform.
const DUMMY_HASH = await hashPassword('timing-equaliser');

export function createAuthService({ db }: { db: Db }) {
  return {
    async register(input: { name: string; email: string; password: string; role: Role }): Promise<User> {
      const passwordHash = await hashPassword(input.password);
      try {
        const { rows } = await db.query<UserRow>(
          `INSERT INTO users (name, email, password_hash, role)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [input.name, input.email, passwordHash, input.role],
        );
        return toUser(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
        throw err;
      }
    },

    async login(input: { email: string; password: string }): Promise<User> {
      const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE email = $1', [input.email]);
      const row = rows[0];
      const valid = await verifyPassword(input.password, row?.password_hash ?? DUMMY_HASH);
      if (!row || !valid) throw unauthorized('Invalid email or password');
      return toUser(row);
    },

    async getById(id: string): Promise<User> {
      const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      if (!rows[0]) throw notFound('User');
      return toUser(rows[0]);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
