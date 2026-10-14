/** Real CLI + HTTP recovery evidence. Refuses all model-start methods; no mock responses. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CodexClient } from '../packages/bridge/src/codexClient.js';
import { Bridge } from '../packages/bridge/src/bridge.js';
import { LocalState } from '../packages/bridge/src/state.js';
import { openLocalPg } from '../packages/bridge/src/db.js';
import { RelayClient } from '../packages/bridge/src/relayClient.js';
import { configOptions, readConfig, secureAtomicJson } from '../packages/bridge/src/config.js';
import { repairThread } from '../packages/bridge/src/repair-thread.js';
import { createRelay } from '../packages/relay/src/server.js';
import { openPglite } from '../packages/relay/src/db.js';

const argv = process.argv.slice(2);
const value = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const outDir = path.resolve(value('--out') ?? '../real-thread-recovery');
await fs.promises.mkdir(outDir, { recursive: true });
const probeHome = path.join(outDir, 'isolated-codex-home');
const cwd = path.join(outDir, 'workspace');
await fs.promises.mkdir(probeHome, { recursive: true });
await fs.promises.mkdir(cwd, { recursive: true });
const command = value('--codex-command') ?? (process.platform === 'win32' ? 'cmd.exe' : 'codex');
const commandArgs = process.platform === 'win32' && command === 'cmd.exe'
  ? ['/d', '/s', '/c', 'codex app-server --stdio'] : ['app-server', '--stdio'];
const version = process.platform === 'win32' && command === 'cmd.exe'
  ? execFileSync(command, ['/d', '/s', '/c', 'codex --version'], { encoding: 'utf8', windowsHide: true }).trim()
  : execFileSync(command, ['--version'], { encoding: 'utf8' }).trim();
const report: any = { at: new Date().toISOString(), version, model_turn_calls: 0, blocked_model_calls: 0,
  source: 'real codex app-server processes + local HTTP/PGlite; no mocked responses; no physical-device claim', cases: [] };
const clients = new Set<CodexClient>();
let activeRelay: Awaited<ReturnType<typeof createRelay>> | undefined;
const originalRpc = CodexClient.prototype.rpc;
CodexClient.prototype.rpc = function(method: string, params: any, timeout?: number) {
  if (['turn/start', 'review/start', 'thread/compact/start', 'thread/queue/start'].includes(method)) {
    report.blocked_model_calls++;
    throw new Error('zero-turn probe refuses model execution');
  }
  return originalRpc.call(this, method, params, timeout);
} as typeof originalRpc;
const safeThread = (t: any) => ({ id: t?.id, historyMode: t?.historyMode, ephemeral: t?.ephemeral,
  status: t?.status, turns: Array.isArray(t?.turns) ? t.turns.length : null });
async function session() {
  const client = new CodexClient({ command, args: commandArgs, cwd,
    env: { CODEX_HOME: probeHome, OPENAI_API_KEY: '', CODEX_API_KEY: '' } });
  clients.add(client);
  try { await client.start(); }
  catch (e) { await client.close(); throw e; }
  return client;
}
async function attempt(c: CodexClient, method: string, id: string) {
  try { const r = await c.rpc(method, { threadId: id, ...(method === 'thread/read' ? { includeTurns: true } : {}) });
    return { ok: true, thread: safeThread(r.thread) }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function persist() { await fs.promises.writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); }
function requireTrue(condition: unknown, detail: string): asserts condition { if (!condition) throw new Error(detail); }

try {
  for (const mode of ['plain', 'fixed_adapter']) {
    const a = await session();
    let id: string;
    try {
      id = mode === 'plain'
        ? (await a.rpc('thread/start', { cwd, sandbox: 'read-only', ephemeral: false, model: 'gpt-5.6-luna' })).thread.id
        : await a.threadStart('gpt-5.6-luna', cwd, 'zero-turn-durable-probe');
    } finally { await a.close(); }
    const b = await session();
    const entry: any = { mode, thread_id: id!, old_process_closed: !a.isRunning };
    try {
      entry.read_before_resume = await attempt(b, 'thread/read', id!);
      const loaded = await b.rpc('thread/loaded/list', {});
      entry.loaded_before_resume = (loaded.data ?? []).includes(id!);
      try { entry.resume = { ok: true, thread: safeThread(await b.threadResume(id!)) }; }
      catch (e) { entry.resume = { ok: false, error: (e as Error).message }; }
      entry.read_after_resume = await attempt(b, 'thread/read', id!);
    } finally { await b.close(); }
    entry.new_process_closed = !b.isRunning;
    report.cases.push(entry);
    await persist();
    if (mode === 'plain') requireTrue(!entry.resume.ok && entry.resume.error.includes('no rollout found'), 'plain zero-turn regression was not reproduced');
    else requireTrue(entry.resume.ok && entry.resume.thread.id === id! && entry.resume.thread.turns === 0 &&
      entry.read_after_resume.ok && entry.read_after_resume.thread.turns === 0 && !entry.loaded_before_resume,
      'fixed adapter did not restore exactly the same zero-turn thread');
  }

  // Local end-to-end repair: test-only device tokens never leave this process
  // and private temp config. All Codex threads below use the isolated home.
  const server = await createRelay({ db: await openPglite(), rootKey: randomUUID(), background: false });
  activeRelay = server;
  const port = await server.listen(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  const devA = await server.store.registerDevice('local-proof-a');
  const devB = await server.store.registerDevice('local-proof-b');
  const source = new RelayClient({ baseUrl, deviceToken: devA.device_token });
  const target = new RelayClient({ baseUrl, deviceToken: devB.device_token });
  const start = await session();
  let lost: string;
  let peerId: string;
  try {
    lost = (await start.rpc('thread/start', { cwd, sandbox: 'read-only', ephemeral: false, model: 'gpt-5.6-luna' })).thread.id;
    peerId = await start.threadStart('gpt-5.6-luna', cwd, 'local-proof-peer');
  } finally { await start.close(); }
  const sourceRow = await source.registerRoster({ profile: 'default', thread_id: peerId!, alias: 'source', role: 'manager', task: 'local proof', project: 'zero-turn-proof' });
  const targetRow = await target.registerRoster({ profile: 'default', thread_id: lost!, alias: 'target', role: 'worker', task: 'local proof', project: 'zero-turn-proof', allow_sources: [sourceRow.conv_id] });
  const invitation = await source.invite(sourceRow.conv_id);
  const paired = await target.redeem({ code: invitation.code, profile: 'default', thread_id: lost!, alias: 'target', role: 'worker', task: 'local proof' });
  const request = await source.sendRequest({ from_conv: sourceRow.conv_id, to: targetRow.conv_id, type: 'QUERY', body: 'local zero-model recovery fixture' });
  await target.submitResult(request.request_id, { conv_id: targetRow.conv_id, kind: 'STATUS', exec_status: 'failed', body: 'explicitly failed local fixture; no model was started' });
  const cfgPath = path.join(outDir, 'private-local-test-config.json');
  const stateDir = path.join(outDir, 'bridge-state');
  await secureAtomicJson(cfgPath, { relay_url: baseUrl, device_token: devB.device_token, profile: 'default', state_dir: stateDir,
    cwd, model: 'gpt-5.6-luna', codex_command: command, codex_args: commandArgs, result_delivery_mode: 'manual_read',
    bindings: [{ alias: 'target', role: 'worker', task: 'local proof', project: 'zero-turn-proof', threadId: lost!, convId: targetRow.conv_id }] });
  let db = await openLocalPg(stateDir);
  let state = new LocalState(db);
  await state.init();
  await state.saveBinding('target', 'default', lost!, targetRow.conv_id);
  await state.intent(request.request_id, request.request_id, targetRow.conv_id, lost!, `relay:${request.request_id}`);
  await state.finish(request.request_id, 'failed');
  await db.close();
  const priorEnv = { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY };
  process.env.CODEX_HOME = probeHome;
  process.env.OPENAI_API_KEY = '';
  process.env.CODEX_API_KEY = '';
  try {
    const negativeResults: string[] = [];
    async function expectRefused(file: string, more: string[], name: string) {
      let refused = false;
      try { await repairThread(['--config', file, '--conv-id', targetRow.conv_id, '--ack-history-unrecoverable', ...more]); }
      catch { refused = true; }
      requireTrue(refused, 'invalid local repair selection was accepted: ' + name);
      requireTrue((await target.me({ conv_id: targetRow.conv_id })).thread_id === lost!, 'negative repair changed remote identity');
      requireTrue(!fs.existsSync(file + `.thread-repair-${targetRow.conv_id}.json`), 'negative repair created a replacement intent');
      negativeResults.push(name);
    }
    await expectRefused(cfgPath, ['--alias', 'does-not-exist'], 'unknown alias');
    const dupConfig = path.join(outDir, 'private-duplicate-test-config.json');
    const dup = readConfig(cfgPath);
    dup.bindings = [...dup.bindings!, { ...dup.bindings![0], alias: 'duplicate' }];
    await secureAtomicJson(dupConfig, dup);
    await expectRefused(dupConfig, ['--alias', 'target'], 'duplicate conversation binding');
    const incompleteConfig = path.join(outDir, 'private-incomplete-test-config.json');
    const incomplete = readConfig(cfgPath);
    incomplete.bindings = [{ alias: 'target', role: 'worker', task: 'local proof', project: 'zero-turn-proof' }];
    incomplete.state_dir = path.join(outDir, 'empty-local-state');
    await secureAtomicJson(incompleteConfig, incomplete);
    await expectRefused(incompleteConfig, [], 'missing exact local identity');
    const repaired = await repairThread(['--config', cfgPath, '--conv-id', targetRow.conv_id, '--ack-history-unrecoverable']);
    const own = await target.me({ conv_id: targetRow.conv_id });
    const pairs = await target.pairings(targetRow.conv_id);
    const cfg = readConfig(cfgPath);
    requireTrue(repaired.status === 'repaired' && own.thread_id !== lost! && own.conv_id === targetRow.conv_id, 'rebind did not preserve conversation');
    requireTrue(pairs.some((p: any) => p.pairing_id === paired.pairing_id && p.revoked_at === null), 'repair lost pairing');
    requireTrue(cfg.device_token === devB.device_token && own.allow_sources.includes(sourceRow.conv_id), 'repair lost token or manual ACL');
    for (let restart = 0; restart < 2; restart++) {
      db = await openLocalPg(stateDir); state = new LocalState(db); await state.init();
      const bridge = new Bridge(configOptions(cfgPath));
      try {
        await bridge.start(state);
        await bridge.processRequest(request.request_id);
        const thread = await bridge.codexClient.threadRead(own.thread_id, true);
        requireTrue(thread.id === own.thread_id && thread.turns.length === 0, 'Bridge startup replayed a failed request or lost its thread');
        requireTrue((await state.getBinding('target')).conv_id === targetRow.conv_id, 'Bridge startup changed conversation');
      } finally { await bridge.stop(); await db.close(); }
    }
    report.repair = { status: 'passed', conv_preserved: true, pairing_preserved: true, manual_acl_preserved: true,
      token_preserved: true, failed_request_not_replayed: true, bridge_restarts: 2, turns: 0,
      rejected_before_mutation: negativeResults,
      old_thread_id: lost!, thread_id: own.thread_id, conv_id: own.conv_id };
  } finally {
    for (const [key, val] of Object.entries(priorEnv)) { if (val === undefined) delete process.env[key]; else process.env[key] = val; }
    await server.close();
    activeRelay = undefined;
  }
  requireTrue(report.blocked_model_calls === 0, 'unexpected model-start attempt was blocked');
  report.status = 'passed';
} catch (e) {
  report.status = 'failed'; report.error = (e as Error).message; process.exitCode = 1;
} finally {
  for (const client of clients) await client.close();
  await activeRelay?.close();
  report.all_probe_clients_closed = [...clients].every((c) => !c.isRunning);
  CodexClient.prototype.rpc = originalRpc;
  await persist();
}
console.log(JSON.stringify(report, null, 2));
console.log('evidence: ' + path.join(outDir, 'report.json'));
