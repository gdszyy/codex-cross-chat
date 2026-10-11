/**
 * Bridge test helpers: a real relay (in-process, real HTTP+WS) plus bridges
 * driving a *mock* Codex app-server process. Nothing is stubbed at the relay
 * boundary — the same HTTP/WS chain used in production is exercised.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// Relative cross-package import: the relay package is a sibling workspace
// package; this keeps the bridge tests driving the *real* relay chain.
import { createRelay, type Relay } from '../../relay/src/server.js';
import { openPglite } from '../../relay/src/db.js';
import { Bridge, type Binding } from '../src/bridge.js';
import { LocalState } from '../src/state.js';
import { openLocalPg } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_PATH = path.resolve(__dirname, '../../mock-codex/mock-app-server.mjs');

export const ROOT_KEY = 'bridge-test-root-key';

/**
 * fetch with a bounded retry on *network-level* failures only (socket refused /
 * reset under machine load). HTTP status codes are never retried, so assertion
 * semantics are unchanged.
 */
export async function rfetch(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr;
}

export interface TestEnv {
  relay: Relay;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startRelay(opts: {
  config?: Record<string, number>;
  pgDir?: string;
  background?: boolean;
} = {}): Promise<TestEnv> {
  if (opts.pgDir) await fs.promises.mkdir(opts.pgDir, { recursive: true });
  const db = await openPglite(opts.pgDir);
  const relay = await createRelay({
    db,
    rootKey: ROOT_KEY,
    config: opts.config,
    background: opts.background ?? false,
  });
  const port = await relay.listen(0);
  return {
    relay,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await relay.close();
    },
  };
}

export async function registerDevice(env: TestEnv, ownerLabel = 'owner') {
  const res = await rfetch(env.baseUrl + '/v1/devices/register', {
    method: 'POST',
    headers: { 'x-root-key': ROOT_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ owner_label: ownerLabel }),
  });
  const body: any = await res.json();
  return body.data as { device_id: string; device_token: string };
}

export interface BridgeHandle {
  bridge: Bridge;
  state: LocalState;
  bindings: Map<string, Binding>;
  stop(): Promise<void>;
}

export async function startBridge(
  env: TestEnv,
  input: {
    deviceToken: string;
    bindings: Binding[];
    allowSources?: string[];
    cwd: string;
    mockStateFile?: string;
    mockFault?: string;
    mockDelayMs?: number;
    turnTimeoutMs?: number;
    heartbeatMs?: number;
    stateDir?: string;
    /** Reuse an existing local state store (simulates an in-process restart). */
    state?: LocalState;
  },
): Promise<BridgeHandle> {
  if (input.stateDir && !input.state) await fs.promises.mkdir(input.stateDir, { recursive: true });
  const db = input.state ? null : await openLocalPg(input.stateDir);
  const state = input.state ?? new LocalState(db!);
  await state.init();
  const bridge = new Bridge({
    relayUrl: env.baseUrl,
    deviceToken: input.deviceToken,
    profile: 'default',
    codexCommand: process.execPath,
    codexArgs: [MOCK_PATH],
    codexEnv: {
      ...(input.mockStateFile ? { MOCK_STATE_FILE: input.mockStateFile } : {}),
      ...(input.mockFault ? { MOCK_FAULT: input.mockFault } : {}),
      ...(input.mockDelayMs !== undefined ? { MOCK_DELAY_MS: String(input.mockDelayMs) } : {}),
    },
    model: 'gpt-5.6-luna',
    cwd: input.cwd,
    bindings: input.bindings,
    allowSources: input.allowSources,
    turnTimeoutMs: input.turnTimeoutMs ?? 10_000,
    heartbeatMs: input.heartbeatMs ?? 30_000,
    onLog: () => {},
  });
  await bridge.start(state);
  const bindings = new Map<string, Binding>();
  for (const b of input.bindings) bindings.set(b.alias, b);
  return {
    bridge,
    state,
    bindings,
    async stop() {
      await bridge.stop();
      if (db) await db.close();
    },
  };
}

export async function rosterMe(env: TestEnv, token: string, threadId: string) {
  const res = await rfetch(
    env.baseUrl + `/v1/roster/me?profile=default&thread_id=${encodeURIComponent(threadId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body: any = await res.json();
  return body.data;
}

export async function updateAllowSources(env: TestEnv, token: string, threadId: string, alias: string, role: string, allowSources: string[]) {
  const res = await rfetch(env.baseUrl + '/v1/roster/register', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      profile: 'default',
      thread_id: threadId,
      alias,
      role,
      task: 't',
      project: 'codex-relay',
      allow_sources: allowSources,
    }),
  });
  const body: any = await res.json();
  if (res.status !== 201) throw new Error('update failed: ' + JSON.stringify(body));
  return body.data;
}

export async function send(env: TestEnv, token: string, body: any) {
  const res = await rfetch(env.baseUrl + '/v1/requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function getRequest(env: TestEnv, token: string, id: string) {
  const res = await rfetch(env.baseUrl + `/v1/requests/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body: any = await res.json();
  return body.data;
}

export async function submitResult(env: TestEnv, token: string, id: string, payload: any) {
  const res = await rfetch(env.baseUrl + `/v1/requests/${id}/result`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 15_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Open a bridge-local state store directly (used to seed crash-window rows). */
export async function openState(dir: string): Promise<{ state: LocalState; close(): Promise<void> }> {
  await fs.promises.mkdir(dir, { recursive: true });
  const db = await openLocalPg(dir);
  const state = new LocalState(db);
  await state.init();
  return { state, close: () => db.close() };
}
