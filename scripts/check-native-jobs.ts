/** Real filesystem invariants only: no Relay, Codex RPC, native send or model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { NativeJobStore, nativeHash, validateNativeInboxDir } from '../packages/bridge/src/nativeJobStore.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--state-root')) {
  throw new Error('Use check-native-jobs.ts [--state-root <absolute private test directory>]');
}
// Validate before creating anything, including existing junction ancestors.
const stateRoot = validateNativeInboxDir(args[1] ?? os.tmpdir());
await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
const root = await fs.mkdtemp(path.join(stateRoot, 'native-jobs-'));
const cases: string[] = [];
try {
  const store = new NativeJobStore(path.join(root, 'inbox'));
  const input = (key: string) => ({ key: `native-forward:filesystem-check:${key}`,
    receiverThreadId: '11111111-1111-1111-1111-111111111111', targetThreadId: '22222222-2222-2222-2222-222222222222',
    requestId: 'r-filesystem-check', resultId: 'res-filesystem-check', localConvId: 'c-filesystem-check', text: 'Filesystem invariant sample.' });
  const job = await store.prepare(input('semantic-order'));
  await fs.writeFile(path.join(store.dir, `${job.id}.job.json`), JSON.stringify(Object.fromEntries(Object.entries(job).reverse())));
  assert.deepEqual(await store.prepare(input('semantic-order')), Object.fromEntries(Object.entries(job).reverse()));
  await assert.rejects(store.prepare({ ...input('semantic-order'), text: 'Changed sample.' }));
  cases.push('semantic equality survives JSON property order; changed body rejected');

  const competitors = await Promise.allSettled([
    store.prepare({ ...input('competing'), text: 'Writer A.' }),
    new NativeJobStore(store.dir).prepare({ ...input('competing'), text: 'Writer B.' }),
  ]);
  assert.equal(competitors.filter((x) => x.status === 'fulfilled').length, 1);
  const winner = await store.read(nativeHash(input('competing').key));
  assert.ok(['Writer A.', 'Writer B.'].includes(winner.text));
  cases.push('conflicting concurrent prepares have exactly one filesystem winner');

  const crashed = input('crashed-prepare');
  await fs.writeFile(path.join(store.dir, `${nativeHash(crashed.key)}.prepare.guard`), 'interrupted', { flag: 'wx', mode: 0o600 });
  await assert.rejects(store.prepare(crashed));
  cases.push('prepare guard without a job remains fail-closed');

  const checkpoint = { version: 1, key: job.key, threadId: job.receiverThreadId,
    clientUserMessageId: `relay-desktop-${job.id}`, textHash: nativeHash('stable routing metadata'), status: 'prepared' };
  const saves = await Promise.allSettled([store.saveDesktopDelivery(job.key, checkpoint),
    new NativeJobStore(store.dir).saveDesktopDelivery(job.key, checkpoint)]);
  assert.equal(saves.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal((await store.getDesktopDelivery(job.key))?.status, 'prepared');
  await store.saveDesktopDelivery(job.key, { ...checkpoint, status: 'queued', queuedSubmissionId: 'filesystem-receipt' });
  await store.saveDesktopDelivery(job.key, { ...checkpoint, status: 'uncertain' });
  assert.equal((await store.getDesktopDelivery(job.key))?.status, 'queued');
  cases.push('exactly one first queue checkpoint writer; accepted receipt never downgraded');

  const crashedQueue = await store.prepare(input('crashed-queue'));
  await fs.writeFile(path.join(store.dir, `${crashedQueue.id}.queue.guard`), 'interrupted', { flag: 'wx', mode: 0o600 });
  await assert.rejects(store.getDesktopDelivery(crashedQueue.key));
  cases.push('queue guard without its checkpoint remains fail-closed');

  const claimed = await store.prepare(input('claimed'));
  assert.equal((await store.claim(claimed.id, claimed.receiverThreadId, claimed.targetThreadId)).send, true);
  assert.equal((await store.claim(claimed.id, claimed.receiverThreadId, claimed.targetThreadId)).send, false);
  cases.push('real file claim is once-only without invoking native send');

  const report = { passed: true, validation: 'filesystem-only', codex_rpc_calls: 0, relay_calls: 0,
    model_turns: 0, native_sends: 0, cases, directory: root };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { passed: false, validation: 'filesystem-only', cases, directory: root,
    error: error instanceof Error ? error.message : 'Unknown filesystem check failure' };
  // Keep guards and failed artifacts so a failed first write cannot be silently retried.
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
