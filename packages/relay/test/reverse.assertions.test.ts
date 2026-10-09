/**
 * Reverse assertions (SD-4). Each guard has a *positive* contract test; here we
 * put a short-circuited variant back in and assert the same probe turns red.
 * If a guard were ever removed or bypassed, these probes would flip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { api, registerConv, registerDevice, startTestRelay, type TestRelay } from './helpers.js';

let current: TestRelay | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function setup(config: Record<string, number> = {}) {
  current = await startTestRelay(config);
  return current;
}

async function twoConvs(t: TestRelay) {
  const dev = await registerDevice(t);
  const a = await registerConv(t, dev.device_token, { thread_id: 'th-a', alias: 'a', role: 'manager' });
  const b = await registerConv(t, dev.device_token, {
    thread_id: 'th-b',
    alias: 'b',
    role: 'worker',
    allow_sources: [a.conv_id],
  });
  return { dev, a, b };
}

const send = (t: TestRelay, token: string, body: any) =>
  api(t.baseUrl, 'POST', '/v1/requests', { token, body });

describe('reverse assertion: chain limit', () => {
  it('a chain that ignores the cap would accept the N+1 request', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const root = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'r' });
    let parent = root.body.data.request_id;
    for (let d = 1; d <= 3; d++) {
      const r = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'CLARIFY', body: `c${d}`, parent_request_id: parent });
      parent = r.body.data.request_id;
    }
    // Guarded behaviour: rejected.
    const over = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'CLARIFY', body: 'c4', parent_request_id: parent });
    expect(over.status).toBe(409);

    // MUTANT: raise the configured cap (the guard reads it at runtime).
    t.relay.store.cfg.chain_limit = 999;
    const mutant = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'CLARIFY', body: 'c4b', parent_request_id: parent });
    expect(mutant.status).toBe(201); // i.e. the positive assertion above is sensitive to the guard
  });
});

describe('reverse assertion: 64KB body cap', () => {
  it('a server without the cap would accept an oversized body', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const big = 'x'.repeat(65537);
    expect((await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: big })).status).toBe(413);

    t.relay.store.cfg.body_max_bytes = 10_000_000; // MUTANT: short-circuit the cap
    expect((await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: big })).status).toBe(201);
  });
});

describe('reverse assertion: source permission', () => {
  it('a no-op permission check would let a forbidden sender through', async () => {
    const t = await setup();
    const dev = await registerDevice(t);
    const a = await registerConv(t, dev.device_token, { thread_id: 'th-a', alias: 'a', role: 'worker' });
    const b = await registerConv(t, dev.device_token, { thread_id: 'th-b', alias: 'b', role: 'worker' });
    // default allow_sources = ["owner"] ⇒ denied
    expect((await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' })).status).toBe(403);

    (t.relay.store as any).assertCanSend = () => {}; // MUTANT: guard becomes a no-op
    expect((await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' })).status).toBe(201);
  });
});

describe('reverse assertion: RESULT dedupe', () => {
  it('a server that ignores prior results would deliver twice', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x' });
    const id = sent.body.data.request_id;

    const first = await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'completed', body: 'A' },
    });
    const second = await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'completed', body: 'B' },
    });
    expect(first.body.data.first).toBe(true);
    expect(second.body.data.first).toBe(false);

    // MUTANT: forget prior results so everything looks like the first.
    const store = t.relay.store;
    const real = store.submitResult.bind(store);
    store.submitResult = async (input: any) => {
      await store.db.query("DELETE FROM results WHERE request_id=$1 AND kind='RESULT'", [input.requestId]);
      return real(input);
    };
    const third = await api(t.baseUrl, 'POST', `/v1/requests/${id}/result`, {
      token: dev.device_token,
      body: { conv_id: b.conv_id, kind: 'RESULT', exec_status: 'completed', body: 'C' },
    });
    expect(third.body.data.first).toBe(true); // dedupe gone ⇒ positive assertion would be red
  });
});

describe('reverse assertion: unstarted expiry', () => {
  it('a server without the sweeper would leave the request startable', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'x', ttl_s: 0 });
    const id = sent.body.data.request_id;
    expect(await t.relay.store.expireUnstarted()).toBeGreaterThanOrEqual(1);
    expect((await api(t.baseUrl, 'GET', `/v1/requests/${id}`, { token: dev.device_token })).body.data.delivery_status).toBe('expired');

    // MUTANT: sweeper becomes a no-op.
    t.relay.store.expireUnstarted = async () => 0;
    const sent2 = await send(t, dev.device_token, { from_conv: a.conv_id, to: b.conv_id, type: 'TASK', body: 'y', ttl_s: 0 });
    await t.relay.store.expireUnstarted();
    const st = await api(t.baseUrl, 'GET', `/v1/requests/${sent2.body.data.request_id}`, { token: dev.device_token });
    expect(st.body.data.delivery_status).toBe('queued'); // not expired ⇒ positive assertion would be red
  });
});

describe('reverse assertion: return address is server-bound', () => {
  it('a body cannot re-point the return address', async () => {
    const t = await setup();
    const { dev, a, b } = await twoConvs(t);
    const sent = await send(t, dev.device_token, {
      from_conv: a.conv_id,
      to: b.conv_id,
      type: 'TASK',
      body: 'x',
      return_addr: 'c-attacker',
      return_address: 'c-attacker',
    });
    expect(sent.body.data.return_addr).toBe(a.conv_id);
  });
});
