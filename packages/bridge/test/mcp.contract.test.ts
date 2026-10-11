/**
 * MCP tool server contract test: launches the relay MCP server as a real child
 * process and speaks the MCP stdio JSON-RPC protocol to it (tools/list,
 * tools/call), against a real relay. No in-process shortcuts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { registerDevice, rfetch, sleep, startRelay, type TestEnv } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.resolve(__dirname, '../src/mcp/server.ts');
const BRIDGE_DIR = path.resolve(__dirname, '..');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch {
      /* ignore */
    }
  }
});

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private waiters = new Map<number, (v: any) => void>();
  stderr = '';

  constructor(env: TestEnv, deviceToken: string, convId: string, threadId: string) {
    this.child = spawn(
      process.execPath,
      ['--import', 'tsx', MCP_SERVER, '--conv-id', convId, '--profile', 'default', '--thread-id', threadId],
      {
        cwd: BRIDGE_DIR,
        env: { ...process.env, RELAY_URL: env.baseUrl, RELAY_DEVICE_TOKEN: deviceToken },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    readline.createInterface({ input: this.child.stdout }).on('line', (l) => {
      try {
        const msg = JSON.parse(l);
        if (msg.id !== undefined && this.waiters.has(msg.id)) {
          this.waiters.get(msg.id)!(msg);
          this.waiters.delete(msg.id);
        }
      } catch {
        /* ignore */
      }
    });
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()));
  }

  call(method: string, params: any, timeoutMs = 40_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`mcp timeout ${method}; stderr=${this.stderr}`));
      }, timeoutMs);
      this.waiters.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: any = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function setup() {
  const env = await startRelay();
  cleanups.push(() => env.close());
  const dev = await registerDevice(env);
  const reg = await rfetch(env.baseUrl + '/v1/roster/register', {
    method: 'POST',
    headers: { authorization: `Bearer ${dev.device_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      profile: 'default',
      thread_id: 'th-mcp',
      alias: 'mcp-agent',
      role: 'worker',
      task: 'answer via tools',
      project: 'codex-relay',
    }),
  });
  const row: any = ((await reg.json()) as any).data;
  return { env, dev, convId: row.conv_id as string };
}

/**
 * Spawn the MCP server and complete the handshake. A freshly spawned child can
 * be slow to respond while the machine is loaded by the other suites, so retry
 * with a brand-new child rather than failing the contract.
 */
async function connectMcp(env: TestEnv, deviceToken: string, convId: string, threadId: string) {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = new McpClient(env, deviceToken, convId, threadId);
    cleanups.push(async () => client.close());
    await sleep(400);
    try {
      const init = await client.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      if (init.result?.serverInfo?.name === 'codex-relay') {
        client.notify('notifications/initialized');
        return client;
      }
      lastErr = new Error('unexpected initialize result: ' + JSON.stringify(init));
    } catch (e) {
      lastErr = e;
    }
    client.close();
  }
  throw lastErr;
}

describe('relay MCP tool server', () => {
  it('initializes, lists the nine tools and answers relay_whoami', async () => {
    const { env, dev, convId } = await setup();
    const client = await connectMcp(env, dev.device_token, convId, 'th-mcp');

    const list = await client.call('tools/list', {});
    const names = list.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      [
        'relay_cancel',
        'relay_discover',
        'relay_inbox',
        'relay_join',
        'relay_read',
        'relay_register',
        'relay_send',
        'relay_status',
        'relay_whoami',
      ].sort(),
    );

    const who = await client.call('tools/call', { name: 'relay_whoami', arguments: {} });
    const payload = JSON.parse(who.result.content[0].text);
    expect(payload.conv_id).toBe(convId);
    expect(payload.role).toBe('worker');
  });

  it('relay_discover returns the roster and relay_send enforces permissions', async () => {
    const { env, dev, convId } = await setup();
    // A second conversation that does NOT allow convId as a source.
    const reg2 = await rfetch(env.baseUrl + '/v1/roster/register', {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.device_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'default', thread_id: 'th-other', alias: 'other', role: 'worker', task: 'x', project: 'codex-relay' }),
    });
    const other: any = ((await reg2.json()) as any).data;

    const client = await connectMcp(env, dev.device_token, convId, 'th-mcp');

    const disc = await client.call('tools/call', { name: 'relay_discover', arguments: { project: 'codex-relay' } });
    const roster = JSON.parse(disc.result.content[0].text);
    expect(roster.map((r: any) => r.conv_id)).toContain(other.conv_id);
    expect(JSON.stringify(roster)).not.toContain('th-mcp'); // no threadIds leaked

    const denied = await client.call('tools/call', {
      name: 'relay_send',
      arguments: { to: other.conv_id, type: 'TASK', body: 'hi' },
    });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain('source_not_allowed');
  });
});
