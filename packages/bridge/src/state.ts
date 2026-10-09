/**
 * Bridge-local state store + outbox + log.
 *
 * Rationale (§5.3): before a turn is started the bridge writes a *startup
 * intent*; once a turnId is obtained it is persisted immediately. On restart,
 * intents without a turnId are reconciled against thread history so a crashed
 * window does not become a duplicate execution.
 *
 * Uses embedded Postgres (pglite) so the local store survives restarts without
 * a system PostgreSQL. Never writes ~/.codex.
 */
import type { Db } from './db.js';

export type DispatchStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'result_pending_verify'
  | 'abandoned';

export interface DispatchRecord {
  request_id: string;
  root_request_id: string;
  to_conv: string;
  thread_id: string;
  turn_id: string | null;
  status: DispatchStatus;
  marker: string;
  attempt: number;
  started_at: number | null;
  updated_at: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS dispatch (
  request_id TEXT PRIMARY KEY,
  root_request_id TEXT NOT NULL,
  to_conv TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT,
  status TEXT NOT NULL,
  marker TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS binding (
  alias TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  conv_id TEXT,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const num = (v: unknown) => Number(v);

export class LocalState {
  constructor(public db: Db) {}

  async init(): Promise<void> {
    await this.db.exec(DDL);
  }

  async log(level: string, message: string): Promise<void> {
    await this.db.query('INSERT INTO log(ts, level, message) VALUES($1,$2,$3)', [
      Date.now(),
      level,
      message,
    ]);
  }

  async logLines(limit = 200): Promise<{ ts: number; level: string; message: string }[]> {
    const rows = await this.db.query<any>('SELECT * FROM log ORDER BY id DESC LIMIT $1', [limit]);
    return rows.reverse().map((r) => ({ ts: num(r.ts), level: r.level, message: r.message }));
  }

  async get(requestId: string): Promise<DispatchRecord | null> {
    const rows = await this.db.query<any>('SELECT * FROM dispatch WHERE request_id=$1', [requestId]);
    return rows.length ? mapDispatch(rows[0]) : null;
  }

  async listUnfinished(): Promise<DispatchRecord[]> {
    const rows = await this.db.query<any>(
      "SELECT * FROM dispatch WHERE status IN ('starting','running','result_pending_verify')",
    );
    return rows.map(mapDispatch);
  }

  async listAll(): Promise<DispatchRecord[]> {
    const rows = await this.db.query<any>('SELECT * FROM dispatch ORDER BY updated_at ASC');
    return rows.map(mapDispatch);
  }

  /** §5.3: write startup intent before starting a turn. */
  async intent(
    requestId: string,
    rootRequestId: string,
    toConv: string,
    threadId: string,
    marker: string,
  ): Promise<DispatchRecord> {
    const existing = await this.get(requestId);
    if (existing) return existing;
    await this.db.query(
      `INSERT INTO dispatch(request_id, root_request_id, to_conv, thread_id, turn_id, status, marker, attempt, started_at, updated_at)
       VALUES($1,$2,$3,$4,NULL,'starting',$5,1,NULL,$6)`,
      [requestId, rootRequestId, toConv, threadId, marker, Date.now()],
    );
    return (await this.get(requestId))!;
  }

  /** §5.3: save turnId immediately once obtained. */
  async recordTurn(requestId: string, turnId: string): Promise<void> {
    await this.db.query(
      "UPDATE dispatch SET turn_id=$2, status='running', started_at=COALESCE(started_at,$3), updated_at=$3 WHERE request_id=$1",
      [requestId, turnId, Date.now()],
    );
  }

  async finish(requestId: string, status: DispatchStatus): Promise<void> {
    await this.db.query('UPDATE dispatch SET status=$2, updated_at=$3 WHERE request_id=$1', [
      requestId,
      status,
      Date.now(),
    ]);
  }

  async findByMarker(marker: string): Promise<DispatchRecord | null> {
    const rows = await this.db.query<any>('SELECT * FROM dispatch WHERE marker=$1', [marker]);
    return rows.length ? mapDispatch(rows[0]) : null;
  }

  // ---- outbox -------------------------------------------------------------

  async enqueue(kind: string, requestId: string, payload: unknown): Promise<void> {
    await this.db.query(
      'INSERT INTO outbox(kind, request_id, payload, created_at) VALUES($1,$2,$3,$4)',
      [kind, requestId, JSON.stringify(payload), Date.now()],
    );
  }

  async pendingOutbox(): Promise<{ id: number; kind: string; request_id: string; payload: any }[]> {
    const rows = await this.db.query<any>('SELECT * FROM outbox ORDER BY id ASC');
    return rows.map((r) => ({
      id: num(r.id),
      kind: r.kind,
      request_id: r.request_id,
      payload: JSON.parse(r.payload),
    }));
  }

  async deleteOutbox(id: number): Promise<void> {
    await this.db.query('DELETE FROM outbox WHERE id=$1', [id]);
  }

  // ---- bindings -----------------------------------------------------------

  async saveBinding(alias: string, profile: string, threadId: string, convId?: string | null) {
    await this.db.query(
      `INSERT INTO binding(alias, profile, thread_id, conv_id, updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(alias) DO UPDATE SET profile=$2, thread_id=$3, conv_id=COALESCE($4, binding.conv_id), updated_at=$5`,
      [alias, profile, threadId, convId ?? null, Date.now()],
    );
  }

  async getBinding(alias: string) {
    const rows = await this.db.query<any>('SELECT * FROM binding WHERE alias=$1', [alias]);
    return rows.length ? rows[0] : null;
  }

  async listBindings() {
    return this.db.query<any>('SELECT * FROM binding ORDER BY alias ASC');
  }

  // ---- kv (event cursor) --------------------------------------------------

  /**
   * Persisted WS event cursor. Without this, a bridge restart would forget how
   * far it had consumed and never replay events it missed while offline (the
   * "silent lost item" gap).
   */
  async getCursor(): Promise<number> {
    const rows = await this.db.query<any>("SELECT value FROM kv WHERE key='event_cursor'");
    return rows.length ? Number(rows[0].value) : 0;
  }

  async setCursor(value: number): Promise<void> {
    await this.db.query(
      "INSERT INTO kv(key, value) VALUES('event_cursor', $1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [String(value)],
    );
  }

  /** Idempotency guard for pushing a result/status notification into a conversation. */
  async getDelivered(requestId: string): Promise<string | null> {
    const rows = await this.db.query<any>('SELECT value FROM kv WHERE key=$1', [`delivered:${requestId}`]);
    return rows.length ? rows[0].value : null;
  }

  async markDelivered(requestId: string, resultId: string): Promise<void> {
    await this.db.query(
      'INSERT INTO kv(key, value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
      [`delivered:${requestId}`, resultId],
    );
  }
}

function mapDispatch(r: any): DispatchRecord {
  return {
    request_id: r.request_id,
    root_request_id: r.root_request_id,
    to_conv: r.to_conv,
    thread_id: r.thread_id,
    turn_id: r.turn_id ?? null,
    status: r.status,
    marker: r.marker,
    attempt: num(r.attempt),
    started_at: r.started_at === null ? null : num(r.started_at),
    updated_at: num(r.updated_at),
  };
}
