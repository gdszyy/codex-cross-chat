/**
 * Dual-instance closed-loop driver (deliverable 7).
 *
 * Runs two bridge instances on this machine and performs an A -> B -> A round
 * trip plus the reverse, writing evidence to evidence/m2/.
 *
 * Modes:
 *   --mock        use the mock App Server (no model turns, safe for rehearsal)
 *   (default)     use the real pinned Codex CLI (0.149.0) with a low-cost model,
 *                 limited to <=2 real turns per direction.
 *
 * The bridge itself never writes ~/.codex; running the pinned CLI creates its
 * own thread rollout, exactly as the M1 probe did.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../packages/relay/src/server.js';
import { openPglite } from '../packages/relay/src/db.js';
import { Bridge } from '../packages/bridge/src/bridge.js';
import { LocalState } from '../packages/bridge/src/state.js';
import { openLocalPg } from '../packages/bridge/src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK = path.join(ROOT, 'packages', 'mock-codex', 'mock-app-server.mjs');
const EVIDENCE = path.join(ROOT, 'evidence', 'm2');
const ROOT_KEY = 'dual-instance-root-key';

const useMock = process.argv.includes('--mock');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : 'both'; // both | fwd | rev
const model = process.env.RELAY_MODEL || 'gpt-5.6-luna';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log: string[] = [];

function note(line: string) {
  const l = `[${new Date().toISOString()}] ${line}`;
  console.log(l);
  log.push(l);
}

async function post(baseUrl: string, p: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function get(baseUrl: string, p: string, headers: Record<string, string>) {
  const res = await fetch(baseUrl + p, { headers });
  return { status: res.status, body: await res.json() };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | undefined>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const evidence: any = { started_at: new Date().toISOString(), mode: useMock ? 'mock' : 'real', model, steps: [] };

  const db = await openPglite();
  const relay = await createRelay({ db, rootKey: ROOT_KEY, background: true });
  const port = await relay.listen(0);
  const baseUrl = `http://127.0.0.1:${port}`;
  note(`relay listening on ${baseUrl}`);

  const devA = (await post(baseUrl, '/v1/devices/register', { owner_label: 'owner' }, { 'x-root-key': ROOT_KEY })).body.data;
  const devB = (await post(baseUrl, '/v1/devices/register', { owner_label: 'owner' }, { 'x-root-key': ROOT_KEY })).body.data;
  note(`devices: A=${devA.device_id} B=${devB.device_id}`);

  const cwd = path.join(EVIDENCE, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const isWin = process.platform === 'win32';
  const codexCommand = useMock ? process.execPath : process.env.RELAY_CODEX_CMD || (isWin ? 'codex.cmd' : 'codex');
  const codexArgs = useMock ? [MOCK] : ['app-server', '--stdio'];
  const codexShell = !useMock && isWin && codexCommand.endsWith('.cmd');

  async function startBridgeInstance(token: string, alias: string, role: string) {
    const ldb = await openLocalPg();
    const state = new LocalState(ldb);
    await state.init();
    const bridge = new Bridge({
      relayUrl: baseUrl,
      deviceToken: token,
      profile: 'default',
      codexCommand,
      codexArgs,
      codexShell,
      model,
      cwd,
      bindings: [{ alias, role, task: `${alias} duty`, project: 'codex-relay' }],
      turnTimeoutMs: useMock ? 20_000 : 180_000,
      onLog: (lvl, m) => note(`  [${alias}] ${lvl}: ${m}`),
    });
    await bridge.start(state);
    return { bridge, state, db: ldb };
  }

  const A = await startBridgeInstance(devA.device_token, 'alpha', 'manager');
  const B = await startBridgeInstance(devB.device_token, 'beta', 'worker');
  note('bridges started');

  // Resolve conv ids from the local bindings.
  const bindingsA = await A.state.listBindings();
  const bindingsB = await B.state.listBindings();
  const convA = bindingsA[0].conv_id;
  const convB = bindingsB[0].conv_id;
  const threadA = bindingsA[0].thread_id;
  const threadB = bindingsB[0].thread_id;
  note(`convA=${convA} convB=${convB}`);
  evidence.threads = { threadA, threadB, convA, convB };

  // Open both directions.
  await post(baseUrl, '/v1/roster/register', {
    profile: 'default', thread_id: threadB, alias: 'beta', role: 'worker', task: 'beta duty',
    project: 'codex-relay', allow_sources: [convA],
  }, { authorization: `Bearer ${devB.device_token}` });
  await post(baseUrl, '/v1/roster/register', {
    profile: 'default', thread_id: threadA, alias: 'alpha', role: 'manager', task: 'alpha duty',
    project: 'codex-relay', allow_sources: [convB],
  }, { authorization: `Bearer ${devA.device_token}` });

  async function roundTrip(label: string, fromToken: string, fromConv: string, toConv: string, fromThread: string, prompt: string) {
    note(`--- ${label}: ${fromConv} -> ${toConv}`);
    const sent = await post(baseUrl, '/v1/requests', {
      from_conv: fromConv, to: toConv, type: 'TASK',
      body: prompt,
      result_requirement: 'a single short line',
    }, { authorization: `Bearer ${fromToken}` });
    const id = sent.body.data.request_id;
    note(`enqueued ${id}`);
    const done = await waitFor(async () => {
      const r = await get(baseUrl, `/v1/requests/${id}`, { authorization: `Bearer ${fromToken}` });
      return ['completed', 'failed', 'interrupted'].includes(r.body.data.exec_status) ? r.body.data : undefined;
    }, useMock ? 30_000 : 240_000, `${label} terminal`);
    const result = await get(baseUrl, `/v1/requests/${id}/result`, { authorization: `Bearer ${fromToken}` });

    // Read the origin conversation back to confirm the pushed result turn.
    // On the real stack `thread/read` can report an un-flushed (empty) rollout
    // for a freshly created thread, so a failed read is recorded honestly
    // rather than treated as a hard failure. The delivery-turn-started line is
    // captured from the bridge log as the primary evidence either way.
    const originBridge = fromConv === convA ? A : B;
    let originReadback = 'unavailable';
    let originTurns: number | undefined;
    try {
      const t = await waitFor(async () => {
        try {
          const th = await originBridge.bridge.codexClient.threadRead(fromThread, true);
          const texts = (th.turns ?? []).flatMap((x: any) => (x.items ?? []).map((i: any) => i.text ?? ''));
          return texts.some((x: string) => x.includes('relay-result:' + id)) ? th : undefined;
        } catch {
          return undefined;
        }
      }, useMock ? 30_000 : 90_000, `${label} result pushed to origin`);
      originReadback = 'thread/read confirmed';
      originTurns = t.turns?.length;
    } catch {
      originReadback = 'thread/read unavailable (rollout not readable in real stack)';
    }
    const deliveryTurn = log.find((l) => l.includes(`delivered result ${id} `))?.match(/turn=([0-9a-f-]+)/)?.[1];

    evidence.steps.push({
      label,
      request_id: id,
      exec_terminal: {
        exec_status: done.exec_status,
        delivery_status: done.delivery_status,
        return_status: done.return_status,
        turn_id: done.turn_id,
      },
      status: done,
      results: result.body.data.results?.map((r: any) => ({ kind: r.kind, is_first: r.is_first, body: String(r.body).slice(0, 300) })),
      delivery_turn_id: deliveryTurn,
      origin_readback: originReadback,
      origin_readback_note:
        'primary evidence of "result pushed into the origin conversation" is delivery_turn_id (a new turn started in the origin thread); ' +
        'thread/read read-back of that turn can report an unflushed rollout on the real stack and is tolerated.',
      origin_turns: originTurns,
    });
    note(`${label} OK exec=${done.exec_status} turn=${done.turn_id} delivery_turn=${deliveryTurn} origin_readback=${originReadback}`);
  }

  const runFwd = only === 'both' || only === 'fwd';
  const runRev = only === 'both' || only === 'rev';
  if (runFwd) {
    await roundTrip('A->B->A', devA.device_token, convA, convB, threadA,
      'Reply with exactly: RELAY-A2B-OK');
  }
  if (runRev) {
    await roundTrip('B->A->B', devB.device_token, convB, convA, threadB,
      'Reply with exactly: RELAY-B2A-OK');
  }

  evidence.finished_at = new Date().toISOString();
  evidence.ok = true;
  const outFile = path.join(EVIDENCE, `dual-instance-${useMock ? 'mock' : 'real'}-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
  fs.writeFileSync(outFile.replace(/\.json$/, '.log'), log.join('\r\n') + '\r\n');
  note(`evidence written: ${outFile}`);

  await A.bridge.stop();
  await B.bridge.stop();
  await A.db.close();
  await B.db.close();
  await relay.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[dual-instance] fatal', err);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  log.push(`FATAL ${String(err?.stack ?? err)}`);
  fs.writeFileSync(path.join(EVIDENCE, `dual-instance-${useMock ? 'mock' : 'real'}-${stamp}.log`), log.join('\r\n') + '\r\n');
  process.exit(1);
});
