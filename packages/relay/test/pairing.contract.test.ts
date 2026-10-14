import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, registerConv, registerDevice, startTestRelay, TestWs, type TestRelay } from './helpers.js';
import { pairingCodeHash } from '../src/util.js';

let running: TestRelay[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  for (const t of running) await t.close();
  running = [];
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(dataDir?: string) {
  const t = await startTestRelay({}, dataDir);
  running.push(t);
  const device = await registerDevice(t);
  const a = await registerConv(t, device.device_token, { thread_id: 'a', alias: 'A', role: 'worker', project: 'p' });
  return { t, device, a };
}
const payload = { profile: 'default', thread_id: 'b', alias: 'B', role: 'worker', task: 'paired work' };
async function invite(t: TestRelay, token: string, convId: string) {
  const response = await api(t.baseUrl, 'POST', '/v1/pairing/invitations', { token, body: { conv_id: convId } });
  expect(response.status).toBe(201);
  return response.body.data;
}
async function redeem(t: TestRelay, code: string, token?: string, extra = {}) {
  return api(t.baseUrl, 'POST', '/v1/pairing/redeem', { token, body: { ...payload, ...extra, code } });
}
async function send(t: TestRelay, token: string, from: string, to: string, clientKey?: string) {
  return api(t.baseUrl, 'POST', '/v1/requests', { token, body: { from_conv: from, to, type: 'TASK', body: 'hello', client_key: clientKey } });
}

describe('device-independent conversation pairing over real HTTP and PostgreSQL', () => {
  it('bootstraps B without root, stores only a digest, grants both directions and pushes to the correct device', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    expect(inv.expires_at - Date.now()).toBeGreaterThan(590_000);
    expect(inv.expires_at - Date.now()).toBeLessThanOrEqual(600_000);
    expect(inv.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [stored] = await t.relay.store.db.query('SELECT * FROM pairing_invitations');
    expect(stored.code_hash).toBe(pairingCodeHash(inv.code));
    expect(JSON.stringify(stored)).not.toContain(inv.code);
    expect(stored).not.toHaveProperty('code');
    const result = await redeem(t, inv.code);
    expect(result.status).toBe(201);
    const b = result.body.data;
    expect(b.device.device_token).toMatch(/^[a-f0-9]{48}$/);
    expect(b.device.device_id).not.toBe(device.device_id);
    expect(b.peer_conv_id).toBe(a.conv_id);
    expect(b.conversation.project).toBe('p');
    expect(b.conversation.delivery_mode).toBe('push');
    expect(b.conversation.allow_sources).toEqual(['owner']);
    const wsB = new TestWs(t.wsUrl, b.device.device_token);
    await wsB.ready;
    const ab = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
    expect(ab.status).toBe(201);
    await wsB.waitFor((event) => event.event === 'request.available' && event.payload.request_id === ab.body.data.request_id);
    wsB.close();
    const ba = await send(t, b.device.device_token, b.conversation.conv_id, a.conv_id);
    expect(ba.status).toBe(201);
    const claimed = await api(t.baseUrl, 'POST', `/v1/requests/${ba.body.data.request_id}/claim`, { token: device.device_token });
    expect(claimed.body.data.delivery_status).toBe('device_received');
    const started = await api(t.baseUrl, 'POST', `/v1/requests/${ba.body.data.request_id}/start`, { token: device.device_token, body: { turn_id: 'real-test-turn' } });
    expect(started.body.data.exec_status).toBe('running');
    const list = await api(t.baseUrl, 'GET', `/v1/pairings?conv_id=${a.conv_id}`, { token: device.device_token });
    expect(list.body.data[0].peer_conv_id).toBe(b.conversation.conv_id);
    expect(JSON.stringify(list.body)).not.toContain(inv.code);
    expect(JSON.stringify(list.body)).not.toContain(b.device.device_token);
  });

  it('consumes only once under concurrent unauthenticated redemption without orphan devices', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const responses = await Promise.all([redeem(t, inv.code), redeem(t, inv.code)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await t.relay.store.db.query('SELECT device_id FROM devices')).toHaveLength(2);
    expect(await t.relay.store.db.query('SELECT conv_id FROM roster')).toHaveLength(2);
    expect(await t.relay.store.db.query('SELECT pairing_id FROM pairings')).toHaveLength(1);
    expect((await redeem(t, inv.code)).status).toBe(409);
  });

  it('rolls back device, roster and consumption on validation or database failure and allows a corrected retry', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    expect((await redeem(t, inv.code, undefined, { role: 'administrator' })).status).toBe(400);
    expect(await t.relay.store.db.query('SELECT device_id FROM devices')).toHaveLength(1);
    expect(await t.relay.store.db.query('SELECT conv_id FROM roster')).toHaveLength(1);
    expect((await t.relay.store.db.query('SELECT consumed_at FROM pairing_invitations'))[0].consumed_at).toBeNull();
    // A real DB constraint failure after device+roster insertion must roll back all of them.
    await t.relay.store.db.exec("ALTER TABLE pairings ADD CONSTRAINT test_failure CHECK (created_at < 0)");
    const rejected = await redeem(t, inv.code);
    expect(rejected.status).toBe(500);
    expect(rejected.body.error.message).toBe('internal server error');
    expect(await t.relay.store.db.query('SELECT device_id FROM devices')).toHaveLength(1);
    expect(await t.relay.store.db.query('SELECT conv_id FROM roster')).toHaveLength(1);
    expect((await t.relay.store.db.query('SELECT consumed_at FROM pairing_invitations'))[0].consumed_at).toBeNull();
    await t.relay.store.db.exec('ALTER TABLE pairings DROP CONSTRAINT test_failure');
    expect((await redeem(t, inv.code)).status).toBe(201);
  });

  it('refuses expiration, owner-revoked codes, invalid tokens and same-device pairing', async () => {
    const { t, device, a } = await setup();
    const expired = await invite(t, device.device_token, a.conv_id);
    await t.relay.store.db.query('UPDATE pairing_invitations SET expires_at=$1 WHERE invitation_id=$2', [Date.now() - 1, expired.invitation_id]);
    expect((await redeem(t, expired.code)).status).toBe(409);
    const revoked = await invite(t, device.device_token, a.conv_id);
    expect((await api(t.baseUrl, 'POST', `/v1/pairing/invitations/${revoked.invitation_id}/revoke`, { token: device.device_token, body: { conv_id: a.conv_id } })).status).toBe(200);
    expect((await redeem(t, revoked.code)).status).toBe(409);
    const valid = await invite(t, device.device_token, a.conv_id);
    expect((await redeem(t, valid.code, 'incorrect-token')).status).toBe(401);
    expect((await redeem(t, valid.code, device.device_token)).status).toBe(403);
    expect((await redeem(t, valid.code)).status).toBe(201);
    const inactive = await invite(t, device.device_token, a.conv_id);
    await api(t.baseUrl, 'POST', `/v1/devices/${device.device_id}/revoke`, { rootKey: t.rootKey });
    expect((await redeem(t, inactive.code)).status).toBe(409);
  });

  it('authenticates existing B without returning its token, retains its stable binding and manual ACL, and keeps T2 manual', async () => {
    const { t, device, a } = await setup();
    const bDev = await registerDevice(t);
    const original = await registerConv(t, bDev.device_token, { thread_id: 'b', alias: 'old', role: 'worker', project: 'p', allow_sources: ['manual-conv'] });
    const inv = await invite(t, device.device_token, a.conv_id);
    const response = await redeem(t, inv.code, bDev.device_token, { tier: 't2_desktop' });
    expect(response.status).toBe(201);
    expect(response.body.data.device).toEqual({ device_id: bDev.device_id });
    expect(response.body.data.conversation.conv_id).toBe(original.conv_id);
    expect(response.body.data.conversation.allow_sources).toEqual(['manual-conv']);
    expect(await t.relay.store.db.query('SELECT device_id FROM devices')).toHaveLength(2);
    const t2inv = await invite(t, device.device_token, a.conv_id);
    const t2 = await redeem(t, t2inv.code, undefined, { tier: 't2_desktop' });
    expect(t2.body.data.conversation.delivery_mode).toBe('manual_pull');
  });

  it('does not grant other conversations or devices and requires invitation ownership and pairing membership', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const third = await registerDevice(t);
    const c = await registerConv(t, third.device_token, { thread_id: 'c', alias: 'C', role: 'worker', project: 'p' });
    const wrongRevoke = await api(t.baseUrl, 'POST', `/v1/pairing/invitations/${inv.invitation_id}/revoke`, { token: third.device_token, body: { conv_id: c.conv_id } });
    expect(wrongRevoke.status).toBe(403);
    const b = (await redeem(t, inv.code)).body.data;
    const otherB = await registerConv(t, b.device.device_token, { thread_id: 'other-b', alias: 'other', role: 'worker', project: 'p' });
    expect((await send(t, b.device.device_token, otherB.conv_id, a.conv_id)).status).toBe(403);
    expect((await send(t, third.device_token, c.conv_id, b.conversation.conv_id)).status).toBe(403);
    expect((await send(t, device.device_token, a.conv_id, otherB.conv_id)).status).toBe(403);
    expect((await api(t.baseUrl, 'GET', `/v1/pairings?conv_id=${a.conv_id}`, { token: third.device_token })).status).toBe(403);
    expect((await api(t.baseUrl, 'POST', `/v1/pairings/${b.pairing_id}/revoke`, { token: third.device_token, body: { conv_id: c.conv_id } })).status).toBe(403);
    expect((await send(t, device.device_token, a.conv_id, b.conversation.conv_id)).status).toBe(201);
  });

  it('unpairs from either member, rejects pending claim/start and idempotent send bypasses, but preserves explicit manual grants', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    const pending = await send(t, device.device_token, a.conv_id, b.conversation.conv_id, 'retry-key');
    expect(pending.status).toBe(201);
    expect((await api(t.baseUrl, 'POST', `/v1/pairings/${b.pairing_id}/revoke`, { token: b.device.device_token, body: { conv_id: b.conversation.conv_id } })).status).toBe(200);
    expect((await send(t, device.device_token, a.conv_id, b.conversation.conv_id, 'retry-key')).status).toBe(403);
    expect((await send(t, b.device.device_token, b.conversation.conv_id, a.conv_id)).status).toBe(403);
    for (const action of ['claim', 'start']) {
      expect((await api(t.baseUrl, 'POST', `/v1/requests/${pending.body.data.request_id}/${action}`, { token: b.device.device_token, body: { turn_id: 'should-not-start' } })).status).toBe(403);
    }
    const stored = await t.relay.store.getRequest(pending.body.data.request_id);
    expect(stored?.exec_status).toBe('pending');
    const inv2 = await invite(t, device.device_token, a.conv_id);
    const again = await redeem(t, inv2.code, b.device.device_token);
    expect(again.body.data.conversation.conv_id).toBe(b.conversation.conv_id);
    await registerConv(t, b.device.device_token, { thread_id: 'b', alias: 'manual', role: 'worker', project: 'p', allow_sources: [a.conv_id] });
    await api(t.baseUrl, 'POST', `/v1/pairings/${again.body.data.pairing_id}/revoke`, { token: device.device_token, body: { conv_id: a.conv_id } });
    expect((await send(t, device.device_token, a.conv_id, b.conversation.conv_id)).status).toBe(201);
    expect((await send(t, b.device.device_token, b.conversation.conv_id, a.conv_id)).status).toBe(403);
  });

  it('persists pairing grants over server restart and ordinary roster re-registration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-pairing-'));
    tempDirs.push(dir);
    const { t, device, a } = await setup(dir);
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    await t.close();
    running = running.filter((x) => x !== t);
    const restarted = await startTestRelay({}, dir);
    running.push(restarted);
    const fresh = await registerConv(restarted, b.device.device_token, { thread_id: 'b', alias: 'restarted', role: 'worker', project: 'p' });
    expect(fresh.conv_id).toBe(b.conversation.conv_id);
    expect((await send(restarted, device.device_token, a.conv_id, fresh.conv_id)).status).toBe(201);
    expect((await send(restarted, b.device.device_token, fresh.conv_id, a.conv_id)).status).toBe(201);
    expect((await redeem(restarted, inv.code)).status).toBe(409);
  });

  it('denies spending authorization after claim then unpair, without inventing a turn or starting execution', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    const pending = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
    const id = pending.body.data.request_id;
    expect((await api(t.baseUrl, 'POST', `/v1/requests/${id}/claim`, { token: b.device.device_token })).status).toBe(200);
    await api(t.baseUrl, 'POST', `/v1/pairings/${b.pairing_id}/revoke`, { token: device.device_token, body: { conv_id: a.conv_id } });
    const denied = await api(t.baseUrl, 'POST', `/v1/requests/${id}/authorize-start`, { token: b.device.device_token });
    expect(denied.status).toBe(403);
    const row = await t.relay.store.getRequestOrThrow(id);
    expect(row.start_authorized_at).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.turn_id).toBeNull();
    expect(row.exec_status).toBe('pending');
    expect((await api(t.baseUrl, 'POST', `/v1/requests/${id}/start`, { token: b.device.device_token, body: { turn_id: 'unpermitted' } })).status).toBe(403);
  });

  it('persists an idempotent grant before execution and accepts its real turn ID after later unpair', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    const pending = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
    const id = pending.body.data.request_id;
    const wrongDevice = await api(t.baseUrl, 'POST', `/v1/requests/${id}/authorize-start`, { token: device.device_token });
    expect(wrongDevice.status).toBe(403);
    const permitted = await api(t.baseUrl, 'POST', `/v1/requests/${id}/authorize-start`, { token: b.device.device_token });
    expect(permitted.status).toBe(200);
    expect(permitted.body.data.start_authorized_at).toBeGreaterThan(0);
    expect(permitted.body.data.started_at).toBe(permitted.body.data.start_authorized_at);
    expect(permitted.body.data.exec_status).toBe('running');
    expect(permitted.body.data.turn_id).toBeNull();
    await api(t.baseUrl, 'POST', `/v1/pairings/${b.pairing_id}/revoke`, { token: device.device_token, body: { conv_id: a.conv_id } });
    const duplicate = await api(t.baseUrl, 'POST', `/v1/requests/${id}/authorize-start`, { token: b.device.device_token });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.start_authorized_at).toBe(permitted.body.data.start_authorized_at);
    const reported = await api(t.baseUrl, 'POST', `/v1/requests/${id}/start`, { token: b.device.device_token, body: { turn_id: 'actual-local-turn' } });
    expect(reported.status).toBe(200);
    expect(reported.body.data.turn_id).toBe('actual-local-turn');
    expect(reported.body.data.started_at).toBe(permitted.body.data.started_at);
  });

  it('never grants a terminal, cancelled or expired request even before the sweeper runs', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    for (const state of ['expired', 'cancelled', 'failed', 'completed']) {
      const pending = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
      const id = pending.body.data.request_id;
      if (state === 'expired') await t.relay.store.db.query('UPDATE requests SET expires_at=$2 WHERE request_id=$1', [id, Date.now() - 1]);
      else if (state === 'cancelled') await api(t.baseUrl, 'POST', `/v1/requests/${id}/cancel`, { token: device.device_token, body: { from_conv: a.conv_id } });
      else await t.relay.store.db.query('UPDATE requests SET exec_status=$2 WHERE request_id=$1', [id, state]);
      expect((await api(t.baseUrl, 'POST', `/v1/requests/${id}/authorize-start`, { token: b.device.device_token })).status).toBe(409);
      const row = await t.relay.store.getRequestOrThrow(id);
      expect(row.start_authorized_at).toBeNull();
      expect(row.turn_id).toBeNull();
    }
  });

  it('serializes unpair against the spending grant and treats a winning grant as in flight', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    const pending = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
    const id = pending.body.data.request_id;
    const [grant, revoke] = await Promise.all([
      api(t.baseUrl, 'POST', `/v1/requests/${id}/authorize-start`, { token: b.device.device_token }),
      api(t.baseUrl, 'POST', `/v1/pairings/${b.pairing_id}/revoke`, { token: device.device_token, body: { conv_id: a.conv_id } }),
    ]);
    expect(revoke.status).toBe(200);
    expect([200, 403]).toContain(grant.status);
    const row = await t.relay.store.getRequestOrThrow(id);
    expect(row.start_authorized_at !== null).toBe(grant.status === 200);
    const reported = await api(t.baseUrl, 'POST', `/v1/requests/${id}/start`, { token: b.device.device_token, body: { turn_id: 'real-race-turn' } });
    expect(reported.status).toBe(grant.status === 200 ? 200 : 403);
  });

  it('bounds public redemption attempts using socket address even when forwarded addresses vary', async () => {
    const { t } = await setup();
    for (let i = 0; i < 30; i++) {
      const response = await fetch(t.baseUrl + '/v1/pairing/redeem', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `192.0.2.${i}` }, body: JSON.stringify({ ...payload, code: 'a'.repeat(32) }) });
      expect(response.status).toBe(409);
    }
    expect((await redeem(t, 'a'.repeat(32))).status).toBe(429);
  });

  it('serializes actual admin roster pause/revoke against authorization and denies all later grants', async () => {
    const { t, device, a } = await setup();
    const inv = await invite(t, device.device_token, a.conv_id);
    const b = (await redeem(t, inv.code)).body.data;
    for (const convId of [a.conv_id, b.conversation.conv_id]) {
      for (const status of ['paused', 'revoked']) {
        for (const member of [a.conv_id, b.conversation.conv_id]) {
          expect((await api(t.baseUrl, 'POST', `/v1/roster/${member}/status`, { rootKey: t.rootKey, body: { status: 'active' } })).status).toBe(200);
        }
        const racing = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
        const later = await send(t, device.device_token, a.conv_id, b.conversation.conv_id);
        expect(racing.status).toBe(201);
        expect(later.status).toBe(201);
        const [changed, grant] = await Promise.all([
          api(t.baseUrl, 'POST', `/v1/roster/${convId}/status`, { rootKey: t.rootKey, body: { status } }),
          api(t.baseUrl, 'POST', `/v1/requests/${racing.body.data.request_id}/authorize-start`, { token: b.device.device_token }),
        ]);
        expect(changed.status).toBe(200);
        expect([200, 403]).toContain(grant.status);
        const racedRow = await t.relay.store.getRequestOrThrow(racing.body.data.request_id);
        expect(racedRow.start_authorized_at !== null).toBe(grant.status === 200);
        // After the admin mutation has returned, no old active snapshot can grant.
        expect((await api(t.baseUrl, 'POST', `/v1/requests/${later.body.data.request_id}/authorize-start`, { token: b.device.device_token })).status).toBe(403);
        expect((await t.relay.store.getRequestOrThrow(later.body.data.request_id)).start_authorized_at).toBeNull();
      }
    }
  });
});
