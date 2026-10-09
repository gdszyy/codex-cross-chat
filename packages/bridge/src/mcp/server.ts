#!/usr/bin/env node
/**
 * Relay MCP tool server (tools-only capability), implemented directly against
 * the MCP stdio JSON-RPC protocol so it has no extra runtime dependency.
 *
 * Authority: docs/mechanism-design.md §7 tool card (nine tools) and §1.2-A-1
 * (channel binding: each conversation gets its own MCP instance with conv_id
 * injected via launch arguments — identity comes from the connection, not from
 * what the model writes in its own message).
 *
 * Launch args / env:
 *   --conv-id <c-xxxx>     the conversation this instance speaks for (injected)
 *   --profile <p>          runtime profile for binding resolution
 *   --thread-id <id>       local threadId for binding resolution
 *   RELAY_URL              relay base url
 *   RELAY_DEVICE_TOKEN     device token (never the root key)
 */
import readline from 'node:readline';
import { RelayClient } from '../relayClient.js';

const PROTOCOL_VERSION = '2024-11-05';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const convId = argValue('--conv-id') ?? process.env.RELAY_CONV_ID ?? '';
const profile = argValue('--profile') ?? process.env.RELAY_PROFILE ?? 'default';
const threadId = argValue('--thread-id') ?? process.env.RELAY_THREAD_ID ?? '';
const relayUrl = process.env.RELAY_URL ?? 'http://127.0.0.1:8788';
const deviceToken = process.env.RELAY_DEVICE_TOKEN ?? '';

const relay = new RelayClient({ baseUrl: relayUrl, deviceToken });
const binding = { conv_id: convId || undefined, profile, thread_id: threadId || undefined };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
}

const str = (description: string, required = false) => ({ type: 'string', description, ...(required ? {} : {}) });

const TOOLS: ToolDef[] = [
  {
    name: 'relay_whoami',
    description: 'Return my identity (conv_id + roster row). Use after losing context.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => relay.me(binding),
  },
  {
    name: 'relay_discover',
    description: 'List addressable conversations (filter by project/role). Sending still requires an exact conv_id.',
    inputSchema: {
      type: 'object',
      properties: { project: str('filter by project'), role: str('filter by role'), q: str('substring of alias/task') },
      required: [],
    },
    handler: async (a) => relay.roster({ ...(a.project ? { project: a.project } : {}), ...(a.role ? { role: a.role } : {}), ...(a.q ? { q: a.q } : {}) }),
  },
  {
    name: 'relay_register',
    description: 'Self-register this conversation (new/T1). Provide alias/role/task/project.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: str('display alias'),
        role: str('manager|worker|verifier|observer'),
        task: str('one-line current duty'),
        project: str('project name'),
        task_ref: str('optional external task URL'),
      },
      required: ['alias', 'role', 'task', 'project'],
    },
    handler: async (a) => relay.registerRoster({ ...a, profile, thread_id: threadId, tier: 't1_managed' }),
  },
  {
    name: 'relay_join',
    description: 'Join the roster with an Owner-supplied invite code.',
    inputSchema: { type: 'object', properties: { code: str('relay-join code'), alias: str('optional alias') }, required: ['code'] },
    handler: async (a) => relay.join({ ...a, profile, thread_id: threadId }),
  },
  {
    name: 'relay_send',
    description: 'Send a TASK/QUERY/CLARIFY to another conversation. Target must be an exact conv_id.',
    inputSchema: {
      type: 'object',
      properties: {
        to: str('target conv_id (exact, no title guessing)'),
        type: str('TASK|QUERY|CLARIFY'),
        body: str('message body (<=64KB)'),
        context: str('optional background'),
        result_requirement: str('what a good result must contain'),
        ttl_s: str('seconds until it may no longer start (default 24h)'),
        parent_request_id: str('parent request_id when continuing a chain'),
      },
      required: ['to', 'type', 'body'],
    },
    handler: async (a) => relay.sendRequest({ ...a, from_conv: convId }),
  },
  {
    name: 'relay_status',
    description: 'Read the three-layer status (delivery/exec/return) of a request.',
    inputSchema: { type: 'object', properties: { request_id: str('request id', true) }, required: ['request_id'] },
    handler: async (a) => relay.getRequest(a.request_id),
  },
  {
    name: 'relay_read',
    description: 'Read the full result text + evidence references for a request.',
    inputSchema: { type: 'object', properties: { request_id: str('request id', true) }, required: ['request_id'] },
    handler: async (a) => relay.readResult(a.request_id),
  },
  {
    name: 'relay_cancel',
    description: 'Request cancellation of a request I originated.',
    inputSchema: { type: 'object', properties: { request_id: str('request id', true) }, required: ['request_id'] },
    handler: async (a) => relay.cancel({ request_id: a.request_id, from_conv: convId }),
  },
  {
    name: 'relay_inbox',
    description: 'My inbox: what awaits me, guidance on my running tasks, results to verify, my outbox.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => relay.inbox(convId || (await relay.me(binding))?.conv_id),
  },
];

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'codex-relay', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const out = await tool.handler(params?.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return reply(id, {
        content: [{ type: 'text', text: `tool error: ${(e as Error).message}` }],
        isError: true,
      });
    }
  }
  if (id !== undefined) return replyError(id, -32601, `method not found: ${method}`);
});

rl.on('close', () => process.exit(0));
