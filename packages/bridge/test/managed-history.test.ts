/** Protocol fixtures test fail-closed assembly, not real App Server availability. */
import { describe, expect, it, vi } from 'vitest';
import { CodexClient } from '../src/codexClient.js';
import { Bridge, type BridgeOptions } from '../src/bridge.js';

const id = 'bound-execution-thread';
const meta = (historyMode = 'paginated') => ({ id, historyMode, ephemeral: false, canAcceptDirectInput: true });
const turn = (n: number, status = 'completed', text = `answer-${n}`) => ({ id: `turn-${n}`, status, itemsView: 'full',
  items: [{ id: `user-${n}`, type: 'userMessage', content: [{ type: 'text', text: `request-${n}` }] },
    { id: `agent-${n}`, type: 'agentMessage', text }] });

class FixtureClient extends CodexClient {
  calls: { method: string; params: any }[] = [];
  constructor(public handle: (method: string, params: any) => any) {
    super({ command: 'unused-fixture', args: [], experimentalApi: true });
  }
  override async rpc<T = any>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    return this.handle(method, params);
  }
}
const paginated = (page: (params: any) => any = () => ({ data: [turn(1)], nextCursor: null })) =>
  new FixtureClient((method, params) => {
    if (method === 'thread/read' || method === 'thread/resume') return { thread: meta() };
    if (method === 'thread/turns/list') return page(params);
    throw new Error('Unexpected fixture RPC');
  });

describe('managed history execution boundary', () => {
  it('keeps raw desktop reads separate and refuses managed reads before explicit attachment', async () => {
    const client = paginated();
    expect((await client.threadRead(id, false)).historyMode).toBe('paginated');
    await expect(client.managedThreadRead(id)).rejects.toThrow('explicitly attached');
    expect(client.calls.map((c) => c.method)).toEqual(['thread/read']);
  });

  it.each([
    { ...meta(), id: 'wrong-thread' }, { ...meta(), ephemeral: true },
    { id, historyMode: 'legacy' }, { ...meta(), historyMode: 'unknown' },
    { ...meta(), canAcceptDirectInput: false },
  ])('refuses incompatible metadata before resume: %j', async (metadata) => {
    const client = new FixtureClient(() => ({ thread: metadata }));
    await expect(client.threadResume(id)).rejects.toThrow('recovery rejected');
    expect(client.calls.map((c) => c.method)).toEqual(['thread/read']);
    await expect(client.managedThreadRead(id)).rejects.toThrow('explicitly attached');
  });

  it.each([false, null, undefined, 'true'])('requires explicit direct-input permission from resume: %j', async (capability) => {
    const client = new FixtureClient((method) => ({ thread: method === 'thread/resume'
      ? { ...meta(), canAcceptDirectInput: capability } : meta() }));
    await expect(client.threadResume(id)).rejects.toThrow('recovery rejected');
    await expect(client.managedThreadRead(id)).rejects.toThrow('explicitly attached');
  });

  it('revokes prior attachment when a later resume pre-read fails', async () => {
    const client = paginated();
    await client.threadResume(id);
    client.handle = () => { throw new Error('Metadata unavailable'); };
    await expect(client.threadResume(id)).rejects.toThrow('Metadata unavailable');
    await expect(client.managedThreadRead(id)).rejects.toThrow('explicitly attached');
  });

  it('preserves legacy full-history behavior and the original ID', async () => {
    const legacyTurn = { ...turn(1), itemsView: undefined };
    const client = new FixtureClient((method, params) => ({ thread: { ...meta('legacy'),
      ...(method === 'thread/read' && params.includeTurns ? { turns: [legacyTurn] } : {}) } }));
    const history = await client.threadResume(id);
    expect(history).toMatchObject({ id, ephemeral: false, historyMode: 'legacy', historyComplete: true, turns: [legacyTurn] });
    expect(client.calls.find((c) => c.method === 'thread/resume')?.params).toEqual({ threadId: id });
  });

  it('rejects duplicate IDs on legacy text-only user messages', async () => {
    const t = { ...turn(1), items: [{ id: 'same', type: 'userMessage', text: 'first' },
      { id: 'same', type: 'userMessage', text: 'second' }] };
    const client = new FixtureClient(() => ({ thread: { ...meta('legacy'), turns: [t] } }));
    await expect(client.threadResume(id)).rejects.toThrow('duplicate');
  });

  it('supports freshly created managed threads after naming without starting a turn', async () => {
    const client = new FixtureClient((method) => {
      if (method === 'thread/name/set') return {};
      return { thread: { ...meta('legacy'), turns: [] } };
    });
    expect(await client.threadStart('fixture-model', '/fixture')).toBe(id);
    expect(client.calls.some((c) => c.method === 'turn/start')).toBe(false);
    expect(client.calls.find((c) => c.method === 'thread/name/set')?.params.threadId).toBe(id);
  });
});

describe('paginated full-history assembly', () => {
  it('reads all ascending pages and ignores incomplete turns carried in metadata', async () => {
    const client = paginated((params) => params.cursor ? { data: [turn(2)], nextCursor: null }
      : { data: [turn(1)], nextCursor: 'page-2' });
    const history = await client.threadResume(id);
    expect(history.historyMode).toBe('paginated');
    expect(history.historyComplete).toBe(true);
    expect(history.turns.map((t: any) => t.id)).toEqual(['turn-1', 'turn-2']);
    expect(client.calls.find((c) => c.method === 'thread/resume')?.params).toEqual({ threadId: id, excludeTurns: true });
    expect(client.calls.filter((c) => c.method === 'thread/turns/list').map((c) => c.params)).toEqual([
      { threadId: id, itemsView: 'full', sortDirection: 'asc', limit: 100 },
      { threadId: id, itemsView: 'full', sortDirection: 'asc', limit: 100, cursor: 'page-2' },
    ]);
  });

  it('only accepts an empty history after a successful complete pagination response', async () => {
    expect((await paginated(() => ({ data: [], nextCursor: null })).threadResume(id)).turns).toEqual([]);
  });

  it('accepts schema-default full when the response omits itemsView', async () => {
    const full = { ...turn(1), itemsView: undefined };
    expect((await paginated(() => ({ data: [full], nextCursor: null })).threadResume(id)).turns).toEqual([full]);
  });

  it.each([
    { data: [turn(1)], nextCursor: 12 },
    { data: [], nextCursor: '' },
    { nextCursor: null },
    { data: [{ ...turn(1), status: 'unknown' }], nextCursor: null },
    { data: [{ ...turn(1), itemsView: 'summary' }], nextCursor: null },
    { data: [{ ...turn(1), itemsView: 'notLoaded', items: [] }], nextCursor: null },
    { data: [{ ...turn(1), items: [{ type: 'agentMessage', text: 'no identity' }] }], nextCursor: null },
    { data: [{ ...turn(1), items: [{ id: 'a', type: 'agentMessage' }] }], nextCursor: null },
    { data: [{ ...turn(1), items: [{ id: 'u', type: 'userMessage', text: 'legacy-only' }] }], nextCursor: null },
    { data: [{ ...turn(1), items: [{ id: 'u', type: 'userMessage', content: [null] }] }], nextCursor: null },
    { data: [{ ...turn(1), items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 42 }] }] }], nextCursor: null },
  ])('rejects malformed or incomplete pages: %j', async (page) => {
    const client = paginated(() => page);
    await expect(client.threadResume(id)).rejects.toThrow();
    await expect(client.managedThreadRead(id)).rejects.toThrow('explicitly attached');
    expect(client.calls.some((c) => ['thread/start', 'thread/fork', 'turn/start'].includes(c.method))).toBe(false);
  });

  it('rejects cyclic cursors and repeated turn identities', async () => {
    await expect(paginated(() => ({ data: [], nextCursor: 'loop' })).threadResume(id)).rejects.toThrow('did not advance');
    let page = 0;
    await expect(paginated(() => ({ data: [turn(++page)], nextCursor: 'loop' })).threadResume(id)).rejects.toThrow('did not advance');
    expect(page).toBe(2);
    await expect(paginated(() => ({ data: [turn(1)], nextCursor: 'next' })).threadResume(id)).rejects.toThrow('duplicate');
  });

  it('caps nonterminating unique pages instead of hanging on fresh cursors', async () => {
    let page = 0;
    const client = paginated(() => ({ data: [turn(++page)], nextCursor: `cursor-${page}` }));
    await expect(client.threadResume(id)).rejects.toThrow('page limit');
    expect(page).toBe(1000);
  });

  it('does not return partial history when a later page fails', async () => {
    const client = paginated((params) => {
      if (params.cursor) throw new Error('Later page unavailable');
      return { data: [turn(1)], nextCursor: 'page-2' };
    });
    await expect(client.threadResume(id)).rejects.toThrow('Later page unavailable');
    await expect(client.managedThreadRead(id)).rejects.toThrow('explicitly attached');
  });
});

const opts: BridgeOptions = { relayUrl: 'http://localhost', deviceToken: 'fixture', profile: 'fixture',
  codexCommand: 'unused-fixture', codexArgs: [], model: 'fixture', cwd: '/fixture', bindings: [], turnTimeoutMs: 100 };
function bridgeWith(client: FixtureClient) {
  const bridge = new Bridge(opts) as any;
  bridge.codex = client;
  bridge.byConv.set('c-local', { threadId: id });
  bridge.state = { listUnfinished: async () => [{ request_id: 'r-old', to_conv: 'c-local', marker: 'relay:r-old' }],
    finish: vi.fn(), recordTurn: vi.fn() };
  bridge.processRequest = vi.fn();
  return bridge;
}

describe('Bridge consumes only complete managed history', () => {
  it('finds a persisted marker in real userMessage.content without replaying the old request', async () => {
    const item = turn(1, 'inProgress');
    item.items[0].content = [{ type: 'text', text: '[[relay:r-old]] received request' }];
    const client = paginated(() => ({ data: [item], nextCursor: null }));
    await client.threadResume(id);
    const bridge = bridgeWith(client);
    expect(await bridge.reconcile()).toMatchObject({ pending: 1, restarted: 0 });
    expect(bridge.state.recordTurn).toHaveBeenCalledWith('r-old', 'turn-1');
    expect(bridge.processRequest).not.toHaveBeenCalled();
  });

  it('leaves unreadable history pending instead of interpreting it as no marker', async () => {
    const client = paginated();
    await client.threadResume(id);
    client.handle = () => { throw new Error('History unavailable'); };
    const bridge = bridgeWith(client);
    expect(await bridge.reconcile()).toMatchObject({ pending: 1, restarted: 0 });
    expect(bridge.state.finish).toHaveBeenCalledWith('r-old', 'result_pending_verify');
    expect(bridge.processRequest).not.toHaveBeenCalled();
  });

  it.each([true, false])('marks a recovered terminal turn without agent text as result_missing (known turn=%j)', async (known) => {
    const item = turn(1);
    item.items = [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'relay:r-old' }] }];
    const client = paginated(() => ({ data: [item], nextCursor: null }));
    await client.threadResume(id);
    const bridge = bridgeWith(client);
    bridge.state.listUnfinished = async () => [{ request_id: 'r-old', to_conv: 'c-local', marker: 'relay:r-old',
      ...(known ? { turn_id: 'turn-1' } : {}) }];
    bridge.submitWithOutbox = vi.fn();
    expect(await bridge.reconcile()).toMatchObject({ adopted: 1, restarted: 0 });
    expect(bridge.submitWithOutbox).toHaveBeenCalledWith('r-old', expect.objectContaining({ result_missing: true }));
    expect(bridge.processRequest).not.toHaveBeenCalled();
  });

  it('reloads complete persisted items instead of settling from a terminal notification stub', async () => {
    let release!: () => void;
    const client = paginated();
    await client.threadResume(id);
    const gate = new Promise<void>((resolve) => { release = resolve; });
    client.handle = async (method) => method === 'thread/turns/list'
      ? (await gate, { data: [turn(1, 'completed', 'persisted full answer')], nextCursor: null })
      : { thread: meta() };
    const bridge = bridgeWith(client);
    let settled = false;
    const terminal = bridge.waitForTurn('turn-1', id).then((t: any) => { settled = true; return t; });
    bridge.onNotification({ method: 'turn/completed', params: { threadId: id,
      turn: { id: 'turn-1', status: 'completed', itemsView: 'notLoaded', items: [] } } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    expect(await terminal).toMatchObject({ status: 'completed', text: 'persisted full answer' });
  });
});
