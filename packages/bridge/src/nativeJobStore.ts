/** Private hand-off files between a Bridge and a real native Codex receiver. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { secureAtomicJson } from './config.js';
import type { DesktopDeliveryState } from './desktopDelivery.js';

export interface NativeJob {
  version: 1;
  id: string;
  key: string;
  receiverThreadId: string;
  targetThreadId: string;
  requestId: string;
  resultId: string;
  localConvId: string;
  text: string;
  textHash: string;
}
export interface NativeClaim {
  version: 1;
  jobId: string;
  receiverThreadId: string;
  targetThreadId: string;
  textHash: string;
  status: 'claimed' | 'submitted' | 'uncertain';
  claimedAt: string;
  submittedAt?: string;
  nativeReceipt?: { threadId: string; status: string; turnId?: string; messageId?: string };
}
export const nativeHash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
interface NativeQueueCheckpoint {
  version: 1; key: string; threadId: string; clientUserMessageId: string; textHash: string;
  status: 'prepared' | 'queued' | 'uncertain'; queuedSubmissionId?: string;
}

/** Refuse Git/Codex stores, including aliases through an existing junction. */
export function validateNativeInboxDir(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Native inbox must be an absolute directory outside Git and Codex stores');
  const resolved = path.resolve(value);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Native inbox has no existing parent');
    existing = parent;
  }
  const actual = path.resolve(fs.realpathSync(existing), path.relative(existing, resolved));
  for (let current = actual;; current = path.dirname(current)) {
    if (path.basename(current).toLowerCase() === '.codex' || fs.existsSync(path.join(current, '.git'))) {
      throw new Error('Native inbox must be outside Git and Codex stores');
    }
    if (path.dirname(current) === current) break;
  }
  return actual;
}

export class NativeJobStore implements DesktopDeliveryState {
  readonly dir: string;
  constructor(dir: string) { this.dir = validateNativeInboxDir(dir); }
  private file(id: string, suffix: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Exact native job ID required');
    return path.join(this.dir, id + suffix);
  }
  private validate(job: NativeJob): void {
    if (job.version !== 1 || job.id !== nativeHash(job.key) || !job.key.startsWith('native-forward:')
      || !uuid.test(job.receiverThreadId) || !uuid.test(job.targetThreadId) || job.receiverThreadId.toLowerCase() === job.targetThreadId.toLowerCase()
      || !/^r-[a-zA-Z0-9_-]+$/.test(job.requestId) || !/^res-[a-zA-Z0-9_-]+$/.test(job.resultId)
      || !/^c-[a-zA-Z0-9_-]+$/.test(job.localConvId) || typeof job.text !== 'string' || !job.text
      || job.textHash !== nativeHash(job.text)) throw new Error('Native job identity or content is invalid');
  }
  async prepare(input: Omit<NativeJob, 'id' | 'version' | 'textHash'>, legacyText?: string): Promise<NativeJob> {
    const job: NativeJob = { ...input, version: 1, id: nativeHash(input.key), textHash: nativeHash(input.text) };
    this.validate(job);
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.file(job.id, '.job.json');
    const matchingPrior = async () => {
      const prior = await this.read(job.id);
      const fields = ['version', 'id', 'key', 'receiverThreadId', 'targetThreadId', 'requestId', 'resultId', 'localConvId'] as const;
      if (fields.some((field) => prior[field] !== job[field])) throw new Error('Native job target or content changed; no resend');
      const sameCurrent = prior.text === job.text && prior.textHash === job.textHash;
      const frozenLegacy = typeof legacyText === 'string' && prior.text === legacyText && prior.textHash === nativeHash(legacyText);
      if (!sameCurrent && !frozenLegacy) throw new Error('Native job target or content changed; no resend');
      return prior;
    };
    if (fs.existsSync(file)) {
      return matchingPrior();
    }
    // This permanent first-writer guard survives crashes. A guard without its
    // completed job is uncertain, never permission for another writer to win.
    let guard;
    try { guard = await fs.promises.open(this.file(job.id, '.prepare.guard'), 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (fs.existsSync(file)) return matchingPrior();
      throw new Error('Native preparation is in progress or uncertain; inspect the same job before continuing');
    }
    try { await guard.writeFile(job.id); await guard.sync(); } finally { await guard.close(); }
    if (fs.existsSync(file)) return matchingPrior();
    await secureAtomicJson(file, job);
    return job;
  }

  private async validateQueue(key: string, value: any): Promise<NativeQueueCheckpoint> {
    const id = nativeHash(key);
    const job = await this.read(id);
    if (!value || value.version !== 1 || value.key !== key || key !== job.key
      || value.threadId !== job.receiverThreadId || value.clientUserMessageId !== `relay-desktop-${id}`
      || !/^[0-9a-f]{64}$/.test(value.textHash ?? '') || !['prepared', 'queued', 'uncertain'].includes(value.status)
      || (value.status === 'queued' && (typeof value.queuedSubmissionId !== 'string' || !value.queuedSubmissionId))) {
      throw new Error('Native receiver queue checkpoint identity or shape is invalid');
    }
    return value;
  }

  async getDesktopDelivery(key: string): Promise<NativeQueueCheckpoint | null> {
    if (typeof key !== 'string' || !key.startsWith('native-forward:')) throw new Error('Exact native queue key required');
    const id = nativeHash(key);
    let text: string;
    try { text = await fs.promises.readFile(this.file(id, '.queue.json'), 'utf8'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (fs.existsSync(this.file(id, '.queue.guard'))) throw new Error('Native receiver queue preparation is uncertain; no second add');
      return null;
    }
    return this.validateQueue(key, JSON.parse(text));
  }

  async saveDesktopDelivery(key: string, value: unknown): Promise<void> {
    const record = await this.validateQueue(key, value);
    const id = nativeHash(key), file = this.file(id, '.queue.json');
    if (record.status === 'prepared') {
      // DesktopDelivery saves prepared BEFORE its first queue/add. Exactly one
      // process can cross this boundary even if both previously read null.
      let guard;
      try { guard = await fs.promises.open(this.file(id, '.queue.guard'), 'wx', 0o600); }
      catch { throw new Error('Native receiver queue already has an intent; inspect it without adding again'); }
      try { await guard.writeFile(id); await guard.sync(); } finally { await guard.close(); }
      if (fs.existsSync(file)) throw new Error('Native receiver queue checkpoint already exists; no overwrite');
    } else {
      const prior = await this.getDesktopDelivery(key);
      if (!prior || prior.threadId !== record.threadId || prior.textHash !== record.textHash
        || prior.clientUserMessageId !== record.clientUserMessageId) {
        throw new Error('Native receiver queue receipt has no matching durable intent');
      }
      if (prior.status === 'queued') {
        if (record.status === 'queued' && prior.queuedSubmissionId !== record.queuedSubmissionId) {
          throw new Error('Native receiver queue receipt changed; inspect the original submission');
        }
        return; // Never downgrade an accepted durable receipt to uncertain.
      }
    }
    await secureAtomicJson(file, record);
  }
  async read(id: string): Promise<NativeJob> {
    const job = JSON.parse(await fs.promises.readFile(this.file(id, '.job.json'), 'utf8')) as NativeJob;
    this.validate(job);
    if (job.id !== id) throw new Error('Native job identity mismatch');
    return job;
  }
  async status(id: string): Promise<NativeClaim | null> {
    const file = this.file(id, '.claim.json');
    if (!fs.existsSync(file)) {
      if (fs.existsSync(this.file(id, '.claim.guard'))) throw new Error('Native claim is uncertain; do not send');
      return null;
    }
    const claim = JSON.parse(await fs.promises.readFile(file, 'utf8')) as NativeClaim;
    const job = await this.read(id);
    if (claim.version !== 1 || claim.jobId !== id || claim.targetThreadId !== job.targetThreadId
      || claim.receiverThreadId !== job.receiverThreadId || claim.textHash !== job.textHash
      || !['claimed', 'submitted', 'uncertain'].includes(claim.status)) throw new Error('Native claim is invalid; do not send');
    return claim;
  }
  async claim(id: string, receiverThreadId: string, targetThreadId: string): Promise<{ send: boolean; job: NativeJob; status: string }> {
    const job = await this.read(id);
    if (receiverThreadId !== job.receiverThreadId || targetThreadId !== job.targetThreadId) throw new Error('Native receiver or allowed target mismatch');
    const prior = await this.status(id);
    if (prior) return { send: false, job, status: prior.status };
    let guard;
    try { guard = await fs.promises.open(this.file(id, '.claim.guard'), 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      return { send: false, job, status: (await this.status(id))?.status ?? 'uncertain' };
    }
    try { await guard.writeFile(id); await guard.sync(); } finally { await guard.close(); }
    const claim: NativeClaim = { version: 1, jobId: id, receiverThreadId, targetThreadId, textHash: job.textHash,
      status: 'claimed', claimedAt: new Date().toISOString() };
    await secureAtomicJson(this.file(id, '.claim.json'), claim);
    return { send: true, job, status: claim.status };
  }
  async complete(id: string, raw: unknown): Promise<NativeClaim> {
    const claim = await this.status(id);
    if (!claim || claim.status !== 'claimed') throw new Error('Native job is not a claimed first attempt');
    const candidates: any[] = [raw];
    if ((raw as any)?.isError === true) throw new Error('Native tool returned an error; do not resend');
    for (const block of (raw as any)?.content ?? []) {
      if (block.type === 'text') { try { candidates.push(JSON.parse(block.text)); } catch { /* not a receipt */ } }
    }
    // The actual Codex host receipt is MCP {isError:false, content:[text JSON
    // {threadId}]} and has no queue/delivery status. Preserve that distinction.
    const accepted = candidates.find(r => r?.threadId === claim.targetThreadId
      && (['queued', 'sent', 'accepted', 'started', 'running'].includes(r.status)
        || (r.status === undefined && (raw as any)?.isError === false)));
    if (!accepted) throw new Error('Native tool receipt shape is unconfirmed; preserve original response and do not resend');
    const receipt: NativeClaim['nativeReceipt'] = { threadId: accepted.threadId, status: accepted.status ?? 'tool_returned' };
    if (typeof accepted.turnId === 'string') receipt.turnId = accepted.turnId;
    if (typeof accepted.messageId === 'string') receipt.messageId = accepted.messageId;
    const result: NativeClaim = { ...claim, status: 'submitted', submittedAt: new Date().toISOString(), nativeReceipt: receipt };
    await secureAtomicJson(this.file(id, '.claim.json'), result);
    return result;
  }
  async uncertain(id: string): Promise<void> {
    const claim = await this.status(id);
    if (!claim || claim.status === 'submitted') throw new Error('Native job cannot be changed to uncertain');
    await secureAtomicJson(this.file(id, '.claim.json'), { ...claim, status: 'uncertain' });
  }
}
