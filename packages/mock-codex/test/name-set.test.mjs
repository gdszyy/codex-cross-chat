/** Fixture protocol regression only: no real Codex, Relay or model calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

function start(stateFile) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mock-app-server.mjs', import.meta.url))], {
    env: { ...process.env, MOCK_STATE_FILE: stateFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(), notifications = [];
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    if (response.method) notifications.push(response);
    else { pending.get(response.id)?.(response); pending.delete(response.id); }
  });
  return {
    notifications,
    rpc(method, params = {}) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('fixture RPC timed out')); }, 3000);
        pending.set(requestId, (response) => { clearTimeout(timer); resolve(response); });
        child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}

test('name/set preserves normalized name and exact empty thread across fixture restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-name-'));
  let server;
  try {
    const state = path.join(dir, 'state.json');
    server = start(state);
    await server.rpc('initialize');
    const created = await server.rpc('thread/start', { model: 'fixture-model' });
    const threadId = created.result.thread.id;
    assert.deepEqual((await server.rpc('thread/name/set', { threadId, name: '  stable alias  ' })).result, {});
    const read = await server.rpc('thread/read', { threadId, includeTurns: true });
    assert.equal(read.result.thread.name, 'stable alias');
    assert.deepEqual(read.result.thread.turns, []);
    assert.ok(server.notifications.some((n) => n.method === 'thread/name/updated'
      && n.params.threadId === threadId && n.params.threadName === 'stable alias'));
    await server.close();
    server = start(state);
    await server.rpc('initialize');
    assert.equal((await server.rpc('thread/resume', { threadId })).result.thread.name, 'stable alias');
    assert.equal((await server.rpc('thread/list')).result.data.find((t) => t.id === threadId).name, 'stable alias');
    assert.deepEqual((await server.rpc('thread/read', { threadId })).result.thread.turns, []);
    assert.equal(JSON.parse(await fs.readFile(state, 'utf8')).turns.length, 0);
  } finally { await server?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('name/set rejects missing threads, invalid params and empty names without creating a thread', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-name-'));
  const server = start(path.join(dir, 'state.json'));
  try {
    await server.rpc('initialize');
    assert.equal((await server.rpc('thread/name/set', { threadId: 'missing', name: 'valid' })).error.code, -32600);
    assert.equal((await server.rpc('thread/name/set', { threadId: 'missing', name: 42 })).error.code, -32602);
    assert.deepEqual((await server.rpc('thread/list')).result.data, []);
    const threadId = (await server.rpc('thread/start')).result.thread.id;
    assert.equal((await server.rpc('thread/name/set', { threadId, name: ' \t ' })).error.code, -32600);
    assert.equal((await server.rpc('thread/read', { threadId })).result.thread.name, null);
  } finally { await server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
