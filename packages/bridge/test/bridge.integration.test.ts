/**
 * Bridge <-> mock Codex integration tests.
 *
 * These drive the *real* bridge against a *real* relay (HTTP+WS) and a mock
 * App Server process. Coverage in THIS file: round trip in both directions,
 * duplicate delivery dedupe, duplicate terminal notification, missing terminal
 * state, and cancel-while-running. The §5.3 crash window, offline→restart
 * backlog pickup and the outbox replay live in `recovery.test.ts` (kept in a
 * separate process so they get a fresh, unloaded runtime).
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  getRequest,
  registerDevice,
  send,
  sleep,
  startBridge,
  startRelay,
  submitResult,
  updateAllowSources,
  waitFor,
  type BridgeHandle,
  type TestEnv,
} from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
const bridges: BridgeHandle[] = [];

afterEach(async () => {
  // Stop bridges first so no in-flight dispatch touches a closed state store.
  while (bridges.length) {
    const b = bridges.pop()!;
    try {
      await b.stop();
    } catch {
      /* ignore */
    }
  }
  await sleep(250);
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch {
      /* ignore */
    }
  }
});

function trackEnv(env: TestEnv) {
  cleanups.push(() => env.close());
  return env;
}
function trackBridge(b: BridgeHandle) {
  bridges.push(b);
  cleanups.push(() => b.stop());
  return b;
}

async function pair(opts: { fault?: string; delayMs?: number; turnTimeoutMs?: number; mockStateFile?: string; stateDirB?: string } = {}) {
  const env = trackEnv(await startRelay());
  const devA = await registerDevice(env);
  const devB = await registerDevice(env);
  const cwd = process.cwd();
  const a = trackBridge(
    await startBridge(env, {
      deviceToken: devA.device_token,
      bindings: [{ alias: 'alpha', role: 'manager', task: 'dispatch', project: 'codex-relay' }],
      cwd,
    }),
  );
  const b = trackBridge(
    await startBridge(env, {
      deviceToken: devB.device_token,
      bindings: [{ alias: 'beta', role: 'worker', task: 'execute', project: 'codex-relay' }],
      cwd,
      mockFault: opts.fault,
      mockDelayMs: opts.delayMs,
      turnTimeoutMs: opts.turnTimeoutMs,
      mockStateFile: opts.mockStateFile,
      stateDir: opts.stateDirB,
    }),
  );
  const bindA = a.bindings.get('alpha')!;
  const bindB = b.bindings.get('beta')!;
  // Open B to A (and A to B for the reverse direction).
  await updateAllowSources(env, devB.device_token, bindB.threadId!, 'beta', 'worker', [bindA.convId!]);
  await updateAllowSources(env, devA.device_token, bindA.threadId!, 'alpha', 'manager', [bindB.convId!]);
  return { env, devA, devB, a, b, bindA, bindB };
}

function turnTexts(thread: any): string[] {
  return (thread?.turns ?? []).flatMap((t: any) =>
    (t.items ?? []).filter((i: any) => typeof i.text === 'string').map((i: any) => i.text),
  );
}

describe('round trip A -> B -> A', () => {
  it('executes on B and pushes the result back into A original conversation', async () => {
    const { env, devA, a, b, bindA, bindB } = await pair();
    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'please verify the widget',
    });
    expect(sent.status).toBe(201);
    const id = sent.body.data.request_id;

    await waitFor(
      async () => ((await getRequest(env, devA.device_token, id)).exec_status === 'completed' ? true : undefined),
      20_000,
      'B completes the request',
    );

    // B ran exactly one turn and answered.
    const bThread = await b.bridge.codexClient.threadRead(bindB.threadId!, true);
    expect(bThread.turns.length).toBe(1);
    expect(turnTexts(bThread).some((t) => t.includes('please verify the widget'))).toBe(true);

    // A's original conversation received the result as a new turn.
    const aThread = await waitFor(async () => {
      const t = await a.bridge.codexClient.threadRead(bindA.threadId!, true);
      return turnTexts(t).some((x) => x.includes('relay-result:' + id)) ? t : undefined;
    }, 20_000, 'A receives the pushed result');
    expect(aThread.turns.length).toBe(1);
    const result = await getRequest(env, devA.device_token, id);
    expect(result.return_status).toBe('cloud_saved');
  });
});

describe('round trip B -> A -> B', () => {
  it('works in the reverse direction', async () => {
    const { env, devB, a, b, bindA, bindB } = await pair();
    const sent = await send(env, devB.device_token, {
      from_conv: bindB.convId!,
      to: bindA.convId!,
      type: 'QUERY',
      body: 'what is the current status?',
    });
    expect(sent.status).toBe(201);
    const id = sent.body.data.request_id;
    await waitFor(
      async () => ((await getRequest(env, devB.device_token, id)).exec_status === 'completed' ? true : undefined),
      20_000,
      'A completes the request',
    );
    const aThread = await a.bridge.codexClient.threadRead(bindA.threadId!, true);
    expect(aThread.turns.length).toBe(1);
    expect(turnTexts(aThread).some((t) => t.includes('what is the current status?'))).toBe(true);

    // B's original conversation receives the pushed result.
    const bThread = await waitFor(async () => {
      const t = await b.bridge.codexClient.threadRead(bindB.threadId!, true);
      return turnTexts(t).some((x) => x.includes('relay-result:' + id)) ? t : undefined;
    }, 20_000, 'B receives the pushed result');
    expect(bThread.turns.length).toBe(1);
  });
});

describe('§5.3 duplicate delivery', () => {
  it('never starts a second turn for the same request', async () => {
    const { env, devA, b, bindA, bindB } = await pair();
    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'once',
    });
    const id = sent.body.data.request_id;
    await waitFor(async () => ((await b.state.get(id)) ? true : undefined), 10_000, 'dispatch recorded');
    // Simulate a duplicated delivery of the same request.
    await b.bridge.processRequest(id);
    await b.bridge.processRequest(id);
    await sleep(500);
    const thread = await b.bridge.codexClient.threadRead(bindB.threadId!, true);
    expect(thread.turns.length).toBe(1);
    const rows = await b.state.db.query('SELECT * FROM dispatch WHERE request_id=$1', [id]);
    expect(rows.length).toBe(1);
    void env;
  });
});

describe('duplicate terminal notification', () => {
  it('is de-duplicated by the relay (one stored RESULT)', async () => {
    const { env, devA, bindA, bindB } = await pair({ fault: 'duplicate' });
    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'dup',
    });
    const id = sent.body.data.request_id;
    await waitFor(
      async () => ((await getRequest(env, devA.device_token, id)).exec_status === 'completed' ? true : undefined),
      20_000,
      'completes',
    );
    const res = await fetch(env.baseUrl + `/v1/requests/${id}/result`, {
      headers: { authorization: `Bearer ${devA.device_token}` },
    });
    const body: any = await res.json();
    expect(body.data.results.filter((r: any) => r.kind === 'RESULT').length).toBe(1);
  });
});

describe('§5.2 missing terminal state', () => {
  it('reports the result as missing instead of claiming completion', async () => {
    const { env, devA, bindA, bindB } = await pair({ fault: 'no_terminal', turnTimeoutMs: 1500 });
    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'never finishes',
    });
    const id = sent.body.data.request_id;
    const st = await waitFor(async () => {
      const r = await getRequest(env, devA.device_token, id);
      return r.exec_status === 'failed' ? r : undefined;
    }, 20_000, 'bridge reports failure');
    expect(st.result_missing).toBe(true);
  });
});

describe('§5.4 delivery is idempotent per item', () => {
  it('does not re-push the RESULT when a later STATUS arrives or the event repeats', async () => {
    const { env, devA, devB, a, bindA, bindB } = await pair();
    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'steady',
    });
    const id = sent.body.data.request_id;

    const originThread = async () => await a.bridge.codexClient.threadRead(bindA.threadId!, true);
    // Count *turns* (a mock turn holds both the user and the agent message, so
    // counting text items would double-count a single delivery).
    const turnsWith = async (needle: string) =>
      (await originThread()).turns.filter((x: any) =>
        (x.items ?? []).some((i: any) => typeof i.text === 'string' && i.text.includes(needle)),
      ).length;

    // The worker's RESULT is pushed into the origin conversation exactly once.
    await waitFor(async () => ((await turnsWith('RESULT for ' + id)) >= 1 ? true : undefined), 20_000, 'RESULT delivered');
    expect(await turnsWith('RESULT for ' + id)).toBe(1);
    expect(await turnsWith('relay-result:' + id)).toBe(1);

    // A later STATUS becomes a *new* notification, not a re-push of the RESULT.
    await submitResult(env, devB.device_token, id, {
      conv_id: bindB.convId,
      kind: 'STATUS',
      exec_status: 'running',
      body: 'still working',
    });
    await waitFor(async () => ((await turnsWith('STATUS for ' + id)) >= 1 ? true : undefined), 20_000, 'STATUS delivered');
    expect(await turnsWith('STATUS for ' + id)).toBe(1);
    expect(await turnsWith('RESULT for ' + id)).toBe(1); // unchanged: no RESULT re-push
    expect(await turnsWith('relay-result:' + id)).toBe(2); // RESULT + STATUS

    // Re-running delivery for the same item must not push again.
    await (a.bridge as any).deliverResultToConversation(id);
    await sleep(400);
    expect(await turnsWith('relay-result:' + id)).toBe(2);
  });
});

describe('§5.4 cancel while running', () => {
  it('interrupts the turn and records the real terminal state', async () => {
    const { env, devA, b, bindA, bindB } = await pair({ fault: 'delay', delayMs: 60_000 });
    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'long task',
    });
    const id = sent.body.data.request_id;
    await waitFor(async () => {
      const rec = await b.state.get(id);
      return rec && rec.status === 'running' ? rec : undefined;
    }, 10_000, 'turn running');

    const cancelRes = await fetch(env.baseUrl + `/v1/requests/${id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${devA.device_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from_conv: bindA.convId }),
    });
    expect(cancelRes.status).toBe(200);

    const st = await waitFor(async () => {
      const r = await getRequest(env, devA.device_token, id);
      return r.exec_status === 'interrupted' ? r : undefined;
    }, 20_000, 'interrupted');
    expect(st.turn_id).toBeTruthy();
  });
});
