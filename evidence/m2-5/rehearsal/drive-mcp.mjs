// drive-mcp.mjs — rehearsal harness: drive the documented stdio MCP server via standard JSON-RPC.
// usage: node drive-mcp.mjs <spec.json> <outLog.jsonl>
// spec: { tag, args: ["--profile","default","--thread-id","..."], listTools: bool, calls: [{name, arguments}] }
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';

const [specPath, outPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const secrets = [process.env.RELAY_DEVICE_TOKEN, process.env.RELAY_ROOT_KEY].filter(Boolean);
const redact = (s) => { let out = String(s); for (const sec of secrets) out = out.split(sec).join('<redacted>'); return out; };
const fd = openSync(outPath, 'w');
const log = (obj) => writeSync(fd, JSON.stringify(obj) + '\n');

const SERVER = 'D:/claude/codex-relay/packages/bridge/src/mcp/server.ts';
const cmdLine = `npx tsx "${SERVER}" ${(spec.args || []).join(' ')}`;
const child = spawn(cmdLine, {
  cwd: 'D:/claude/codex-relay',
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});
log({ ts: new Date().toISOString(), event: 'spawn', cmd: cmdLine, pid: child.pid });
child.stderr.on('data', (d) => log({ ts: new Date().toISOString(), event: 'stderr', text: redact(d.toString()).slice(0, 2000) }));

let nextId = 1;
const pending = new Map();
let buf = '';
const waiters = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log({ ts: new Date().toISOString(), event: 'nonjson-stdout', text: redact(line).slice(0, 500) }); continue; }
    log({ ts: new Date().toISOString(), event: 'recv', msg: JSON.parse(redact(line)) });
    if (msg.id !== undefined && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
    else if (msg.method) { /* notification from server — logged only */ }
  }
});

const send = (obj) => { const s = JSON.stringify(obj); child.stdin.write(s + '\n'); log({ ts: new Date().toISOString(), event: 'send', msg: JSON.parse(redact(s)) }); };
const request = (method, params, timeoutMs) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method} after ${timeoutMs}ms`)); }, timeoutMs);
  pending.set(id, (msg) => { clearTimeout(t); if (msg.error) reject(new Error(`rpc-error ${method}: ` + JSON.stringify(msg.error))); else resolve(msg.result); });
  send({ jsonrpc: '2.0', id, method, params });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exitLog = [];
try {
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'm2-5-rehearsal-driver', version: '0.0.1' } }, 90000);
  log({ ts: new Date().toISOString(), event: 'initialized', serverInfo: init?.serverInfo, protocolVersion: init?.protocolVersion });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(300);
  if (spec.listTools) {
    const tl = await request('tools/list', {}, 30000);
    log({ ts: new Date().toISOString(), event: 'tools', tools: (tl.tools || []).map((t) => ({ name: t.name, desc: (t.description || '').slice(0, 120) })) });
  }
  for (const call of spec.calls || []) {
    try {
      const res = await request('tools/call', { name: call.name, arguments: call.arguments ?? {} }, 60000);
      log({ ts: new Date().toISOString(), event: 'call-ok', tool: call.name, result: res });
    } catch (e) {
      log({ ts: new Date().toISOString(), event: 'call-err', tool: call.name, error: String(e.message) });
    }
    await sleep(200);
  }
} catch (e) {
  log({ ts: new Date().toISOString(), event: 'harness-error', error: String(e.message) });
} finally {
  child.kill();
  await sleep(800);
  try { if (child.exitCode !== null) exitLog.push({ killed: true, exitCode: child.exitCode }); else { child.kill('SIGKILL'); exitLog.push({ killed: true, exitCode: 'forced' }); } } catch { exitLog.push({ killed: true, exitCode: 'unknown' }); }
  log({ ts: new Date().toISOString(), event: 'exit', child: exitLog[0] });
  closeSync(fd);
  process.exit(0);
}
