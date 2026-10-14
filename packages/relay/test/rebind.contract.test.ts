import { afterEach, describe, expect, it } from 'vitest';
import { api, registerConv, registerDevice, startTestRelay, type TestRelay } from './helpers.js';

let current: TestRelay | undefined;
afterEach(async () => { await current?.close(); current = undefined; });
async function setup() {
  const t = current = await startTestRelay();
  const device = await registerDevice(t);
  const a = await registerConv(t, device.device_token, { profile: 'original', thread_id: 'lost-thread', alias: 'keep-alias', role: 'worker', project: 'keep-project', allow_sources: ['manual-source'] });
  const invitation = await api(t.baseUrl, 'POST', '/v1/pairing/invitations', { token: device.device_token, body: { conv_id: a.conv_id } });
  const redeemed = await api(t.baseUrl, 'POST', '/v1/pairing/redeem', { body: { code: invitation.body.data.code, profile: 'peer', thread_id: 'peer-thread', alias: 'peer', role: 'worker', task: 'work' } });
  expect(redeemed.status).toBe(201);
  return { t, device, a, b: redeemed.body.data };
}
const intent = { expected_thread_id: 'lost-thread', profile: 'recovered', thread_id: 'new-thread', reason: 'lost_local_thread' };
const rebind = (t: TestRelay, token: string, convId: string, body: unknown = intent) => api(t.baseUrl, 'POST', `/v1/roster/${convId}/rebind`, { token, body });

describe('explicit lost-thread recovery through real HTTP and embedded PostgreSQL', () => {
  it('keeps the same public conversation, pairing, ACL and metadata, with durable exact-intent idempotency', async () => {
    const { t, device, a, b } = await setup();
    const result = await rebind(t, device.device_token, a.conv_id);
    expect(result.status).toBe(200);
    expect(result.body.data.idempotent).toBe(false);
    expect(result.body.data.conversation).toEqual({ ...a, profile: 'recovered', thread_id: 'new-thread' });
    const repeated = await rebind(t, device.device_token, a.conv_id);
    expect(repeated.status).toBe(200);
    expect(repeated.body.data).toEqual({ ...result.body.data, idempotent: true });
    const audits = await t.relay.store.db.query('SELECT * FROM roster_rebindings');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ conv_id: a.conv_id, device_id: device.device_id, old_profile: 'original', old_thread_id: 'lost-thread', new_profile: 'recovered', new_thread_id: 'new-thread', reason: 'lost_local_thread' });
    expect(JSON.stringify(audits)).not.toContain(device.device_token);
    const roster = await t.relay.store.db.query('SELECT conv_id FROM roster');
    expect(roster).toHaveLength(2);
    const pairs = await api(t.baseUrl, 'GET', `/v1/pairings?conv_id=${a.conv_id}`, { token: device.device_token });
    expect(pairs.body.data[0]).toMatchObject({ pairing_id: b.pairing_id, peer_conv_id: b.conversation.conv_id, revoked_at: null });
    const sent = await api(t.baseUrl, 'POST', '/v1/requests', { token: b.device.device_token, body: { from_conv: b.conversation.conv_id, to: a.conv_id, type: 'QUERY', body: 'same-address-no-execution' } });
    expect(sent.status).toBe(201);
    expect(sent.body.data.to_conv).toBe(a.conv_id);
    expect((await rebind(t, device.device_token, a.conv_id, { ...intent, expected_thread_id: 'wrong-old-thread' })).status).toBe(409);
    expect(await t.relay.store.db.query('SELECT rebind_id FROM roster_rebindings')).toHaveLength(1);
  });

  it('requires device ownership, an active T1, strict arguments and an unoccupied target binding', async () => {
    const { t, device, a, b } = await setup();
    expect((await rebind(t, b.device.device_token, a.conv_id)).status).toBe(403);
    for (const invalid of [null, [], {}, { ...intent, reason: 'anything' }, { ...intent, thread_id: 3 }, { ...intent, profile: 'a'.repeat(129) }, { ...intent, thread_id: 'a'.repeat(257) }, { ...intent, expected_thread_id: 'bad\nvalue' }, { ...intent, extra: 'not-allowed' }]) {
      expect((await rebind(t, device.device_token, a.conv_id, invalid)).status).toBe(400);
    }
    const occupied = await registerConv(t, device.device_token, { profile: 'recovered', thread_id: 'new-thread', alias: 'other', role: 'worker' });
    expect((await rebind(t, device.device_token, a.conv_id)).body.error.code).toBe('binding_occupied');
    expect((await t.relay.store.getRosterOrThrow(occupied.conv_id)).thread_id).toBe('new-thread');
    expect((await t.relay.store.getRosterOrThrow(a.conv_id)).thread_id).toBe('lost-thread');
    await api(t.baseUrl, 'POST', `/v1/roster/${a.conv_id}/status`, { rootKey: t.rootKey, body: { status: 'paused' } });
    expect((await rebind(t, device.device_token, a.conv_id)).status).toBe(403);
    await t.relay.store.db.query("UPDATE roster SET roster_status='active',tier='t2_desktop' WHERE conv_id=$1", [a.conv_id]);
    expect((await rebind(t, device.device_token, a.conv_id)).status).toBe(403);
    expect(await t.relay.store.db.query('SELECT rebind_id FROM roster_rebindings')).toHaveLength(0);
  });

  it('rejects in-flight requests in either direction without mutating business state', async () => {
    const { t, device, a, b } = await setup();
    for (const reverse of [false, true]) {
      const response = await api(t.baseUrl, 'POST', '/v1/requests', { token: reverse ? device.device_token : b.device.device_token, body: { from_conv: reverse ? a.conv_id : b.conversation.conv_id, to: reverse ? b.conversation.conv_id : a.conv_id, type: 'QUERY', body: 'state-check-only' } });
      const id = response.body.data.request_id;
      for (const state of ['running', 'waiting_user', 'result_pending_verify']) {
        await t.relay.store.db.query('UPDATE requests SET exec_status=$2 WHERE request_id=$1', [id, state]);
        expect((await rebind(t, device.device_token, a.conv_id)).body.error.code).toBe('conversation_inflight');
        expect((await t.relay.store.getRequestOrThrow(id)).exec_status).toBe(state);
        expect((await t.relay.store.getRosterOrThrow(a.conv_id)).thread_id).toBe('lost-thread');
      }
      await t.relay.store.db.query("UPDATE requests SET exec_status='failed' WHERE request_id=$1", [id]);
    }
    expect((await rebind(t, device.device_token, a.conv_id)).status).toBe(200);
  });

  it('atomically rolls back the binding if the audit cannot persist, and serializes competing CAS intents', async () => {
    const { t, device, a } = await setup();
    await t.relay.store.db.exec('ALTER TABLE roster_rebindings ADD CONSTRAINT test_audit_failure CHECK (rebound_at < 0)');
    expect((await rebind(t, device.device_token, a.conv_id)).status).toBe(500);
    expect((await t.relay.store.getRosterOrThrow(a.conv_id)).thread_id).toBe('lost-thread');
    expect(await t.relay.store.db.query('SELECT rebind_id FROM roster_rebindings')).toHaveLength(0);
    await t.relay.store.db.exec('ALTER TABLE roster_rebindings DROP CONSTRAINT test_audit_failure');
    const results = await Promise.all([rebind(t, device.device_token, a.conv_id), rebind(t, device.device_token, a.conv_id, { ...intent, thread_id: 'different-new-thread' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await t.relay.store.db.query('SELECT rebind_id FROM roster_rebindings')).toHaveLength(1);
  });
});
