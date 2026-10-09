/**
 * Domain logic: devices, roster, requests, chain control, join codes,
 * notices and the human diagnostic faces (overview / export).
 * Authority: docs/mechanism-design.md v1.1 (§2 roster, §3 bootstrap,
 * §4 discovery, §5 message semantics, §5.3 anti-loop, §6 permissions, §9 endpoints).
 */
import type { Db } from './db.js';
import { loadConfig, setConfigValue } from './db.js';
import {
  type RequestRow,
  type RosterRow,
  type ResultRow,
  type RuntimeConfig,
  DEFAULT_CONFIG,
  ROLE_VALUES,
  MESSAGE_TYPES,
  type MessageType,
  type Tier,
  type DeliveryMode,
  type RosterStatus,
  type ExecStatus,
} from '@relay/protocol';
import {
  HttpError,
  bad,
  conflict,
  forbidden,
  newConvId,
  newDeviceId,
  newDeviceToken,
  newJoinCode,
  newNoticeId,
  newRequestId,
  newResultId,
  newTicket,
  notFound,
  nowMs,
  unauth,
} from './util.js';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const numReq = (v: unknown): number => Number(v);

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function mapRoster(r: any): RosterRow {
  return {
    conv_id: r.conv_id,
    device_id: r.device_id,
    profile: r.profile,
    thread_id: r.thread_id,
    alias: r.alias,
    role: r.role,
    task: r.task,
    task_ref: r.task_ref ?? null,
    project: r.project,
    owner_label: r.owner_label,
    allow_sources: parseJsonArray(r.allow_sources),
    registered_via: r.registered_via,
    roster_status: r.roster_status,
    tier: r.tier,
    delivery_mode: r.delivery_mode,
    registered_at: numReq(r.registered_at),
    last_seen_at: num(r.last_seen_at),
    last_pull_at: num(r.last_pull_at),
  };
}

function mapRequest(r: any): RequestRow {
  return {
    request_id: r.request_id,
    root_request_id: r.root_request_id,
    parent_request_id: r.parent_request_id ?? null,
    chain_depth: numReq(r.chain_depth),
    from_conv: r.from_conv,
    to_conv: r.to_conv,
    type: r.type,
    body: r.body,
    context: r.context ?? null,
    result_requirement: r.result_requirement ?? null,
    ttl_s: numReq(r.ttl_s),
    size_bytes: numReq(r.size_bytes),
    delivery_status: r.delivery_status,
    exec_status: r.exec_status,
    return_status: r.return_status ?? null,
    return_addr: r.return_addr,
    turn_id: r.turn_id ?? null,
    error: r.error ?? null,
    result_missing: r.result_missing === true || r.result_missing === 'true',
    created_at: numReq(r.created_at),
    claimed_at: num(r.claimed_at),
    started_at: num(r.started_at),
    completed_at: num(r.completed_at),
    delivered_at: num(r.delivered_at),
    returned_at: num(r.returned_at),
    expires_at: numReq(r.expires_at),
  } as RequestRow;
}

function mapResult(r: any): ResultRow {
  return {
    result_id: r.result_id,
    request_id: r.request_id,
    kind: r.kind,
    body: r.body,
    evidence: r.evidence ?? null,
    exec_status: r.exec_status ?? null,
    is_first: r.is_first === true || r.is_first === 'true',
    created_at: numReq(r.created_at),
  };
}

/** Emitted so the WS hub can push without the store depending on the hub. */
export type StoreEvent = {
  device_id: string;
  event: 'request.available' | 'result.available' | 'revoked';
  payload: Record<string, unknown>;
};

export class Store {
  readonly events: StoreEvent[] = []; // outbound queue drained by the server

  constructor(
    public db: Db,
    public cfg: RuntimeConfig,
  ) {}

  private emit(e: StoreEvent) {
    this.events.push(e);
  }

  drainEvents(): StoreEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** Re-read runtime config from the database (admin can change it). */
  async refreshConfig(): Promise<RuntimeConfig> {
    this.cfg = await loadConfig(this.db);
    return this.cfg;
  }

  // ---- devices (§9 #1, #2) ------------------------------------------------

  async registerDevice(ownerLabel = 'owner') {
    const device_id = newDeviceId();
    const device_token = newDeviceToken();
    await this.db.query(
      `INSERT INTO devices(device_id, device_token, owner_label, created_at, revoked_at, last_seen_at)
       VALUES($1,$2,$3,$4,NULL,$4)`,
      [device_id, device_token, ownerLabel, nowMs()],
    );
    return { device_id, device_token, owner_label: ownerLabel };
  }

  async authDevice(token: string): Promise<{ device_id: string }> {
    const rows = await this.db.query(
      'SELECT device_id, revoked_at FROM devices WHERE device_token = $1',
      [token],
    );
    if (rows.length === 0) throw unauth('unknown device token');
    if (rows[0].revoked_at !== null) throw unauth('device revoked');
    return { device_id: rows[0].device_id };
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const rows = await this.db.query('SELECT device_id, revoked_at FROM devices WHERE device_id=$1', [
      deviceId,
    ]);
    if (rows.length === 0) throw notFound('device_not_found', 'no such device');
    const t = nowMs();
    await this.db.query('UPDATE devices SET revoked_at=$2 WHERE device_id=$1', [deviceId, t]);
    // §8: revoking a device pauses its conversations and closes its connections.
    const convs = await this.db.query<{ conv_id: string }>(
      'SELECT conv_id FROM roster WHERE device_id=$1 AND roster_status <> $2',
      [deviceId, 'revoked'],
    );
    for (const c of convs) {
      await this.db.query('UPDATE roster SET roster_status=$2, ticket=NULL WHERE conv_id=$1', [
        c.conv_id,
        'paused',
      ]);
    }
    this.emit({ device_id: deviceId, event: 'revoked', payload: { device_id: deviceId } });
    return true;
  }

  async listDeviceIds(): Promise<string[]> {
    const rows = await this.db.query<{ device_id: string }>('SELECT device_id FROM devices');
    return rows.map((r) => r.device_id);
  }

  async touchDevice(deviceId: string): Promise<void> {
    await this.db.query('UPDATE devices SET last_seen_at=$2 WHERE device_id=$1', [
      deviceId,
      nowMs(),
    ]);
  }

  async deviceName(deviceId: string): Promise<string> {
    const rows = await this.db.query<{ device_id: string }>(
      'SELECT device_id FROM devices WHERE device_id=$1',
      [deviceId],
    );
    return rows.length ? rows[0].device_id : deviceId;
  }

  // ---- roster (§2, §3, §9 #4, #5, #7, #8, #16) ---------------------------

  async findByBinding(
    deviceId: string,
    profile: string,
    threadId: string,
  ): Promise<RosterRow | null> {
    const rows = await this.db.query(
      'SELECT * FROM roster WHERE device_id=$1 AND profile=$2 AND thread_id=$3',
      [deviceId, profile, threadId],
    );
    return rows.length ? mapRoster(rows[0]) : null;
  }

  async getRoster(convId: string): Promise<RosterRow | null> {
    const rows = await this.db.query('SELECT * FROM roster WHERE conv_id=$1', [convId]);
    return rows.length ? mapRoster(rows[0]) : null;
  }

  async getRosterOrThrow(convId: string): Promise<RosterRow> {
    const r = await this.getRoster(convId);
    if (!r) throw notFound('conv_not_found', `no such conversation: ${convId}`);
    return r;
  }

  async createRoster(input: {
    deviceId: string;
    profile: string;
    threadId: string;
    alias: string;
    role: string;
    task: string;
    taskRef?: string | null;
    project: string;
    ownerLabel?: string;
    allowSources?: string[];
    tier: Tier;
    registeredVia: string;
    ticket?: string | null;
  }): Promise<RosterRow> {
    if (!ROLE_VALUES.includes(input.role as any)) {
      throw bad('bad_role', `role must be one of ${ROLE_VALUES.join(', ')}`);
    }
    // Re-registration of an already-bound thread is an *update* of the existing
    // row, not a new entry (§3.1 防冒充): keep the conv_id, refresh fields.
    const existing = await this.findByBinding(input.deviceId, input.profile, input.threadId);
    if (existing) {
      await this.db.query(
        `UPDATE roster SET alias=$2, role=$3, task=$4, task_ref=$5, project=$6, owner_label=$7,
           allow_sources=$8, roster_status='active', tier=$9, delivery_mode=$10, registered_via=$11
         WHERE conv_id=$1`,
        [
          existing.conv_id,
          input.alias,
          input.role,
          input.task,
          input.taskRef ?? null,
          input.project,
          input.ownerLabel ?? 'owner',
          JSON.stringify(input.allowSources ?? ['owner']),
          input.tier,
          input.tier === 't1_managed' ? 'push' : 'manual_pull',
          input.registeredVia,
        ],
      );
      return (await this.getRoster(existing.conv_id))!;
    }
    const conv_id = newConvId();
    const tier = input.tier;
    const delivery_mode: DeliveryMode = tier === 't1_managed' ? 'push' : 'manual_pull';
    const ticket = input.ticket ?? (tier === 't2_desktop' ? newTicket() : null);
    await this.db.query(
      `INSERT INTO roster(conv_id, device_id, profile, thread_id, alias, role, task, task_ref,
         project, owner_label, allow_sources, registered_via, roster_status, tier, delivery_mode,
         ticket, registered_at, last_seen_at, last_pull_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,$14,$15,$16,$16,NULL)`,
      [
        conv_id,
        input.deviceId,
        input.profile,
        input.threadId,
        input.alias,
        input.role,
        input.task,
        input.taskRef ?? null,
        input.project,
        input.ownerLabel ?? 'owner',
        JSON.stringify(input.allowSources ?? ['owner']),
        input.registeredVia,
        tier,
        delivery_mode,
        ticket,
        nowMs(),
      ],
    );
    return (await this.getRoster(conv_id))!;
  }

  async setRosterStatus(convId: string, status: RosterStatus): Promise<RosterRow> {
    const row = await this.getRosterOrThrow(convId);
    if (status === 'revoked') {
      // §9 #16: revoke also voids the ticket and allow_sources.
      await this.db.query(
        `UPDATE roster SET roster_status='revoked', ticket=NULL, allow_sources='[]' WHERE conv_id=$1`,
        [convId],
      );
    } else {
      await this.db.query('UPDATE roster SET roster_status=$2 WHERE conv_id=$1', [convId, status]);
    }
    return (await this.getRoster(row.conv_id))!;
  }

  async listRoster(filter: {
    project?: string;
    role?: string;
    status?: string;
    q?: string;
  }): Promise<RosterRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.project) {
      params.push(filter.project);
      clauses.push(`project = $${params.length}`);
    }
    if (filter.role) {
      params.push(filter.role);
      clauses.push(`role = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`roster_status = $${params.length}`);
    }
    if (filter.q) {
      params.push(`%${filter.q}%`);
      clauses.push(`(alias ILIKE $${params.length} OR task ILIKE $${params.length})`);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = await this.db.query(`SELECT * FROM roster${where} ORDER BY registered_at ASC`, params);
    return rows.map(mapRoster);
  }

  async markSeen(convId: string): Promise<void> {
    await this.db.query('UPDATE roster SET last_seen_at=$2 WHERE conv_id=$1', [convId, nowMs()]);
  }

  async markPull(convId: string): Promise<void> {
    await this.db.query('UPDATE roster SET last_pull_at=$2 WHERE conv_id=$1', [convId, nowMs()]);
  }

  // ---- join codes (§3.2, §9 #6, #17) ------------------------------------

  async createJoinCode(input: {
    scopeDevice?: string | null;
    scopeProject?: string | null;
    presetRole?: string | null;
    presetTask?: string | null;
    ttlHours?: number;
    maxUses?: number;
  }) {
    const code = newJoinCode();
    const ttl = input.ttlHours ?? this.cfg.join_code_ttl_hours;
    const maxUses = input.maxUses ?? 1;
    await this.db.query(
      `INSERT INTO join_codes(code, scope_device, scope_project, preset_role, preset_task,
         max_uses, uses, created_at, expires_at, revoked_at)
       VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,NULL)`,
      [
        code,
        input.scopeDevice ?? null,
        input.scopeProject ?? null,
        input.presetRole ?? null,
        input.presetTask ?? null,
        maxUses,
        nowMs(),
        nowMs() + ttl * 3600_000,
      ],
    );
    return { code, expires_at: nowMs() + ttl * 3600_000, max_uses: maxUses };
  }

  async revokeJoinCode(code: string): Promise<boolean> {
    const rows = await this.db.query('SELECT code FROM join_codes WHERE code=$1', [code]);
    if (rows.length === 0) throw notFound('join_code_not_found', 'no such join code');
    await this.db.query('UPDATE join_codes SET revoked_at=$2 WHERE code=$1', [code, nowMs()]);
    return true;
  }

  async joinCodeInfo(code: string) {
    const rows = await this.db.query<any>('SELECT * FROM join_codes WHERE code=$1', [code]);
    return rows.length ? rows[0] : null;
  }

  /** Validate and consume one use of a join code (§3.2 两证齐全). */
  async consumeJoinCode(code: string, deviceId: string): Promise<any> {
    const jc = await this.joinCodeInfo(code);
    if (!jc) throw notFound('join_code_not_found', 'no such join code');
    if (jc.revoked_at !== null) throw conflict('join_code_revoked', 'join code revoked');
    if (Number(jc.expires_at) < nowMs()) throw conflict('join_code_expired', 'join code expired');
    if (Number(jc.uses) >= Number(jc.max_uses))
      throw conflict('join_code_exhausted', 'join code exhausted');
    if (jc.scope_device && jc.scope_device !== deviceId) {
      throw forbidden('join_code_scope', 'join code not valid for this device');
    }
    await this.db.query('UPDATE join_codes SET uses = uses + 1 WHERE code=$1', [code]);
    return jc;
  }

  // ---- requests (§5, §9 #10–#13, #18) -----------------------------------

  private async chainDepthFor(parentRequestId: string | null): Promise<number> {
    if (!parentRequestId) return 0;
    const rows = await this.db.query(
      'SELECT chain_depth, root_request_id FROM requests WHERE request_id=$1',
      [parentRequestId],
    );
    if (rows.length === 0) throw notFound('parent_not_found', 'parent request not found');
    return Number(rows[0].chain_depth) + 1;
  }

  /** §6 three-layer authorization + §6 64KB cap + §5.4 chain cap. */
  private assertCanSend(from: RosterRow, to: RosterRow, bodyBytes: number) {
    if (from.roster_status !== 'active') throw forbidden('sender_inactive', 'sender not active');
    if (to.roster_status !== 'active') throw forbidden('target_inactive', 'target not active');
    if (bodyBytes > this.cfg.body_max_bytes) {
      throw new HttpError(413, 'body_too_large', `body exceeds ${this.cfg.body_max_bytes} bytes`);
    }
    const allowed =
      to.allow_sources.includes(from.conv_id) ||
      to.allow_sources.includes(`device:${from.device_id}`);
    if (!allowed) throw forbidden('source_not_allowed', 'sender not allowed by target');
  }

  async createRequest(input: {
    from: RosterRow;
    to: string;
    type: MessageType;
    body: string;
    context?: string | null;
    resultRequirement?: string | null;
    ttlS?: number;
    parentRequestId?: string | null;
    clientKey?: string | null;
  }): Promise<RequestRow> {
    if (!MESSAGE_TYPES.includes(input.type)) {
      throw bad('bad_type', `type must be one of ${MESSAGE_TYPES.join(', ')}`);
    }
    // Idempotent retry (§5.1 网络重试沿用原编号): same client key → same request.
    if (input.clientKey) {
      const dup = await this.db.query(
        'SELECT * FROM requests WHERE from_conv=$1 AND client_key=$2',
        [input.from.conv_id, input.clientKey],
      );
      if (dup.length) return mapRequest(dup[0]);
    }

    const toRow = await this.getRosterOrThrow(input.to);
    const size = Buffer.byteLength(input.body, 'utf8');
    this.assertCanSend(input.from, toRow, size);

    let root: string | null = null;
    let depth = 0;
    if (input.type === 'CANCEL') {
      throw bad('use_cancel_endpoint', 'use POST /v1/requests/{id}/cancel for CANCEL');
    }
    if (input.parentRequestId) {
      depth = await this.chainDepthFor(input.parentRequestId);
      const prows = await this.db.query(
        'SELECT root_request_id FROM requests WHERE request_id=$1',
        [input.parentRequestId],
      );
      root = prows[0]?.root_request_id ?? null;
      // §5.4 chain cap: only CLARIFY and parent-linked follow-ups extend a chain.
      if (depth > this.cfg.chain_limit) {
        await this.raiseChainLimitNotice(input.from.conv_id, root ?? input.parentRequestId);
        throw new HttpError(409, 'chain_limit_reached', 'chain depth limit reached');
      }
    }

    const request_id = newRequestId();
    if (!root) root = request_id;
    const ttl = input.ttlS ?? this.cfg.unstarted_expire_hours * 3600;
    const now = nowMs();
    await this.db.query(
      `INSERT INTO requests(request_id, root_request_id, parent_request_id, chain_depth, from_conv,
         to_conv, type, body, context, result_requirement, ttl_s, size_bytes, delivery_status,
         exec_status, return_status, return_addr, turn_id, error, client_key, result_missing,
         created_at, claimed_at, started_at, completed_at, delivered_at, returned_at, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued','pending',NULL,$13,NULL,NULL,$14,FALSE,
         $15,NULL,NULL,NULL,NULL,NULL,$16)`,
      [
        request_id,
        root,
        input.parentRequestId ?? null,
        depth,
        input.from.conv_id,
        toRow.conv_id,
        input.type,
        input.body,
        input.context ?? null,
        input.resultRequirement ?? null,
        ttl,
        size,
        input.from.conv_id, // return_addr bound at enqueue (§5.2), never rewritten by body
        input.clientKey ?? null,
        now,
        now + ttl * 1000,
      ],
    );
    const created = await this.getRequest(request_id);
    this.emit({
      device_id: toRow.device_id,
      event: 'request.available',
      payload: { request_id, to_conv: toRow.conv_id, type: input.type },
    });
    return created!;
  }

  /** §5.4: exactly one "chain limit reached" notice per (conv, root). */
  async raiseChainLimitNotice(convId: string, rootRequestId: string): Promise<void> {
    const existing = await this.db.query(
      'SELECT notice_id FROM notices WHERE conv_id=$1 AND kind=$2 AND root_request_id=$3',
      [convId, 'chain_limit', rootRequestId],
    );
    if (existing.length) return;
    await this.db.query(
      `INSERT INTO notices(notice_id, conv_id, kind, root_request_id, request_id, message, created_at)
       VALUES($1,$2,'chain_limit',$3,NULL,$4,$5)`,
      [newNoticeId(), convId, rootRequestId, `chain limit (${this.cfg.chain_limit}) reached for root ${rootRequestId}`, nowMs()],
    );
    const row = await this.getRoster(convId);
    if (row) {
      this.emit({
        device_id: row.device_id,
        event: 'result.available',
        payload: { notice: 'chain_limit', root_request_id: rootRequestId },
      });
    }
  }

  async getRequest(requestId: string): Promise<RequestRow | null> {
    const rows = await this.db.query('SELECT * FROM requests WHERE request_id=$1', [requestId]);
    return rows.length ? mapRequest(rows[0]) : null;
  }

  async getRequestOrThrow(requestId: string): Promise<RequestRow> {
    const r = await this.getRequest(requestId);
    if (!r) throw notFound('request_not_found', `no such request: ${requestId}`);
    return r;
  }

  async listResults(requestId: string): Promise<ResultRow[]> {
    const rows = await this.db.query(
      'SELECT * FROM results WHERE request_id=$1 ORDER BY created_at ASC',
      [requestId],
    );
    return rows.map(mapResult);
  }

  async claimRequest(requestId: string, deviceId: string): Promise<RequestRow> {
    const r = await this.getRequestOrThrow(requestId);
    const row = await this.getRoster(r.to_conv);
    if (!row || row.device_id !== deviceId) throw forbidden('not_target_device', 'not the target device');
    if (r.delivery_status === 'expired' || r.delivery_status === 'rejected') {
      return r;
    }
    if (r.delivery_status === 'queued') {
      await this.db.query(
        `UPDATE requests SET delivery_status='device_received', claimed_at=$2 WHERE request_id=$1`,
        [requestId, nowMs()],
      );
    }
    return (await this.getRequest(requestId))!;
  }

  async startRequest(requestId: string, turnId: string): Promise<RequestRow> {
    const r = await this.getRequestOrThrow(requestId);
    if (r.exec_status === 'completed' || r.exec_status === 'interrupted') return r;
    await this.db.query(
      `UPDATE requests SET exec_status='running', turn_id=$2, started_at=COALESCE(started_at,$3),
         delivery_status = CASE WHEN delivery_status='queued' THEN 'device_received' ELSE delivery_status END
       WHERE request_id=$1`,
      [requestId, turnId, nowMs()],
    );
    return (await this.getRequest(requestId))!;
  }

  async setExecStatus(requestId: string, status: ExecStatus, error?: string): Promise<RequestRow> {
    await this.db.query('UPDATE requests SET exec_status=$2, error=$3 WHERE request_id=$1', [
      requestId,
      status,
      error ?? null,
    ]);
    return (await this.getRequest(requestId))!;
  }

  /**
   * §9 #18: RESULT/STATUS submission by the executing bridge.
   * §5.2 dedupe: only the first RESULT for a request triggers delivery; later
   * ones are archived (`is_first=false`) and do not emit a second event.
   */
  async submitResult(input: {
    requestId: string;
    kind: 'RESULT' | 'STATUS';
    body: string;
    evidence?: string | null;
    execStatus?: ExecStatus | null;
    turnId?: string | null;
    resultMissing?: boolean;
  }): Promise<{ result: ResultRow; first: boolean }> {
    const r = await this.getRequestOrThrow(input.requestId);
    const size = Buffer.byteLength(input.body, 'utf8');
    if (size > this.cfg.body_max_bytes) {
      throw new HttpError(413, 'body_too_large', `result exceeds ${this.cfg.body_max_bytes} bytes`);
    }
    const priorResults = await this.db.query(
      "SELECT result_id FROM results WHERE request_id=$1 AND kind='RESULT'",
      [input.requestId],
    );
    const first = input.kind === 'RESULT' && priorResults.length === 0;
    const result_id = newResultId();
    await this.db.query(
      `INSERT INTO results(result_id, request_id, kind, body, evidence, exec_status, is_first, created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        result_id,
        input.requestId,
        input.kind,
        input.body,
        input.evidence ?? null,
        input.execStatus ?? null,
        first,
        nowMs(),
      ],
    );

    const now = nowMs();
    if (input.kind === 'RESULT') {
      const exec = input.execStatus ?? 'completed';
      if (first) {
        // §5.2: results land only on the bound return address.
        const target = await this.getRoster(r.return_addr);
        await this.db.query(
          `UPDATE requests SET exec_status=$2, completed_at=$3, returned_at=$3, turn_id=COALESCE($4,turn_id),
             return_status='cloud_saved', result_missing=$5 WHERE request_id=$1`,
          [input.requestId, exec, now, input.turnId ?? null, input.resultMissing === true],
        );
        if (target) {
          this.emit({
            device_id: target.device_id,
            event: 'result.available',
            payload: { request_id: input.requestId, to_conv: target.conv_id, kind: 'RESULT' },
          });
        }
      } else {
        await this.db.query(
          `UPDATE requests SET exec_status=$2, completed_at=COALESCE(completed_at,$3),
             turn_id=COALESCE($4,turn_id) WHERE request_id=$1`,
          [input.requestId, exec, now, input.turnId ?? null],
        );
      }
    } else {
      // STATUS: intermediate state, does not close the request.
      const exec = input.execStatus ?? 'running';
      await this.db.query('UPDATE requests SET exec_status=$2 WHERE request_id=$1', [
        input.requestId,
        exec,
      ]);
      const target = await this.getRoster(r.return_addr);
      if (target) {
        this.emit({
          device_id: target.device_id,
          event: 'result.available',
          payload: { request_id: input.requestId, to_conv: target.conv_id, kind: 'STATUS' },
        });
      }
    }

    const stored = await this.db.query('SELECT * FROM results WHERE result_id=$1', [result_id]);
    return { result: mapResult(stored[0]), first };
  }

  /** §9 #12: read the latest RESULT (or STATUS) full text + evidence. */
  async readResult(requestId: string): Promise<{
    request: RequestRow;
    results: ResultRow[];
    result_missing: boolean;
  }> {
    const request = await this.getRequestOrThrow(requestId);
    const results = await this.listResults(requestId);
    const hasResult = results.some((r) => r.kind === 'RESULT');
    // Still in flight ⇒ absence of a result is not yet "missing"; anything
    // terminal without a RESULT is.
    const terminal = ['completed', 'failed', 'interrupted'].includes(request.exec_status);
    return { request, results, result_missing: !hasResult && terminal };
  }

  /** §9 #13 + §5.4:未启动可取消；已运行发中断请求. */
  async cancelRequest(requestId: string, fromConv: string): Promise<RequestRow> {
    const r = await this.getRequestOrThrow(requestId);
    if (r.from_conv !== fromConv) {
      throw forbidden('not_origin', 'only the originating conversation can cancel');
    }
    if (r.delivery_status === 'expired' || r.delivery_status === 'rejected') return r;
    if (r.exec_status === 'pending') {
      await this.db.query(
        `UPDATE requests SET exec_status='interrupted', delivery_status='rejected', completed_at=$2
         WHERE request_id=$1`,
        [requestId, nowMs()],
      );
    } else if (r.exec_status === 'running') {
      // Signal the target bridge to interrupt; final state flips only when the
      // bridge reports the real terminal status (§5.4).
      const toRow = await this.getRoster(r.to_conv);
      if (toRow) {
        this.emit({
          device_id: toRow.device_id,
          event: 'request.available',
          payload: { request_id: requestId, to_conv: r.to_conv, control: 'cancel' },
        });
      }
    }
    return (await this.getRequest(requestId))!;
  }

  // ---- inbox + discovery (§4, §9 #7, #8, #9) ----------------------------

  async inbox(convId: string) {
    const pending = await this.db.query(
      `SELECT * FROM requests WHERE to_conv=$1 AND exec_status IN ('pending','running','waiting_user')
         AND type <> 'CANCEL' ORDER BY created_at ASC`,
      [convId],
    );
    const runningClarify = await this.db.query(
      `SELECT * FROM requests WHERE to_conv=$1 AND type='CLARIFY'
         AND exec_status IN ('pending','running') ORDER BY created_at ASC`,
      [convId],
    );
    const resultsToVerify = await this.db.query(
      `SELECT * FROM requests WHERE from_conv=$1 AND exec_status='completed'
         ORDER BY created_at DESC LIMIT 100`,
      [convId],
    );
    const outbox = await this.db.query(
      `SELECT * FROM requests WHERE from_conv=$1 ORDER BY created_at DESC LIMIT 100`,
      [convId],
    );
    const notices = await this.db.query(
      'SELECT * FROM notices WHERE conv_id=$1 ORDER BY created_at DESC',
      [convId],
    );
    return {
      pending_for_me: pending.map(mapRequest),
      guidance_on_running: runningClarify.map(mapRequest),
      results_to_verify: resultsToVerify.map(mapRequest),
      my_outbox: outbox.map(mapRequest),
      notices,
    };
  }

  // ---- admin (§6, §9 #14, #15) ------------------------------------------

  async overview() {
    const devices = await this.db.query('SELECT * FROM devices ORDER BY created_at ASC');
    const roster = await this.listRoster({});
    const now = nowMs();
    const deviceView = devices.map((d: any) => {
      const online =
        d.revoked_at === null &&
        d.last_seen_at !== null &&
        now - Number(d.last_seen_at) <= this.cfg.offline_after_s * 1000;
      return {
        device_id: d.device_id,
        owner_label: d.owner_label,
        revoked: d.revoked_at !== null,
        online,
        last_seen_at: num(d.last_seen_at),
      };
    });
    const byStatus = await this.db.query(
      "SELECT exec_status, count(*) AS n FROM requests GROUP BY exec_status",
    );
    const backlog = await this.db.query(
      "SELECT to_conv, count(*) AS n FROM requests WHERE delivery_status='queued' AND exec_status='pending' GROUP BY to_conv",
    );
    const waitingUser = await this.db.query(
      "SELECT request_id FROM requests WHERE exec_status='waiting_user'",
    );
    const resultsPending = await this.db.query(
      "SELECT request_id FROM requests WHERE exec_status='completed' AND result_missing=TRUE",
    );
    const failed = await this.db.query("SELECT request_id FROM requests WHERE exec_status='failed'");
    const chainLimited = await this.db.query("SELECT notice_id FROM notices WHERE kind='chain_limit'");
    return {
      generated_at: now,
      devices: deviceView,
      roster_count: roster.length,
      roster: roster.map((r) => ({
        conv_id: r.conv_id,
        alias: r.alias,
        role: r.role,
        project: r.project,
        tier: r.tier,
        roster_status: r.roster_status,
      })),
      exec_status_counts: byStatus.map((r: any) => ({ status: r.exec_status, n: Number(r.n) })),
      backlog_by_conv: backlog.map((r: any) => ({ conv_id: r.to_conv, n: Number(r.n) })),
      waiting_user: waitingUser.map((r: any) => r.request_id),
      results_pending: resultsPending.map((r: any) => r.request_id),
      failed: failed.map((r: any) => r.request_id),
      chain_limited: chainLimited.length,
      config: this.cfg,
    };
  }

  /** Sweeper: expire unstarted requests (§7.2 24h) and stale queued ones. */
  async expireUnstarted(): Promise<number> {
    const now = nowMs();
    const rows = await this.db.query(
      `UPDATE requests SET delivery_status='expired', exec_status='interrupted', completed_at=$1
       WHERE delivery_status IN ('queued','device_received') AND exec_status='pending' AND expires_at < $2
       RETURNING request_id`,
      [now, now],
    );
    return rows.length;
  }
}

/** In-memory config override used by tests (no DB round-trip needed). */
export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
