/**
 * HTTP surface: all endpoints from docs/mechanism-design.md §9, plus the two
 * executor-side control endpoints the bridge needs to satisfy §5.2/§5.3
 * (claim = "device received", start = "turnId persisted immediately").
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './domain.js';
import { exportCsv, type ExportLayer } from './csv.js';
import type { RosterRow } from '@relay/protocol';
import { HttpError, bad, forbidden, unauth } from './util.js';

const MAX_HTTP_BODY = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_HTTP_BODY) {
        reject(new HttpError(413, 'http_body_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(bad('bad_json', 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = header(req, 'authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return header(req, 'x-device-token');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(payload);
}

function ok(res: ServerResponse, data: unknown, status = 200) {
  send(res, status, { ok: true, data });
}

export interface RouterDeps {
  store: Store;
  rootKey: string;
}

async function resolveBinding(
  store: Store,
  deviceId: string,
  input: { conv_id?: string; profile?: string; thread_id?: string },
): Promise<RosterRow> {
  if (input.conv_id) {
    const row = await store.getRosterOrThrow(input.conv_id);
    if (row.device_id !== deviceId) throw forbidden('binding_mismatch', 'conversation not bound to this device');
    return row;
  }
  if (input.profile !== undefined && input.thread_id !== undefined) {
    const row = await store.findByBinding(deviceId, input.profile, input.thread_id);
    if (!row) throw bad('unbound', 'no roster entry for this device/profile/threadId');
    return row;
  }
  throw bad('binding_required', 'provide conv_id or profile+thread_id');
}

export async function handleHttp(
  deps: RouterDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = deps.store;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  const requireRoot = () => {
    const key = header(req, 'x-root-key');
    if (!key || key !== deps.rootKey) throw unauth('invalid root key');
  };
  const requireDevice = async (): Promise<string> => {
    const token = bearer(req);
    if (!token) throw unauth('missing device token');
    const { device_id } = await store.authDevice(token);
    return device_id;
  };

  // 1. POST /v1/devices/register
  if (method === 'POST' && path === '/v1/devices/register') {
    requireRoot();
    const body = await readBody(req);
    const device = await store.registerDevice(body.owner_label ?? 'owner');
    return ok(res, device, 201);
  }

  // 2. POST /v1/devices/{id}/revoke
  let m = path.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
  if (method === 'POST' && m) {
    requireRoot();
    await store.revokeDevice(decodeURIComponent(m[1]));
    return ok(res, { revoked: true });
  }

  // 6. POST /v1/admin/join-codes
  if (method === 'POST' && path === '/v1/admin/join-codes') {
    requireRoot();
    const body = await readBody(req);
    const code = await store.createJoinCode({
      scopeDevice: body.scope_device ?? null,
      scopeProject: body.scope_project ?? null,
      presetRole: body.preset_role ?? null,
      presetTask: body.preset_task ?? null,
      ttlHours: body.ttl_hours,
      maxUses: body.max_uses,
    });
    return ok(res, code, 201);
  }

  // 17. POST /v1/admin/join-codes/{code}/revoke
  m = path.match(/^\/v1\/admin\/join-codes\/([^/]+)\/revoke$/);
  if (method === 'POST' && m) {
    requireRoot();
    await store.revokeJoinCode(decodeURIComponent(m[1]));
    return ok(res, { revoked: true });
  }

  // 14. GET /v1/admin/overview
  if (method === 'GET' && path === '/v1/admin/overview') {
    requireRoot();
    return ok(res, await store.overview());
  }

  // 15. GET /v1/admin/export
  if (method === 'GET' && path === '/v1/admin/export') {
    requireRoot();
    const layer = (url.searchParams.get('layer') ?? 'roster') as ExportLayer;
    if (!['roster', 'messages', 'states'].includes(layer)) {
      throw bad('bad_layer', 'layer must be roster|messages|states');
    }
    const csv = await exportCsv(store, layer, {
      from: url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined,
      to: url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined,
      project: url.searchParams.get('project') ?? undefined,
    });
    return send(res, 200, csv, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${layer}.csv"`,
    });
  }

  // 16. POST /v1/roster/{conv_id}/status
  m = path.match(/^\/v1\/roster\/([^/]+)\/status$/);
  if (method === 'POST' && m) {
    requireRoot();
    const body = await readBody(req);
    if (!['active', 'paused', 'revoked'].includes(body.status)) {
      throw bad('bad_status', 'status must be active|paused|revoked');
    }
    return ok(res, await store.setRosterStatus(decodeURIComponent(m[1]), body.status));
  }

  // 4. POST /v1/roster/register  (self-registration; §3.1)
  if (method === 'POST' && path === '/v1/roster/register') {
    const deviceId = await requireDevice();
    const body = await readBody(req);
    // Binding proof: for T1 the bridge asserts the thread it created. The
    // proof-of-possession scan lives in the bridge (§1.2-A-2); the server
    // records the binding triple supplied by the authenticated device.
    if (!body.profile || !body.thread_id) throw bad('binding_required', 'profile and thread_id required');
    const row = await store.createRoster({
      deviceId,
      profile: body.profile,
      threadId: body.thread_id,
      alias: body.alias ?? 'unnamed',
      role: body.role ?? 'worker',
      task: body.task ?? '',
      taskRef: body.task_ref ?? null,
      project: body.project ?? 'default',
      ownerLabel: body.owner_label ?? 'owner',
      allowSources: body.allow_sources,
      tier: body.tier === 't2_desktop' ? 't2_desktop' : 't1_managed',
      registeredVia: 'self',
    });
    return ok(res, row, 201);
  }

  // 5. POST /v1/roster/join (§3.2)
  if (method === 'POST' && path === '/v1/roster/join') {
    const deviceId = await requireDevice();
    const body = await readBody(req);
    if (!body.code) throw bad('code_required', 'join code required');
    if (!body.profile || !body.thread_id) throw bad('binding_required', 'profile and thread_id required');
    const jc = await store.consumeJoinCode(body.code, deviceId);
    const row = await store.createRoster({
      deviceId,
      profile: body.profile,
      threadId: body.thread_id,
      alias: body.alias ?? 'unnamed',
      role: jc.preset_role ?? body.role ?? 'worker',
      task: jc.preset_task ?? body.task ?? '',
      taskRef: body.task_ref ?? null,
      project: jc.scope_project ?? body.project ?? 'default',
      ownerLabel: body.owner_label ?? 'owner',
      allowSources: body.allow_sources,
      tier: body.tier === 't2_desktop' ? 't2_desktop' : 't1_managed',
      registeredVia: `invite:${String(body.code).slice(0, 4)}`,
    });
    return ok(res, row, 201);
  }

  // 7. GET /v1/roster (discovery)
  if (method === 'GET' && path === '/v1/roster') {
    await requireDevice();
    const rows = await store.listRoster({
      project: url.searchParams.get('project') ?? undefined,
      role: url.searchParams.get('role') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
    });
    const now = Date.now();
    return ok(
      res,
      rows.map((r) => ({
        conv_id: r.conv_id,
        alias: r.alias,
        role: r.role,
        task: r.task,
        task_ref: r.task_ref,
        project: r.project,
        owner_label: r.owner_label,
        tier: r.tier,
        delivery_mode: r.delivery_mode,
        presence:
          r.tier === 't1_managed'
            ? {
                mode: 'heartbeat',
                heartbeat: true,
                online: r.last_seen_at !== null && now - r.last_seen_at <= store.cfg.offline_after_s * 1000,
                last_seen_at: r.last_seen_at,
              }
            : // §2.2 / §6.1: T2 desktop conversations have NO heartbeat — presence
              // is only the last time a human opened the conversation and pulled.
              { mode: 'last_pull_at', heartbeat: false, last_pull_at: r.last_pull_at, stale: true },
        roster_status: r.roster_status,
        accepts_from: r.allow_sources,
      })),
    );
  }

  // 8. GET /v1/roster/me (+ binding)
  if (method === 'GET' && path === '/v1/roster/me') {
    const deviceId = await requireDevice();
    const convId = url.searchParams.get('conv_id') ?? undefined;
    const profile = url.searchParams.get('profile') ?? undefined;
    const threadId = url.searchParams.get('thread_id') ?? undefined;
    try {
      const row = await resolveBinding(store, deviceId, {
        conv_id: convId,
        profile,
        thread_id: threadId,
      });
      return ok(res, row);
    } catch (e) {
      if (e instanceof HttpError && e.code === 'unbound') {
        return ok(res, {
          status: 'unbound',
          bootstrap: {
            self: 'POST /v1/roster/register {profile, thread_id, alias, role, task, project}',
            invite:
              'POST /v1/roster/join {code, profile, thread_id}  — code comes from the Owner-supplied "relay-join: XXXX-XXXX ..." line',
          },
        });
      }
      throw e;
    }
  }

  // 9. GET /v1/inbox?for=
  if (method === 'GET' && path === '/v1/inbox') {
    const deviceId = await requireDevice();
    const forConv = url.searchParams.get('for');
    if (!forConv) throw bad('for_required', 'for=<conv_id> required');
    const row = await store.getRosterOrThrow(forConv);
    if (row.device_id !== deviceId) throw forbidden('not_yours', 'cannot read another conversation inbox');
    const inbox = await store.inbox(forConv);
    if (row.tier === 't2_desktop') await store.markPull(forConv);
    return ok(res, inbox);
  }

  // 10. POST /v1/requests
  if (method === 'POST' && path === '/v1/requests') {
    const deviceId = await requireDevice();
    const body = await readBody(req);
    const from = await resolveBinding(store, deviceId, {
      conv_id: body.from_conv,
      profile: body.profile,
      thread_id: body.thread_id,
    });
    const row = await store.createRequest({
      from,
      to: body.to,
      type: body.type,
      body: body.body ?? '',
      context: body.context ?? null,
      resultRequirement: body.result_requirement ?? null,
      ttlS: body.ttl_s,
      parentRequestId: body.parent_request_id ?? null,
      clientKey: body.client_key ?? null,
    });
    return ok(res, row, 201);
  }

  // 13. POST /v1/requests/{id}/cancel
  m = path.match(/^\/v1\/requests\/([^/]+)\/cancel$/);
  if (method === 'POST' && m) {
    const deviceId = await requireDevice();
    const body = await readBody(req);
    const from = await resolveBinding(store, deviceId, {
      conv_id: body.from_conv,
      profile: body.profile,
      thread_id: body.thread_id,
    });
    return ok(res, await store.cancelRequest(decodeURIComponent(m[1]), from.conv_id));
  }

  // 18. POST /v1/requests/{id}/result
  m = path.match(/^\/v1\/requests\/([^/]+)\/result$/);
  if (method === 'POST' && m) {
    const deviceId = await requireDevice();
    const body = await readBody(req);
    const target = await resolveBinding(store, deviceId, {
      conv_id: body.conv_id,
      profile: body.profile,
      thread_id: body.thread_id,
    });
    const request = await store.getRequestOrThrow(decodeURIComponent(m[1]));
    if (request.to_conv !== target.conv_id) {
      throw forbidden('not_executor', 'only the executing conversation can submit results');
    }
    const { result, first } = await store.submitResult({
      requestId: request.request_id,
      kind: body.kind === 'STATUS' ? 'STATUS' : 'RESULT',
      body: body.body ?? '',
      evidence: body.evidence ?? null,
      execStatus: body.exec_status ?? null,
      turnId: body.turn_id ?? null,
      resultMissing: body.result_missing,
    });
    return ok(res, { result, first }, first ? 201 : 200);
  }

  // bridge control: claim (device received)
  m = path.match(/^\/v1\/requests\/([^/]+)\/claim$/);
  if (method === 'POST' && m) {
    const deviceId = await requireDevice();
    return ok(res, await store.claimRequest(decodeURIComponent(m[1]), deviceId));
  }

  // bridge control: start (turnId persisted)
  m = path.match(/^\/v1\/requests\/([^/]+)\/start$/);
  if (method === 'POST' && m) {
    const deviceId = await requireDevice();
    const body = await readBody(req);
    const req0 = await store.getRequestOrThrow(decodeURIComponent(m[1]));
    const row = await store.getRoster(req0.to_conv);
    if (!row || row.device_id !== deviceId) throw forbidden('not_target_device', 'not the target device');
    return ok(res, await store.startRequest(req0.request_id, body.turn_id ?? ''));
  }

  // 11. GET /v1/requests/{id}
  m = path.match(/^\/v1\/requests\/([^/]+)$/);
  if (method === 'GET' && m) {
    await requireDevice();
    const r = await store.getRequestOrThrow(decodeURIComponent(m[1]));
    return ok(res, {
      request_id: r.request_id,
      root_request_id: r.root_request_id,
      chain_depth: r.chain_depth,
      from_conv: r.from_conv,
      to_conv: r.to_conv,
      type: r.type,
      delivery_status: r.delivery_status,
      exec_status: r.exec_status,
      return_status: r.return_status,
      result_missing: r.result_missing,
      turn_id: r.turn_id,
      created_at: r.created_at,
      completed_at: r.completed_at,
      expires_at: r.expires_at,
    });
  }

  // 12. GET /v1/requests/{id}/result
  m = path.match(/^\/v1\/requests\/([^/]+)\/result$/);
  if (method === 'GET' && m) {
    await requireDevice();
    const data = await store.readResult(decodeURIComponent(m[1]));
    return ok(res, data);
  }

  throw new HttpError(404, 'no_route', `no route for ${method} ${path}`);
}
