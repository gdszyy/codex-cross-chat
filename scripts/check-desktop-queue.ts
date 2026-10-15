/** Real CLI + real local PostgreSQL preflight. Never queues a message or starts a model. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CodexClient } from '../packages/bridge/src/codexClient.js';
import { DesktopQueueClient } from '../packages/bridge/src/desktopQueue.js';
import { DesktopDelivery, DesktopDeliveryError } from '../packages/bridge/src/desktopDelivery.js';
import { LocalState } from '../packages/bridge/src/state.js';
import { openLocalPg } from '../packages/bridge/src/db.js';

async function main() {
  const i = process.argv.indexOf('--thread-id');
  const threadId = i < 0 ? undefined : process.argv[i + 1];
  if (!threadId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error('An exact existing desktop --thread-id UUID is required');
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-desktop-preflight-'));
  const calls: string[] = [];
  const codex = new CodexClient({ command: process.platform === 'win32' ? 'cmd.exe' : 'codex',
    args: process.platform === 'win32' ? ['/d', '/s', '/c', 'codex app-server --stdio'] : ['app-server', '--stdio'],
    experimentalApi: true });
  const rpc = codex.rpc.bind(codex);
  // Observe and restrict a real transport, never substitute fabricated responses.
  codex.rpc = ((method: string, params: any, timeout?: number) => {
    if (!['initialize', 'thread/read', 'thread/queue/list'].includes(method)) throw new Error('Preflight refuses write/model APIs');
    calls.push(method);
    return rpc(method, params, timeout);
  }) as typeof codex.rpc;
  let db = await openLocalPg(stateDir);
  try {
    let state = new LocalState(db);
    await state.init();
    await codex.start();
    const queue = new DesktopQueueClient(codex);
    const target = await queue.verifyTarget(threadId);
    const key = `preflight:${randomUUID()}`;
    // Exercise the actual durable prepared-intent recovery path without an add.
    const crypto = await import('node:crypto');
    const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
    const text = 'Preflight prepared intent; no queue write was attempted.';
    const intent = { version: 1, key, threadId, clientUserMessageId: `relay-desktop-${hash(key)}`,
      textHash: hash(text), status: 'prepared' };
    assert.equal(await queue.lookup({ threadId, clientUserMessageId: intent.clientUserMessageId }), null);
    await state.saveDesktopDelivery(key, intent);
    await db.close();
    db = await openLocalPg(stateDir);
    state = new LocalState(db);
    await state.init();
    assert.deepEqual(await state.getDesktopDelivery(key), intent);
    const delivery = new DesktopDelivery(codex, state);
    await assert.rejects(delivery.deliver({ key, threadId, text }),
      (error: unknown) => error instanceof DesktopDeliveryError && error.code === 'acceptance_unknown');
    assert.equal((await state.getDesktopDelivery(key)).status, 'uncertain');
    await assert.rejects(delivery.deliver({ key, threadId, text: text + ' changed' }),
      (error: unknown) => error instanceof DesktopDeliveryError && error.code === 'notification_drift');
    await assert.rejects(queue.verifyTarget('not-a-uuid'));
    assert(!calls.some((m) => /add|start|resume|fork|create/.test(m)));
    console.log(JSON.stringify({ verified_at: new Date().toISOString(), thread_id: target.id,
      history_mode: target.historyMode, persisted_after_reopen: true, prepared_absent_no_resend: true,
      drift_refused: true, queue_write_calls: 0, model_start_calls: 0, real_rpc_calls: calls }, null, 2));
  } finally {
    await codex.close();
    await db.close();
    // Only the unique empty/noncredential test database created above is removed.
    const resolved = fs.realpathSync(stateDir);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert(path.basename(resolved).startsWith('relay-desktop-preflight-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Desktop queue preflight failed; no queue write or model was authorized.'); process.exitCode = 1; });
