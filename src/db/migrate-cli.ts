import { loadEnv } from '../config/env.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const env = loadEnv();
const db = createPool(env.DATABASE_URL, 1);

try {
  await migrate(db, console.log);
  console.log('migrations up to date');
} finally {
  await db.end();
}
