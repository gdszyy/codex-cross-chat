/** Real localhost Relay/SQL + mock desktop owner; never production/Codex models. */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bridge, type Binding, type BridgeOptions } from '../src/bridge.js';
import { RelayClient } from '../src/relayClient.js';
import { configOptions, readConfig, secureAtomicJson } from '../src/config.js';
import { MOCK_PATH, openState, registerDevice, startRelay, waitFor } from './helpers.js';
const target = '11111111-1111-4111-8111-111111111111';
const forbidden = ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt', 'thread/queue/start', 'thread/name/set', 'model/list'];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-inbox-test-'));
  cleanups.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
  const env = await startRelay(); cleanups.push(() => env.close());
  const aDevice = await registerDevice(env);
  const a = new RelayClient({ baseUrl: env.baseUrl, deviceToken: aDevice.device_token });
  const aRow = await a.registerRoster({ profile: 'default', thread_id: 'a-original', alias: 'A', role: 'manager',
    task: 'test', project: 'inbox-test', tier: 't1_managed' });
  const seed = path.join(dir, 'codex.json'), log = path.join(dir, 'rpc.jsonl');
  fs.writeFileSync(seed, JSON.stringify({ threads: [{ id: target, historyMode: 'paginated', model: 'desktop-owner-model', turns: [] }], turns: [] }));
  const local = await openState(path.join(dir, 'state')); cleanups.push(() => local.close());
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).method) : [];
  const options = (extras: Partial<BridgeOptions> = {}, consume = false): BridgeOptions => ({
    relayUrl: env.baseUrl, profile: 'default', model: 'must-not-override-owner', cwd: dir, bindings: [], executionMode: 'desktop_inbox',
    codexCommand: process.execPath, codexArgs: [MOCK_PATH], codexEnv: { MOCK_STATE_FILE: seed, MOCK_RPC_LOG_FILE: log,
      MOCK_FORBID_METHODS: forbidden.join(','), MOCK_QUEUE_OWNER: consume ? 'consume' : '', MOCK_PAGE_SIZE: '1' }, ...extras });
  return { dir, env, a, aRow, seed, local, calls, options };
}
async function migrated(ctx: Awaited<ReturnType<typeof setup>>, consume = false, delayMs?: number) {
  const dev = await registerDevice(ctx.env);
  const b = new RelayClient({ baseUrl: ctx.env.baseUrl, deviceToken: dev.device_token });
  const invite = await ctx.a.invite(ctx.aRow.conv_id);
  const redeemed = await b.redeem({ code: invite.code, profile: 'default', thread_id: 'old-registered-executor',
    alias: 'B', role: 'worker', task: 'original desktop' });
  const row = redeemed.conversation;
  const binding: Binding = { alias: 'B', role: 'worker', task: 'original desktop', project: row.project,
    threadId: row.thread_id, convId: row.conv_id, desktopThreadId: target };
  await ctx.local.state.saveBinding('B', 'default', binding.threadId!, binding.convId);
  const opts = ctx.options({ deviceToken: dev.device_token, bindings: [binding] }, consume);
  if (delayMs !== undefined) opts.codexEnv!.MOCK_DELAY_MS = String(delayMs);
  const bridge = new Bridge(opts); cleanups.push(() => bridge.stop());
  await bridge.start(ctx.local.state);
  await waitFor(async () => bridge.relayClient.isConnected);
  return { b, binding, opts, bridge, dev, pairing: redeemed.pairing_id };
}
describe('desktop_inbox existing and new device lifecycle', () => {
  it.each(['waiting_user', 'completed', 'failed'])('continues from same-turn STATUS %s and returns only the later actual desktop answer', async (status) => {
    const ctx = await setup(); const m = await migrated(ctx, true, 1500);
    const realStart = m.bridge.relayClient.start.bind(m.bridge.relayClient);
    let injected = false;
    m.bridge.relayClient.start = async (id, turnId) => {
      const row = await realStart(id, turnId);
      if (!injected) {
        injected = true;
        await m.b.submitResult(id, { conv_id: m.binding.convId, kind: 'STATUS', exec_status: status, body: 'fixture phase report' });
        return realStart(id, turnId);
      }
      return row;
    };
    const request = await ctx.a.sendRequest({ from_conv: ctx.aRow.conv_id, to: m.binding.convId, type: 'TASK', body: 'phase then answer' });
    await m.bridge.processRequest(request.request_id);
    await waitFor(async () => injected);
    const phase = await ctx.a.readResult(request.request_id);
    expect(phase.request.exec_status).toBe(status);
    expect(phase.results.filter((r: any) => r.kind === 'RESULT')).toHaveLength(0);
    const completed = await waitFor(async () => {
      const snapshot = await ctx.a.readResult(request.request_id);
      return snapshot.results.some((r: any) => r.kind === 'RESULT' && r.is_first) ? snapshot : null;
    });
    const result = completed.results.find((r: any) => r.kind === 'RESULT' && r.is_first);
    expect(result).toMatchObject({ body: 'MOCK DESKTOP OWNER REPLY', exec_status: 'completed',
      evidence: `codex-thread:${target}#turn:${completed.request.turn_id}` });
    expect((await ctx.local.state.get(request.request_id))?.status).toBe('completed');
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(1);
    expect(ctx.calls().filter((x) => forbidden.includes(x))).toEqual([]);
  });
  it.each([true, false])('finishes only an existing canonical RESULT matching the real desktop evidence=%j', async (matching) => {
    const ctx = await setup(); const m = await migrated(ctx, true, 700);
    const realStart = m.bridge.relayClient.start.bind(m.bridge.relayClient);
    let injected = false;
    m.bridge.relayClient.start = async (id, turnId) => {
      const row = await realStart(id, turnId);
      if (!injected) {
        injected = true;
        await m.b.submitResult(id, { conv_id: m.binding.convId, kind: 'RESULT', exec_status: 'completed',
          body: 'MOCK DESKTOP OWNER REPLY', turn_id: turnId,
          evidence: matching ? `codex-thread:${target}#turn:${turnId}` : 'codex-thread:wrong-target#turn:wrong-turn' });
        if (!matching) await m.b.submitResult(id, { conv_id: m.binding.convId, kind: 'STATUS',
          exec_status: 'waiting_user', body: 'later status must not hide a conflicting canonical result' });
        return realStart(id, turnId);
      }
      return row;
    };
    const request = await ctx.a.sendRequest({ from_conv: ctx.aRow.conv_id, to: m.binding.convId, type: 'TASK', body: 'reconcile existing report' });
    await m.bridge.processRequest(request.request_id);
    await waitFor(async () => (await ctx.local.state.get(request.request_id))?.status === 'result_pending_verify');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await m.bridge.processRequest(request.request_id);
    expect((await ctx.local.state.get(request.request_id))?.status).toBe(matching ? 'completed' : 'result_pending_verify');
    expect((await ctx.a.readResult(request.request_id)).results.filter((r: any) => r.kind === 'RESULT')).toHaveLength(1);
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(1);
  });
  it('retains old identity, executes only in the original desktop, and displays outbound reports once without a receiver', async () => {
    const ctx = await setup(); const m = await migrated(ctx, true);
    const request = await ctx.a.sendRequest({ from_conv: ctx.aRow.conv_id, to: m.binding.convId, type: 'QUERY', body: 'incoming request' });
    await m.bridge.processRequest(request.request_id);
    const snapshot = await waitFor(async () => {
      const r = await ctx.a.readResult(request.request_id);
      return r.results.length ? r : null;
    });
    expect(snapshot.results[0].body).toBe('MOCK DESKTOP OWNER REPLY');
    expect(snapshot.results[0].evidence).toContain(`codex-thread:${target}#turn:`);
    expect((await m.b.me({ conv_id: m.binding.convId! })).thread_id).toBe('old-registered-executor');
    expect((await ctx.local.state.getBinding('B')).thread_id).toBe('old-registered-executor');
    expect((await ctx.a.pairings(ctx.aRow.conv_id))[0].pairing_id).toBe(m.pairing);
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(1); // no self-report echo
    const outgoing = await m.b.sendRequest({ from_conv: m.binding.convId, to: ctx.aRow.conv_id, type: 'QUERY', body: 'outgoing fixture request' });
    const report = await ctx.a.submitResult(outgoing.request_id, { conv_id: ctx.aRow.conv_id, kind: 'RESULT',
      exec_status: 'completed', body: 'remote fixture report' });
    await waitFor(async () => ctx.calls().filter((x) => x === 'thread/queue/add').length === 2);
    await (m.bridge as any).deliverResultToConversation(outgoing.request_id, report.result?.result_id);
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(2);
    expect(ctx.calls().filter((x) => forbidden.includes(x))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(ctx.seed, 'utf8')).threads).toHaveLength(1);
  });
  it('leaves queue acceptance pending across restart, then deletes the exact item on cancellation without claiming a turn', async () => {
    const ctx = await setup(); const m = await migrated(ctx);
    const request = await ctx.a.sendRequest({ from_conv: ctx.aRow.conv_id, to: m.binding.convId, type: 'TASK', body: 'wait for owner' });
    await m.bridge.processRequest(request.request_id);
    await waitFor(async () => (await ctx.local.state.getDesktopDelivery(`inbox-intent:${request.request_id}`))?.status === 'queued');
    expect((await ctx.a.readResult(request.request_id)).request).toMatchObject({ exec_status: 'pending', turn_id: null, started_at: null });
    await m.bridge.stop();
    const restarted = new Bridge(m.opts); cleanups.push(() => restarted.stop());
    await restarted.start(ctx.local.state);
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(1);
    await ctx.a.cancel({ request_id: request.request_id, from_conv: ctx.aRow.conv_id });
    await restarted.processRequest(request.request_id);
    expect((await ctx.local.state.get(request.request_id))?.status).toBe('abandoned');
    expect((await ctx.a.readResult(request.request_id)).results).toHaveLength(0);
    expect(ctx.calls().filter((x) => x === 'thread/queue/delete')).toHaveLength(1);
    expect(ctx.calls().filter((x) => forbidden.includes(x))).toEqual([]);
  });
  it('bootstraps a new independent device against the existing desktop ID with zero new/resumed threads and persists before WS', async () => {
    const ctx = await setup();
    const invite = await ctx.a.invite(ctx.aRow.conv_id);
    fs.writeFileSync(path.join(ctx.dir, 'code.txt'), invite.code);
    const cfg = path.join(ctx.dir, 'bridge.json');
    await secureAtomicJson(cfg, { relay_url: ctx.env.baseUrl, execution_mode: 'desktop_inbox', bindings: [],
      pairing: { alias: 'new-B', role: 'worker', task: 'original desktop', code_file: 'code.txt', desktopThreadId: target } });
    const opts = { ...ctx.options(), ...configOptions(cfg), codexCommand: process.execPath, codexArgs: [MOCK_PATH], codexEnv: ctx.options().codexEnv };
    const persist = opts.persistPairing!; let bridge!: Bridge;
    opts.persistPairing = async (receipt) => { await persist(receipt); expect(bridge.relayClient).toBeUndefined(); };
    bridge = new Bridge(opts); cleanups.push(() => bridge.stop());
    await bridge.start(ctx.local.state);
    const saved = readConfig(cfg);
    expect(saved.device_token).toBeTruthy();
    expect(saved.bindings![0]).toMatchObject({ threadId: target, desktopThreadId: target });
    expect(saved.pairing).toBeUndefined();
    expect((await ctx.local.state.getBinding('new-B')).thread_id).toBe(target);
    expect(ctx.calls().filter((x) => forbidden.includes(x))).toEqual([]);
    await bridge.stop();
    const next = new Bridge({ ...ctx.options(), ...configOptions(cfg), codexCommand: process.execPath, codexArgs: [MOCK_PATH], codexEnv: ctx.options().codexEnv });
    cleanups.push(() => next.stop()); await next.start(ctx.local.state);
    expect(JSON.parse(fs.readFileSync(ctx.seed, 'utf8')).threads).toHaveLength(1);
    expect(ctx.calls().filter((x) => forbidden.includes(x))).toEqual([]);
  });
  it('deletes an expired unconsumed queue item without reporting execution or starting another input', async () => {
    const ctx = await setup(); const m = await migrated(ctx);
    const request = await ctx.a.sendRequest({ from_conv: ctx.aRow.conv_id, to: m.binding.convId, type: 'TASK', body: 'expires queued' });
    await m.bridge.processRequest(request.request_id);
    await waitFor(async () => (await ctx.local.state.getDesktopDelivery(`inbox-intent:${request.request_id}`))?.status === 'queued');
    await ctx.env.relay.store.db.query('UPDATE requests SET expires_at=$2 WHERE request_id=$1', [request.request_id, Date.now() - 1]);
    await m.bridge.processRequest(request.request_id);
    expect((await ctx.local.state.get(request.request_id))?.status).toBe('abandoned');
    expect((await ctx.a.readResult(request.request_id)).results).toHaveLength(0);
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(1);
    expect(ctx.calls().filter((x) => x === 'thread/queue/delete')).toHaveLength(1);
  });
  it('refuses a legacy server running permit before queue/add, without treating it as owner execution', async () => {
    const ctx = await setup(); const m = await migrated(ctx);
    m.bridge.relayClient.authorizeStart = async () => ({ exec_status: 'running', started_at: Date.now(), start_authorized_at: Date.now() });
    const request = await ctx.a.sendRequest({ from_conv: ctx.aRow.conv_id, to: m.binding.convId, type: 'QUERY', body: 'old server must not queue' });
    await m.bridge.processRequest(request.request_id).catch(() => {});
    expect(ctx.calls().filter((x) => x === 'thread/queue/add')).toHaveLength(0);
    expect((await ctx.a.readResult(request.request_id)).results).toHaveLength(0);
    expect((await ctx.local.state.get(request.request_id))?.turn_id).toBeNull();
  });
});
