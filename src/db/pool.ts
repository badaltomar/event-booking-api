import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max: number): Db {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
