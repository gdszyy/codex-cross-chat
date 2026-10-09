/**
 * Bridge-local embedded PostgreSQL (pglite). Production would use a local
 * Postgres too, but the local store never holds cloud credentials.
 */
export interface Db {
  kind: 'pglite' | 'pg';
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openLocalPg(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    kind: 'pglite',
    async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pg.query<T>(sql, params as any[]);
      return res.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await pg.exec(sql);
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}
