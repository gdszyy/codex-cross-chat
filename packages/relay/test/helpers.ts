/**
 * Test helpers. All contract tests drive the *real* production entry chain:
 * createRelay() wires the real HTTP router and the real WebSocket hub, and the
 * tests talk to it over real HTTP/WS on an ephemeral port. No intermediate
 * product is injected.
 */
import { createRelay, type Relay } from '../src/server.js';
import { openPglite } from '../src/db.js';
import WebSocket from 'ws';

export const TEST_ROOT_KEY = 'test-root-key-local-only';

export interface TestRelay {
  relay: Relay;
  baseUrl: string;
  wsUrl: string;
  rootKey: string;
  close(): Promise<void>;
}

export async function startTestRelay(config: Record<string, number> = {}): Promise<TestRelay> {
  const db = await openPglite();
  const relay = await createRelay({ db, rootKey: TEST_ROOT_KEY, config, background: false });
  const port = await relay.listen(0);
  return {
    relay,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/v1/device`,
    rootKey: TEST_ROOT_KEY,
    async close() {
      await relay.close();
    },
  };
}

export interface ApiResult {
  status: number;
  body: any;
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  opts: { rootKey?: string; token?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.rootKey) headers['x-root-key'] = opts.rootKey;
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep text (CSV) */
  }
  return { status: res.status, body };
}

export async function registerDevice(t: TestRelay, ownerLabel = 'owner') {
  const r = await api(t.baseUrl, 'POST', '/v1/devices/register', {
    rootKey: t.rootKey,
    body: { owner_label: ownerLabel },
  });
  if (r.status !== 201) throw new Error('device register failed: ' + JSON.stringify(r));
  return r.body.data as { device_id: string; device_token: string };
}

export async function registerConv(
  t: TestRelay,
  token: string,
  input: { profile?: string; thread_id: string; alias: string; role: string; task?: string; project?: string; allow_sources?: string[] },
) {
  const r = await api(t.baseUrl, 'POST', '/v1/roster/register', {
    token,
    body: {
      profile: input.profile ?? 'default',
      thread_id: input.thread_id,
      alias: input.alias,
      role: input.role,
      task: input.task ?? 'do work',
      project: input.project ?? 'codex-relay',
      ...(input.allow_sources ? { allow_sources: input.allow_sources } : {}),
    },
  });
  if (r.status !== 201) throw new Error('roster register failed: ' + JSON.stringify(r));
  return r.body.data as any;
}

/** A minimal WS client that records received events. */
export class TestWs {
  private ws: WebSocket;
  events: any[] = [];
  ready: Promise<void>;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(`${url}?token=${token}`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
    this.ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        this.events.push(m);
      } catch {
        /* ignore */
      }
    });
  }

  send(obj: unknown) {
    this.ws.send(JSON.stringify(obj));
  }

  async waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.events.find(pred);
      if (found) return found;
      await sleep(20);
    }
    throw new Error('waitFor timed out; events=' + JSON.stringify(this.events));
  }

  close() {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
