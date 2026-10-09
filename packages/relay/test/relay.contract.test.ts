/**
 * Relay contract tests — driven end-to-end through the real production chain
 * (real HTTP router, real WebSocket hub, real DB). Store internals are only
 * inspected to *corroborate* an observation already made through the API.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  registerConv,
  registerDevice,
  startTestRelay,
  TestWs,
  type TestRelay,
} from './helpers.js';

let current: TestRelay | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(config: Record<string, number> = {}) {
  current = await startTestRelay(config);
  return current;
}

/** Register A and B, then open B to A (allow_sources=[convA]). */
async function twoConvs(t: TestRelay) {
  const dev = await registerDevice(t);
  const a = await registerConv(t, dev.device_token, { thread_id: 'th-a', alias: 'alpha', role: 'manager' });
  const b = await registerConv(t, dev.device_token, { thread_id: 'th-b', alias: 'beta', role: 'worker' });
  // Re-registering the same thread is an *update* (same conv_id), which is how
  // allow_sources is explicitly opened (§2.2).
  const b2 = await registerConv(t, dev.device_token, {
    thread_id: 'th-b',
    alias: 'beta',
    role: 'worker',
    allow_sources: [a.conv_id],
  });
  expect(b2.conv_id).toBe(b.conv_id);
  return { dev, a, b: b2 };
}

describe('identity & auth', () => {
  it('device register requires the root key', async () => {
    const t = await setup();
    const noKey = await api(t.baseUrl, 'POST', '/v1/devices/register', { body: { owner_label: 'x' } });
    expect(noKey.status).toBe(401);
    const withKey = await api(t.baseUrl, 'POST', '/v1/devices/register', {
      rootKey: t.rootKey,
      body: { owner_label: 'x' },
    });
    expect(withKey.status).toBe(201);
  });

  it('roster/register requires a device token', async () => {
    const t = await setup();
    const r = await api(t.baseUrl, 'POST', '/v1/roster/register', {
      body: { profile: 'default', thread_id: 'th', alias: 'a', role: 'worker' },
    });
    expect(r.status).toBe(401);
  });

  it('admin endpoints require the root key', async () => {
    const t = await setup();
    expect((await api(t.baseUrl, 'GET', '/v1/admin/overview')).status).toBe(401);
    expect((await api(t.baseUrl, 'GET', '/v1/admin/export?layer=roster')).status).toBe(401);
  });
});

describe('roster & discovery', () => {
  it('registers, discovers and self-identifies', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const a = await registerConv(t, dev.device_token, { thread_id: 'th-a', alias: 'alpha', role: 'worker' });
    expect(a.conv_id).toMatch(/^c-/);

    const list = await api(t.baseUrl, 'GET', '/v1/roster', { token: dev.device_token });
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: any) => x.conv_id)).toContain(a.conv_id);
    expect(list.body.data[0].tier).toBe('t1_managed');
    expect(list.body.data[0].presence.mode).toBe('heartbeat');

    const me = await api(
      t.baseUrl,
      'GET',
      `/v1/roster/me?profile=default&thread_id=th-a`,
      { token: dev.device_token },
    );
    expect(me.status).toBe(200);
    expect(me.body.data.conv_id).toBe(a.conv_id);
  });

  it('returns unbound + bootstrap guidance for an unknown binding', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const me = await api(t.baseUrl, 'GET', '/v1/roster/me?profile=default&thread_id=nope', {
      token: dev.device_token,
    });
    expect(me.status).toBe(200);
    expect(me.body.data.status).toBe('unbound');
    expect(me.body.data.bootstrap.invite).toContain('relay-join');
  });

  it('never leaks message bodies through discovery', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'SECRET-BODY-TEXT' },
    });
    const list = await api(t.baseUrl, 'GET', '/v1/roster', { token: dev.device_token });
    expect(JSON.stringify(list.body)).not.toContain('SECRET-BODY-TEXT');
  });

  it('marks a T2 desktop conversation as pull-only with no heartbeat (§6.1)', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const r = await api(t.baseUrl, 'POST', '/v1/roster/register', {
      token: dev.device_token,
      body: {
        profile: 'default',
        thread_id: 'th-desktop',
        alias: 'desktop',
        role: 'worker',
        task: 'x',
        project: 'codex-relay',
        tier: 't2_desktop',
      },
    });
    expect(r.body.data.tier).toBe('t2_desktop');
    expect(r.body.data.delivery_mode).toBe('manual_pull');
    const list = await api(t.baseUrl, 'GET', '/v1/roster', { token: dev.device_token });
    const row = list.body.data.find((x: any) => x.conv_id === r.body.data.conv_id);
    expect(row.presence.mode).toBe('last_pull_at');
    expect(row.presence.heartbeat).toBe(false);
    expect(row.presence.stale).toBe(true);
  });
});

describe('permissions (§6)', () => {
  it('denies a conversation send by default (allow_sources=["owner"])', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const a = await registerConv(t, dev.device_token, { thread_id: 'th-a', alias: 'a', role: 'worker' });
    const b = await registerConv(t, dev.device_token, { thread_id: 'th-b', alias: 'b', role: 'worker' });
    const r = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'hi' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('source_not_allowed');
  });

  it('allows the send once allow_sources names the sender', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const r = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'hi' },
    });
    expect(r.status).toBe(201);
  });

  it('rejects a body larger than 64KB (413)', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const r = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x'.repeat(65537) },
    });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('body_too_large');
  });

  it('rejects a send to an inactive target', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    await api(t.baseUrl, 'POST', `/v1/roster/${b.conv_id}/status`, {
      rootKey: t.rootKey,
      body: { status: 'revoked' },
    });
    const r = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'hi' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('target_inactive');
  });
});

describe('§5.2 three-layer status', () => {
  it('moves delivery/exec/return through the real lifecycle', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'do it' },
    });
    const id = sent.body.data.request_id;
    expect(sent.body.data.delivery_status).toBe('queued');
    expect(sent.body.data.exec_status).toBe('pending');
    expect(sent.body.data.return_addr).toBe(a.conv_id);

    await api(t.baseUrl, 'POST', `/v1/requests/${id}/claim`, { token: dev.device_token, body: {} });
    let st = await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token });
    expect(st.body.data.delivery_status).toBe('device_received');

    await api(t.baseUrl, 'POST', `/v1/requests/${id}/start`, {
      token: dev.device_token,
      body: { turn_id: 'turn-1' },
    });
    st = await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token });
    expect(st.body.data.exec_status).toBe('running');
    expect(st.body.data.turn_id).toBe('turn-1');

    await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'completed', body: 'DONE', evidence: 'git:abc' },
    });
    st = await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token });
    expect(st.body.data.exec_status).toBe('completed');
    expect(st.body.data.return_status).toBe('cloud_saved');
  });

  it('marks a result-missing request instead of claiming business completion', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' },
    });
    const id = sent.body.data.request_id;
    await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'failed', body: '', result_missing: true },
    });
    const st = await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token });
    expect(st.body.data.exec_status).toBe('failed');
    expect(st.body.data.result_missing).toBe(true);
  });
});

describe('§5.2 result dedupe', () => {
  it('archives the second RESULT without a second delivery', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const ws = new TestWs(t.wsUrl, dev.device_token);
    await ws.ready;

    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' },
    });
    const id = sent.body.data.request_id;
    await ws.waitFor((m) => m.type === 'event' && m.event === 'request.available');

    const first = await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'completed', body: 'FIRST' },
    });
    expect(first.body.data.first).toBe(true);
    const second = await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'completed', body: 'SECOND' },
    });
    expect(second.body.data.first).toBe(false);

    const r = await api(t.baseUrl, 'GET', `/v1/requests/${id}/result`, { token: dev.device_token });
    expect(r.body.data.results.length).toBe(2);
    expect(r.body.data.results[1].is_first).toBe(false);

    const deliveries = await ws.waitFor(
      (m) => m.type === 'event' && m.event === 'result.available',
    );
    expect(deliveries).toBeTruthy();
    const allResults = ws.events.filter((m) => m.type === 'event' && m.event === 'result.available');
    expect(allResults.length).toBe(1);
    ws.close();
  });
});

describe('§5.4 chain limit', () => {
  it('rejects the request past the limit and emits exactly one notice', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const send = (body: any) =>
      api(t.baseUrl, 'POST', '/v1/requests', { token: dev.device_token, body });

    const root = await send({ from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'root' });
    expect(root.status).toBe(201);
    let parent = root.body.data.request_id;
    // depth 1..3 are allowed with chain_limit=3
    for (let depth = 1; depth <= 3; depth++) {
      const r = await send({
        from_conv: a.conv_id,
        to: b.conv_id,
        type: 'CLARIFY',
        body: `c${depth}`,
        parent_request_id: parent,
      });
      expect(r.status).toBe(201);
      expect(r.body.data.chain_depth).toBe(depth);
      parent = r.body.data.request_id;
    }
    // depth 4 (the N+1) is rejected
    const over = await send({
      from_conv: a.conv_id,
      to: b.conv_id,
      type: 'CLARIFY',
      body: 'c4',
      parent_request_id: parent,
    });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('chain_limit_reached');

    // exactly one notice, even after another attempt
    await send({ from_conv: a.conv_id, to: b.conv_id, type: 'CLARIFY', body: 'c4b', parent_request_id: parent });
    const notices = await t.relay.store.db.query(
      "SELECT * FROM notices WHERE kind='chain_limit'",
    );
    expect(notices.length).toBe(1);
  });

  it('honours the database-configured limit (not an env var)', async () => {
    const t = await setup({ chain_limit: 1 });
    const { dev, a, b } = await twoConvs(t);
    const send = (body: any) =>
      api(t.baseUrl, 'POST', '/v1/requests', { token: dev.device_token, body });
    const root = await send({ from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'root' });
    const c1 = await send({
      from_conv: a.conv_id,
      to: b.conv_id,
      type: 'CLARIFY',
      body: 'c1',
      parent_request_id: root.body.data.request_id,
    });
    expect(c1.status).toBe(201);
    const c2 = await send({
      from_conv: a.conv_id,
      to: b.conv_id,
      type: 'CLARIFY',
      body: 'c2',
      parent_request_id: c1.body.data.request_id,
    });
    expect(c2.status).toBe(409);
  });
});

describe('§5.4 cancel', () => {
  it('cancels an unstarted request outright', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' },
    });
    const id = sent.body.data.request_id;
    const c = await api(t.baseUrl, 'POST', `/v1/requests/${id}/cancel`, {
      token: dev.device_token,
      body: { from_conv: a.conv_id },
    });
    expect(c.body.data.exec_status).toBe('interrupted');
    expect(c.body.data.delivery_status).toBe('rejected');
  });

  it('only signals an interrupt for a running request', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const ws = new TestWs(t.wsUrl, dev.device_token);
    await ws.ready;
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' },
    });
    const id = sent.body.data.request_id;
    await api(t.baseUrl, 'POST', `/v1/requests/${id}/start`, {
      token: dev.device_token,
      body: { turn_id: 't1' },
    });
    await api(t.baseUrl, 'POST', `/v1/requests/${id}/cancel`, {
      token: dev.device_token,
      body: { from_conv: a.conv_id },
    });
    const ev = await ws.waitFor(
      (m) => m.type === 'event' && m.payload?.control === 'cancel' && m.payload?.request_id === id,
    );
    expect(ev).toBeTruthy();
    const st = await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token });
    // still running until the executor reports the real terminal state
    expect(st.body.data.exec_status).toBe('running');
    ws.close();
  });
});

describe('§4 inbox', () => {
  it('shows the request on both sides', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' },
    });
    const id = sent.body.data.request_id;
    const inb = await api(t.baseUrl, 'GET', `/v1/inbox?for=${b.conv_id}`, { token: dev.device_token });
    expect(inb.body.data.pending_for_me.map((r: any) => r.request_id)).toContain(id);
    const out = await api(t.baseUrl, 'GET', `/v1/inbox?for=${a.conv_id}`, { token: dev.device_token });
    expect(out.body.data.my_outbox.map((r: any) => r.request_id)).toContain(id);
  });

  it('refuses to read another conversation inbox', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const other = await registerDevice(t);
    const r = await api(t.baseUrl, 'GET', `/v1/inbox?for=${a.conv_id}`, { token: other.device_token });
    expect(r.status).toBe(403);
  });
});

describe('§6 human diagnostic face', () => {
  it('overview reports the required minimum fields', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const ov = await api(t.baseUrl, 'GET', '/v1/admin/overview', { rootKey: t.rootKey });
    expect(ov.status).toBe(200);
    expect(ov.body.data).toHaveProperty('devices');
    expect(ov.body.data).toHaveProperty('backlog_by_conv');
    expect(ov.body.data).toHaveProperty('waiting_user');
    expect(ov.body.data).toHaveProperty('results_pending');
    expect(ov.body.data).toHaveProperty('failed');
  });

  it('exports roster CSV with a UTF-8 BOM and a tier column', async () => {
    const t = await setup();
    const { dev } = await twoConvs(t);
    const res = await fetch(t.baseUrl + '/v1/admin/export?layer=roster', {
      headers: { 'x-root-key': t.rootKey },
    });
    // fetch().text() strips a leading BOM per the WHATWG UTF-8 decode algorithm,
    // so the BOM must be checked on the raw bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(res.status).toBe(200);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.split('\r\n')[0]).toContain('tier');
    expect(text).toContain('t1_managed');
    void dev;
  });
});

describe('§8 device revocation', () => {
  it('blocks the device token and pauses its conversations', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const a = await registerConv(t, dev.device_token, { thread_id: 'th-a', alias: 'a', role: 'worker' });
    await api(t.baseUrl, 'POST', `/v1/devices/${dev.device_id}/revoke`, { rootKey: t.rootKey });
    const again = await api(t.baseUrl, 'GET', '/v1/roster', { token: dev.device_token });
    expect(again.status).toBe(401);
    const row = await t.relay.store.getRoster(a.conv_id);
    expect(row?.roster_status).toBe('paused');
  });
});

describe('§3.2 join codes', () => {
  it('mints, consumes and revokes a code', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const mint = await api(t.baseUrl, 'POST', '/v1/admin/join-codes', {
      rootKey: t.rootKey,
      body: { preset_role: 'verifier', preset_task: 'review', max_uses: 1, ttl_hours: 1 },
    });
    const code = mint.body.data.code;
    const join = await api(t.baseUrl, 'POST', '/v1/roster/join', {
      token: dev.device_token,
      body: { code, profile: 'default', thread_id: 'th-v', alias: 'vera' },
    });
    expect(join.status).toBe(201);
    expect(join.body.data.role).toBe('verifier'); // preset wins over self-report
    expect(join.body.data.registered_via).toContain('invite:');

    // one-shot: second use is exhausted
    const again = await api(t.baseUrl, 'POST', '/v1/roster/join', {
      token: dev.device_token,
      body: { code, profile: 'default', thread_id: 'th-v2', alias: 'vera2' },
    });
    expect(again.status).toBe(409);

    // revoke path
    const mint2 = await api(t.baseUrl, 'POST', '/v1/admin/join-codes', { rootKey: t.rootKey, body: {} });
    await api(t.baseUrl, 'POST', `/v1/admin/join-codes/${mint2.body.data.code}/revoke`, { rootKey: t.rootKey });
    const revoked = await api(t.baseUrl, 'POST', '/v1/roster/join', {
      token: dev.device_token,
      body: { code: mint2.body.data.code, profile: 'default', thread_id: 'th-z', alias: 'z' },
    });
    expect(revoked.status).toBe(409);
  });
});

describe('§7.2 unstarted expiry', () => {
  it('expires an unstarted request and never lets it start', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x', ttl_s: 0 },
    });
    const id = sent.body.data.request_id;
    const n = await t.relay.store.expireUnstarted(); // the production sweeper entry point
    expect(n).toBeGreaterThanOrEqual(1);
    const st = await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token });
    expect(st.body.data.delivery_status).toBe('expired');
    expect(st.body.data.exec_status).toBe('interrupted');
  });
});

describe('§9 #3 WebSocket channel', () => {
  it('authenticates, acks heartbeat and pushes a directed event', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const ws = new TestWs(t.wsUrl, dev.device_token);
    await ws.ready;
    const hello = await ws.waitFor((m) => m.type === 'hello');
    expect(hello.device_id).toBe(dev.device_id);
    ws.send({ type: 'heartbeat', convs: [b.conv_id] });
    await ws.waitFor((m) => m.type === 'heartbeat_ack');
    await api(t.baseUrl, 'POST', '/v1/requests', {
      token: dev.device_token,
      body: { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' },
    });
    const ev = await ws.waitFor((m) => m.type === 'event' && m.event === 'request.available');
    expect(ev.payload.to_conv).toBe(b.conv_id);
    ws.close();
  });

  it('rejects a WS connection without a token', async () => {
    const t = await setup();
    const ws = new TestWs(t.wsUrl, 'bogus-token');
    await expect(ws.ready).rejects.toBeTruthy();
  });
});
