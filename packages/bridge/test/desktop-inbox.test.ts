/** Local protocol fixtures; these do not prove desktop owner consumption. */
import { describe, expect, it, vi } from 'vitest';
import { CodexClient } from '../src/codexClient.js';
import { DesktopInbox } from '../src/desktopInbox.js';
import type { DesktopDeliveryState } from '../src/desktopDelivery.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configOptions } from '../src/config.js';
import { Bridge } from '../src/bridge.js';
import type { LocalState } from '../src/state.js';
const target = '11111111-1111-4111-8111-111111111111';
const marker = '[[relay-inbox:r-one]]';
const text = `${marker}\n\nreal request`;
class State implements DesktopDeliveryState {
  data = new Map<string, any>();
  async getDesktopDelivery(k: string) { return this.data.get(k) ?? null; }
  async saveDesktopDelivery(k: string, v: any) { this.data.set(k, structuredClone(v)); }
}
class Client extends CodexClient {
  calls: { method: string; params: any }[] = [];
  entries: any[] = [];
  history: any[] = [];
  addFault = false;
  malformed = false;
  deleted = true;
  onDelete?: () => void;
  constructor(public state: State) { super({ command: 'never-spawned', args: [] }); }
  override async rpc<T = any>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: target, ephemeral: false, historyMode: 'paginated' } } as T;
    if (method === 'thread/turns/list') {
      if (this.malformed) throw new Error('untrusted secret should not leak');
      const i = Number(params.cursor ?? 0);
      return { data: this.history.slice(i, i + 1), nextCursor: i + 1 < this.history.length ? String(i + 1) : null } as T;
    }
    if (method === 'thread/queue/list') return { data: this.entries, nextCursor: null } as T;
    if (method === 'thread/queue/add') {
      expect(this.state.data.has('inbox-intent:r-one')).toBe(true);
      expect(this.state.data.get('desktop-inbox:r-one')?.status).toBe('prepared');
      if (this.addFault) throw new Error('unknown result');
      const q = { id: 'queue-one', clientUserMessageId: params.clientUserMessageId, input: params.input };
      this.entries.push(q);
      return { queuedSubmission: q } as T;
    }
    if (method === 'thread/queue/delete') {
      this.onDelete?.();
      if (this.deleted) this.entries = [];
      return { deleted: this.deleted } as T;
    }
    throw new Error(`Forbidden fixture method ${method}`);
  }
  addTurn(clientId: string | null, input = text, id = 'turn-one') {
    this.history.push({ id, status: 'completed', itemsView: 'full', items: [
      { id: `${id}-u`, type: 'userMessage', clientId, content: [{ type: 'text', text: input }] },
      { id: `${id}-a`, type: 'agentMessage', text: 'actual owner answer' },
    ] });
  }
}
function setup() {
  const state = new State(), client = new Client(state);
  const inbox = new DesktopInbox(client, state);
  const input = { requestId: 'r-one', convId: 'c-original', identityThreadId: 'old-registered-thread', targetThreadId: target, text };
  return { state, client, inbox, input };
}
describe('desktop inbox durable acceptance and exact execution correlation', () => {
  it('verifies only public read APIs, saves intent before adding, and never starts a writer', async () => {
    const { client, inbox, input } = setup();
    await inbox.verifyTarget(target);
    const r = await inbox.enqueue(input);
    expect(r.status).toBe('queued');
    expect(await inbox.observe(r)).toBeNull();
    expect(client.calls.every((x) => ['thread/read', 'thread/turns/list', 'thread/queue/list', 'thread/queue/add'].includes(x.method))).toBe(true);
    expect(client.calls.filter((x) => x.method === 'thread/queue/add')).toHaveLength(1);
  });
  it.each([true, false])('correlates full history across pages with client ID present=%j', async (present) => {
    const { client, inbox, input } = setup();
    const r = await inbox.enqueue(input);
    client.addTurn('unrelated', 'other request', 'older-turn');
    client.addTurn(present ? r.clientId : null);
    expect((await inbox.observe(r))?.id).toBe('turn-one');
    expect(client.calls.filter((x) => x.method === 'thread/turns/list').some((x) => x.params.cursor === '1')).toBe(true);
  });
  it.each(['changed-body', 'foreign-client', 'duplicate'])('refuses ambiguous or conflicting correlation: %s', async (fault) => {
    const { client, inbox, input } = setup();
    const r = await inbox.enqueue(input);
    client.addTurn(fault === 'foreign-client' ? 'wrong-client' : r.clientId, fault === 'changed-body' ? text + 'changed' : text);
    if (fault === 'duplicate') client.addTurn(r.clientId, text, 'second-turn');
    await expect(inbox.observe(r)).rejects.toThrow();
  });
  it('does not re-add after an uncertain result and restart with neither queue nor history evidence', async () => {
    const { state, client, inbox, input } = setup();
    client.addFault = true;
    await inbox.enqueue(input);
    expect((await inbox.get('r-one'))?.status).toBe('uncertain');
    const restarted = new DesktopInbox(client, state);
    await expect(restarted.enqueue(input)).rejects.toThrow('no second queue add');
    expect(await restarted.observe((await restarted.get('r-one'))!)).toBeNull();
    expect(client.calls.filter((x) => x.method === 'thread/queue/add')).toHaveLength(1);
  });
  it.each(['human steering', '[[relay-inbox:r-other]]'])('refuses a merged owner turn with another user message: %s', async (other) => {
    const { client, inbox, input } = setup(); const r = await inbox.enqueue(input);
    client.addTurn(r.clientId);
    client.history[0].items.push({ id: 'steering', type: 'userMessage', clientId: null, content: [{ type: 'text', text: other }] });
    await expect(inbox.observe(r)).rejects.toThrow('multiple user messages');
  });
  it('keeps prepared intent after a crash before add; absence never permits a new add', async () => {
    const { inbox, input, client } = setup();
    const r = await inbox.enqueue(input);
    r.status = 'prepared'; await inbox.save(r); client.entries = [];
    await expect(inbox.enqueue(input)).rejects.toThrow('no second queue add');
  });
  it('refuses target/identity drift and malformed history without leaking raw RPC errors', async () => {
    const { inbox, input, client } = setup();
    const r = await inbox.enqueue(input);
    expect(() => inbox.assertBinding(r, input.convId, 'different-identity', target)).toThrow('binding changed');
    client.malformed = true;
    await expect(inbox.observe(r)).rejects.toThrow('complete history is unavailable');
    await expect(inbox.verifyTarget(target)).rejects.toThrow('target/history is unavailable');
  });
  it('deletes only its own exact queued item before confirming cancellation', async () => {
    const { client, inbox, input } = setup();
    const r = await inbox.enqueue(input);
    expect(await inbox.cancel(r)).toBe(true);
    expect((await inbox.get('r-one'))?.status).toBe('cancelled');
    expect(client.calls.find((x) => x.method === 'thread/queue/delete')?.params).toEqual({ threadId: target, queuedSubmissionId: 'queue-one' });
  });
  it.each(['consumed', 'delete-lost-race', 'observed-after-delete'])('does not claim interruption after %s', async (fault) => {
    const { client, inbox, input } = setup();
    const r = await inbox.enqueue(input);
    if (fault === 'consumed') { client.entries = []; client.addTurn(r.clientId); }
    if (fault === 'delete-lost-race') client.deleted = false;
    if (fault === 'observed-after-delete') client.onDelete = () => client.addTurn(r.clientId);
    expect(await inbox.cancel(r)).toBe(false);
    expect((await inbox.get('r-one'))?.status).toBe('cancel_pending');
    expect(client.calls.some((x) => x.method === 'turn/interrupt')).toBe(false);
  });
});
describe('desktop inbox configuration boundary', () => {
  it.each(['missing-header', 'bad-health'])('requires public server capability before any claim/grant/queue: %s', async (fault) => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ ok: fault !== 'bad-health' }), {
      headers: fault === 'missing-header' ? {} : { 'x-relay-desktop-inbox': '1' } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const bridge = new Bridge({ relayUrl: 'https://relay.example.com', deviceToken: 'test-only-token', profile: 'default',
        executionMode: 'desktop_inbox', codexCommand: 'never-run', codexArgs: [], model: 'unused', cwd: '/fixture',
        bindings: [{ alias: 'B', role: 'worker', task: 't', project: 'p', threadId: 'old-identity', convId: 'c-B', desktopThreadId: target }] });
      await expect(bridge.start({} as LocalState)).rejects.toThrow('capability is unavailable');
      expect(fetcher.mock.calls).toHaveLength(1);
      expect(fetcher.mock.calls[0][0]).toBe('https://relay.example.com/health');
      expect(bridge.codexClient).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['missing-target', 'missing-identity', 'receiver', 'legacy-result-mode', 'duplicate-target', 'unknown-mode', 'pairing-without-target'])('rejects %s without opening an App Server', (fault) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-inbox-config-'));
    try {
      const raw: any = { relay_url: 'https://relay.example.com', device_token: 'test-only-token', execution_mode: 'desktop_inbox',
        bindings: [{ alias: 'B', role: 'worker', task: 't', project: 'p', convId: 'c-B', threadId: 'old-identity', desktopThreadId: target }] };
      if (fault === 'missing-target') delete raw.bindings[0].desktopThreadId;
      if (fault === 'missing-identity') delete raw.bindings[0].threadId;
      if (fault === 'receiver') raw.bindings[0].nativeReceiverThreadId = target;
      if (fault === 'legacy-result-mode') raw.result_delivery_mode = 'native_task';
      if (fault === 'duplicate-target') raw.bindings.push({ ...raw.bindings[0], alias: 'C', convId: 'c-C', threadId: 'other-identity' });
      if (fault === 'unknown-mode') raw.execution_mode = 'invented';
      if (fault === 'pairing-without-target') { raw.bindings = []; raw.pairing = { alias: 'B' }; }
      const cfg = path.join(dir, 'bridge.json'); fs.writeFileSync(cfg, JSON.stringify(raw));
      expect(() => configOptions(cfg)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
