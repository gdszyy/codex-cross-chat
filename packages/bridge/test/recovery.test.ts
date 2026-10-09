/**
 * Bridge recovery & resilience tests (§5.3 crash window, outbox replay).
 *
 * Deliberately in their own file: they create extra embedded-Postgres resources
 * and are kept in a fresh process so a loaded machine cannot slow them into a
 * timeout (see packages/bridge/scripts/run-tests.mjs).
 */
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  getRequest,
  openState,
  registerDevice,
  send,
  sleep,
  startBridge,
  startRelay,
  updateAllowSources,
  waitFor,
  type BridgeHandle,
  type TestEnv,
} from './helpers.js';

const TMP = path.resolve(process.cwd(), '.tmp', 'bridge-recovery');

const cleanups: (() => Promise<void>)[] = [];
const bridges: BridgeHandle[] = [];

afterEach(async () => {
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

describe('§5.3 crash window', () => {
  it('does not start a second turn after a bridge restart mid-turn', async () => {
    const stateDir = path.join(TMP, 'crash-' + Date.now());
    const mockState = path.join(stateDir, 'mock.json');
    const env = trackEnv(await startRelay());
    const devA = await registerDevice(env);
    const devB = await registerDevice(env);
    const a = trackBridge(
      await startBridge(env, {
        deviceToken: devA.device_token,
        bindings: [{ alias: 'alpha', role: 'manager', task: 'dispatch', project: 'codex-relay' }],
        cwd: process.cwd(),
      }),
    );
    // One shared local state store, handed to a second bridge later — exactly
    // what a process restart sees when it reopens its state database.
    const shared = await openState(stateDir);
    cleanups.push(() => shared.close());
    const b = trackBridge(
      await startBridge(env, {
        deviceToken: devB.device_token,
        bindings: [{ alias: 'beta', role: 'worker', task: 'execute', project: 'codex-relay' }],
        cwd: process.cwd(),
        state: shared.state,
        mockFault: 'delay',
        mockDelayMs: 60_000,
        mockStateFile: mockState,
      }),
    );
    const bindA = a.bindings.get('alpha')!;
    const bindB = b.bindings.get('beta')!;
    await updateAllowSources(env, devB.device_token, bindB.threadId!, 'beta', 'worker', [bindA.convId!]);

    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'crash me',
    });
    const id = sent.body.data.request_id;
    const running = await waitFor(async () => {
      const rec = await b.state.get(id);
      return rec && rec.turn_id ? rec : undefined;
    }, 15_000, 'turn recorded');
    const turnId = running.turn_id!;

    // The bridge "dies": stop it (the mock keeps the in-progress turn on disk).
    await b.stop();

    const b2 = trackBridge(
      await startBridge(env, {
        deviceToken: devB.device_token, // same device ⇒ same conv_id
        bindings: [{ alias: 'beta', role: 'worker', task: 'execute', project: 'codex-relay' }],
        cwd: process.cwd(),
        state: shared.state,
        mockStateFile: mockState,
      }),
    );
    const rec = await b2.state.get(id);
    expect(rec).toBeTruthy();
    const thread = await b2.bridge.codexClient.threadRead(rec!.thread_id, true);
    const matching = (thread.turns ?? []).filter((t: any) =>
      (t.items ?? []).some((i: any) => typeof i.text === 'string' && i.text.includes('relay:' + id)),
    );
    // Exactly one turn exists for this request — no duplicate execution.
    expect(matching.length).toBe(1);
    expect(matching[0].id).toBe(turnId);
    // Indeterminate terminal ⇒ parked for verification, not silently "completed".
    expect(rec!.status).toBe('result_pending_verify');
  });

  it('restarts safely when the turn was never started', async () => {
    const stateDir = path.join(TMP, 'restart-' + Date.now());
    const mockState = path.join(stateDir, 'mock.json');
    const env = trackEnv(await startRelay());
    const devA = await registerDevice(env);
    const devB = await registerDevice(env);
    const shared = await openState(stateDir);
    cleanups.push(() => shared.close());
    const b0 = trackBridge(
      await startBridge(env, {
        deviceToken: devB.device_token,
        bindings: [{ alias: 'beta', role: 'worker', task: 'execute', project: 'codex-relay' }],
        cwd: process.cwd(),
        state: shared.state,
        mockStateFile: mockState,
      }),
    );
    const bindB = b0.bindings.get('beta')!;
    const a = trackBridge(
      await startBridge(env, {
        deviceToken: devA.device_token,
        bindings: [{ alias: 'alpha', role: 'manager', task: 'dispatch', project: 'codex-relay' }],
        cwd: process.cwd(),
      }),
    );
    const bindA = a.bindings.get('alpha')!;
    await updateAllowSources(env, devB.device_token, bindB.threadId!, 'beta', 'worker', [bindA.convId!]);
    await b0.stop(); // B offline

    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'never started',
    });
    const id = sent.body.data.request_id;

    // Seed the crash-after-intent window: an intent row with no turnId.
    await shared.state.intent(id, id, bindB.convId!, bindB.threadId!, `relay:${id}`);

    const b2 = trackBridge(
      await startBridge(env, {
        deviceToken: devB.device_token,
        bindings: [{ alias: 'beta', role: 'worker', task: 'execute', project: 'codex-relay' }],
        cwd: process.cwd(),
        state: shared.state,
        mockStateFile: mockState,
      }),
    );
    const st = await waitFor(async () => {
      const r = await getRequest(env, devA.device_token, id);
      return r.exec_status === 'completed' ? r : undefined;
    }, 25_000, 'restarted and completed');
    expect(st.turn_id).toBeTruthy();
    const rec = await b2.state.get(id);
    expect(rec!.status).toBe('completed');
  });
});

describe('outbox replay', () => {
  it('queues a result when the report fails, then flushes it', async () => {
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
      }),
    );
    const bindA = a.bindings.get('alpha')!;
    const bindB = b.bindings.get('beta')!;
    await updateAllowSources(env, devB.device_token, bindB.threadId!, 'beta', 'worker', [bindA.convId!]);

    // Fault-inject the outbound report call before the request arrives, so the
    // *real* dispatch pipeline runs and its report lands in the outbox.
    const client = b.bridge.relayClient as any;
    const realSubmit = client.submitResult.bind(client);
    client.submitResult = async () => {
      throw new Error('relay unreachable (injected)');
    };

    const sent = await send(env, devA.device_token, {
      from_conv: bindA.convId!,
      to: bindB.convId!,
      type: 'TASK',
      body: 'offset',
    });
    const id = sent.body.data.request_id;

    const queued = await waitFor(
      async () => {
        const q = await b.state.pendingOutbox();
        return q.length ? q : undefined;
      },
      20_000,
      'result queued in the outbox',
    );
    expect(queued[0].request_id).toBe(id);

    // Relay "returns": the queued result flushes through the real path.
    client.submitResult = realSubmit;
    const flushed = await b.bridge.flushOutbox();
    expect(flushed).toBe(1);
    const st = await waitFor(async () => {
      const r = await getRequest(env, devA.device_token, id);
      return r.exec_status === 'completed' ? r : undefined;
    }, 10_000, 'result delivered after flush');
    expect(st.return_status).toBe('cloud_saved');
  });
});
