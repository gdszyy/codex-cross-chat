/**
 * Database layer. PostgreSQL is the single source of truth (§3.1 / §5).
 *
 * Production connects to `DATABASE_URL` (injected by the Railway service
 * binding — not a hand-set variable). Local development and tests use an
 * embedded PostgreSQL (@electric-sql/pglite, a WASM build of real Postgres).
 * The only hand-set environment variable in the whole system is the master
 * connection key (relay root key) — see docs/mechanism-design.md §8.
 */
import { DEFAULT_CONFIG, type RuntimeConfig } from '@relay/protocol';

export interface Db {
  kind: 'pglite' | 'pg';
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_token TEXT NOT NULL UNIQUE,
  owner_label TEXT NOT NULL DEFAULT 'owner',
  created_at BIGINT NOT NULL,
  revoked_at BIGINT,
  last_seen_at BIGINT
);

CREATE TABLE IF NOT EXISTS roster (
  conv_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  role TEXT NOT NULL,
  task TEXT NOT NULL,
  task_ref TEXT,
  project TEXT NOT NULL,
  owner_label TEXT NOT NULL,
  allow_sources TEXT NOT NULL,
  registered_via TEXT NOT NULL,
  roster_status TEXT NOT NULL,
  tier TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  ticket TEXT,
  registered_at BIGINT NOT NULL,
  last_seen_at BIGINT,
  last_pull_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS roster_binding ON roster(device_id, profile, thread_id);

CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  root_request_id TEXT NOT NULL,
  parent_request_id TEXT,
  chain_depth INTEGER NOT NULL,
  from_conv TEXT NOT NULL,
  to_conv TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  context TEXT,
  result_requirement TEXT,
  ttl_s BIGINT NOT NULL,
  size_bytes INTEGER NOT NULL,
  delivery_status TEXT NOT NULL,
  exec_status TEXT NOT NULL,
  return_status TEXT,
  return_addr TEXT NOT NULL,
  turn_id TEXT,
  error TEXT,
  client_key TEXT,
  result_missing BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  claimed_at BIGINT,
  started_at BIGINT,
  completed_at BIGINT,
  delivered_at BIGINT,
  returned_at BIGINT,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_to_conv ON requests(to_conv);
CREATE INDEX IF NOT EXISTS requests_root ON requests(root_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS requests_client_key ON requests(from_conv, client_key);

CREATE TABLE IF NOT EXISTS results (
  result_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence TEXT,
  exec_status TEXT,
  is_first BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS results_request ON results(request_id);

CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY,
  scope_device TEXT,
  scope_project TEXT,
  preset_role TEXT,
  preset_task TEXT,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);

CREATE TABLE IF NOT EXISTS notices (
  notice_id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_request_id TEXT,
  request_id TEXT,
  message TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS notices_dedupe ON notices(conv_id, kind, root_request_id);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_device ON events(device_id, id);
`;

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
}

export async function loadConfig(db: Db): Promise<RuntimeConfig> {
  const rows = await db.query<{ key: string; value: string }>('SELECT key, value FROM config');
  const cfg: RuntimeConfig = { ...DEFAULT_CONFIG };
  for (const r of rows) {
    const key = r.key as keyof RuntimeConfig;
    if (key in cfg) {
      (cfg as any)[key] = Number(r.value);
    }
  }
  return cfg;
}

export async function seedConfig(db: Db, cfg: RuntimeConfig): Promise<void> {
  const entries = Object.entries(cfg) as [keyof RuntimeConfig, number][];
  for (const [k, v] of entries) {
    await db.query(
      'INSERT INTO config(key, value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING',
      [k, String(v)],
    );
  }
}

export async function setConfigValue(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    'INSERT INTO config(key, value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value],
  );
}

/** Embedded PostgreSQL for local + tests. */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const db: Db = {
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
  return db;
}

/** Production PostgreSQL via DATABASE_URL (Railway binding injection). */
export async function openPg(connectionString: string): Promise<Db> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString });
  const db: Db = {
    kind: 'pg',
    async query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await pool.query(sql, params as any[]);
      return res.rows as T[];
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
  return db;
}

export async function bootstrapDb(db: Db, cfg: RuntimeConfig = DEFAULT_CONFIG): Promise<void> {
  // Idempotent on every call: DDL uses IF NOT EXISTS, seeding uses ON CONFLICT
  // DO NOTHING. No module-level "already bootstrapped" flag: that would be a
  // shared-state shortcut that silently skips schema creation for the second
  // database opened in the same process (e.g. parallel test cases).
  await migrate(db);
  await seedConfig(db, cfg);
}
