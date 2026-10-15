/** Called by the native receiver, never receives/prints a device token. */
import fs from 'node:fs';
import { NativeJobStore } from './nativeJobStore.js';

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const inbox = value('--inbox'), id = value('--job-id');
  if (!inbox || !id) throw new Error('Exact --inbox and --job-id are required');
  const store = new NativeJobStore(inbox);
  if (action === 'claim') {
    const receiver = value('--receiver-thread-id'), target = value('--target-thread-id');
    if (!receiver || !target) throw new Error('Explicit receiver and allowed target IDs are required');
    const result = await store.claim(id, receiver, target);
    console.log(JSON.stringify({ job_id: id, send: result.send, status: result.status,
      ...(result.send ? { native_action: { tool: 'mcp__codex_app__send_message_to_thread',
        arguments: { threadId: result.job.targetThreadId, hostId: 'local', prompt: result.job.text } } } : {}) }, null, 2));
  } else if (action === 'complete') {
    const file = value('--receipt-file');
    if (!file) throw new Error('Original native tool --receipt-file is required');
    const result = await store.complete(id, JSON.parse(await fs.promises.readFile(file, 'utf8')));
    console.log(JSON.stringify({ job_id: id, status: result.status, native_receipt: result.nativeReceipt,
      ui_verified: false }, null, 2));
  } else if (action === 'status') {
    console.log(JSON.stringify({ job_id: id, claim: await store.status(id) }, null, 2));
  } else if (action === 'uncertain') {
    await store.uncertain(id);
    console.log(JSON.stringify({ job_id: id, status: 'uncertain', retry_allowed: false }));
  } else throw new Error('Use claim, complete, status or uncertain');
}
main().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  // Never expose file contents, remote text or arbitrary exception messages.
  console.error(JSON.stringify({error: 'native_job_operation_failed',
    ...(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? {filesystem_code:code} : {}),
    action: 'Inspect the same local job/receipt; do not resend. Use supported scoped permissions for EACCES/EPERM.'}));
  process.exitCode = 1;
});
