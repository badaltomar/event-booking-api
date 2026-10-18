import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { hashPassword } from '../src/lib/password.js';
import { connectDb, required, signToken } from './lib.js';

const { values } = parseArgs({
  options: {
    customers: { type: 'string', default: '5000' },
    out: { type: 'string', default: 'loadtest/tokens.json' },
  },
});

const customerCount = Number(values.customers);
const secret = required('JWT_SECRET');
const db = connectDb();

const passwordHash = await hashPassword('password123');

await db.query(
  `INSERT INTO users (email, name, password_hash, role)
   VALUES ('loadtest-organizer@loadtest.dev', 'Load Organizer', $1, 'organizer')
   ON CONFLICT (email) DO NOTHING`,
  [passwordHash],
);
await db.query(
  `INSERT INTO users (email, name, password_hash, role)
   SELECT 'loadtest-customer-' || g || '@loadtest.dev', 'Load Customer ' || g, $1, 'customer'
     FROM generate_series(1, $2::int) g
   ON CONFLICT (email) DO NOTHING`,
  [passwordHash, customerCount],
);

const organizer = await db.query<{ id: string }>(
  `SELECT id FROM users WHERE email = 'loadtest-organizer@loadtest.dev'`,
);
const customers = await db.query<{ id: string }>(
  `SELECT id FROM users WHERE email LIKE 'loadtest-customer-%@loadtest.dev' ORDER BY created_at, id LIMIT $1`,
  [customerCount],
);

await writeFile(
  values.out!,
  JSON.stringify({
    organizerId: organizer.rows[0]!.id,
    organizerToken: signToken(secret, organizer.rows[0]!.id, 'organizer'),
    customerIds: customers.rows.map((r) => r.id),
    customers: customers.rows.map((r) => signToken(secret, r.id, 'customer')),
  }),
);

console.log(`seeded 1 organizer and ${customers.rowCount} customers, tokens written to ${values.out}`);
await db.end();
