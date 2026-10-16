/** Durable queue acceptance, deliberately separate from UI delivery/execution. */
import { createHash } from 'node:crypto';
import type { CodexClient } from './codexClient.js';
import { DesktopQueueClient, DesktopQueueError, desktopSubmissionMatches } from './desktopQueue.js';

export interface DesktopDeliveryState {
  getDesktopDelivery(key: string): Promise<any | null>;
  saveDesktopDelivery(key: string, value: unknown): Promise<void>;
}

export interface DesktopDeliveryInput {
  key: string; threadId: string; text: string;
  /** Only newly prepared notifications use this format; legacy intents keep old bytes. */
  format?: 'plain_v2'; legacyText?: string;
}
export interface DesktopDeliveryReceipt {
  status: 'queued';
  accepted: true;
  queuedSubmissionId: string;
  clientUserMessageId: string;
  threadId: string;
}
interface DeliveryRecord {
  version: 1;
  key: string;
  threadId: string;
  clientUserMessageId: string;
  textHash: string;
  status: 'prepared' | 'queued' | 'uncertain';
  queuedSubmissionId?: string;
  format?: 'plain_v2';
}

export class DesktopDeliveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'DesktopDeliveryError'; }
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export class DesktopDelivery {
  private readonly queue: DesktopQueueClient;
  private readonly inFlight = new Map<string, { threadId: string; textHash: string; promise: Promise<DesktopDeliveryReceipt> }>();

  constructor(codex: Pick<CodexClient, 'rpc'>, private readonly state: DesktopDeliveryState,
    private readonly log: (level: string, message: string) => void = () => {}) {
    this.queue = new DesktopQueueClient(codex);
  }

  verifyTarget(threadId: string) { return this.queue.verifyTarget(threadId); }

  async deliver(input: DesktopDeliveryInput): Promise<DesktopDeliveryReceipt> {
    if (!input.key || typeof input.key !== 'string' || !input.text || typeof input.text !== 'string') {
      throw new DesktopDeliveryError('invalid_notification', 'Desktop notification key and text are required.');
    }
    // Select bytes using durable intent, before comparing hashes. Reformatting
    // an existing key must never cause a second add or discard its old receipt.
    if (input.format === 'plain_v2') {
      let prior: any;
      try { prior = await this.state.getDesktopDelivery(input.key); }
      catch { throw new DesktopDeliveryError('checkpoint_unavailable', 'Desktop notification checkpoint could not be read.'); }
      if (prior?.format !== undefined && prior.format !== 'plain_v2') {
        throw new DesktopDeliveryError('invalid_checkpoint', 'Unknown desktop notification format; no send attempted.');
      }
      if (prior && prior.format === undefined) {
        if (typeof input.legacyText !== 'string' || !input.legacyText) {
          throw new DesktopDeliveryError('legacy_format_required', 'Existing notification retains its original format; no send attempted.');
        }
        input = { ...input, text: input.legacyText, format: undefined };
      }
    }
    const textHash = hash(input.text);
    const active = this.inFlight.get(input.key);
    if (active) {
      if (active.threadId !== input.threadId || active.textHash !== textHash) {
        throw new DesktopDeliveryError('notification_drift', 'Desktop notification target or content changed for the same key.');
      }
      return active.promise;
    }
    const promise = this.deliverOnce(input, textHash);
    this.inFlight.set(input.key, { threadId: input.threadId, textHash, promise });
    try { return await promise; }
    finally { this.inFlight.delete(input.key); }
  }

  private async save(record: DeliveryRecord): Promise<void> {
    try { await this.state.saveDesktopDelivery(record.key, record); }
    catch { throw new DesktopDeliveryError('checkpoint_unavailable', 'Desktop notification checkpoint could not be saved.'); }
  }

  private receipt(record: DeliveryRecord): DesktopDeliveryReceipt {
    if (typeof record.queuedSubmissionId !== 'string' || !record.queuedSubmissionId) {
      throw new DesktopDeliveryError('invalid_checkpoint', 'Desktop queue receipt is incomplete.');
    }
    return { status: 'queued', accepted: true, queuedSubmissionId: record.queuedSubmissionId,
      clientUserMessageId: record.clientUserMessageId, threadId: record.threadId };
  }

  private async deliverOnce(input: DesktopDeliveryInput, textHash: string): Promise<DesktopDeliveryReceipt> {
    const clientUserMessageId = `relay-desktop-${hash(input.key)}`;
    let prior: any;
    try { prior = await this.state.getDesktopDelivery(input.key); }
    catch { throw new DesktopDeliveryError('checkpoint_unavailable', 'Desktop notification checkpoint could not be read.'); }
    let record: DeliveryRecord = { version: 1, key: input.key, threadId: input.threadId, clientUserMessageId,
      textHash, status: 'prepared', ...(input.format ? { format: input.format } : {}) };
    if (prior) {
      if (prior.version !== 1 || !['prepared', 'queued', 'uncertain'].includes(prior.status) || prior.key !== input.key) {
        throw new DesktopDeliveryError('invalid_checkpoint', 'Desktop notification checkpoint has an unexpected shape.');
      }
      if (prior.threadId !== input.threadId || prior.textHash !== textHash || prior.clientUserMessageId !== clientUserMessageId) {
        throw new DesktopDeliveryError('notification_drift', 'Desktop notification target or content changed for the same key.');
      }
      record = prior;
      if (record.status === 'queued') return this.receipt(record);
      // A prepared checkpoint may already have reached the desktop. A missing
      // queue entry may mean it was consumed: recovery MUST NOT add again.
      try {
        const found = await this.queue.lookup({ threadId: input.threadId, clientUserMessageId });
        if (!found) throw new DesktopDeliveryError('acceptance_unknown', 'Desktop notification is not currently in the queue; acceptance remains unknown.');
        if (!desktopSubmissionMatches(found, input.text)) {
          throw new DesktopDeliveryError('notification_drift', 'Desktop queue content differs from the durable notification.');
        }
        record = { ...record, status: 'queued', queuedSubmissionId: found.id };
        await this.save(record);
        return this.receipt(record);
      } catch (e) {
        await this.markUncertain(record);
        if (e instanceof DesktopDeliveryError && e.code === 'notification_drift') throw e;
        throw new DesktopDeliveryError('acceptance_unknown', 'Desktop notification acceptance is uncertain; no second add was attempted.');
      }
    }
    await this.verifyTarget(input.threadId);
    await this.save(record); // Durable intent BEFORE the first possible queue/add.
    try {
      const accepted = await this.queue.enqueue({ threadId: input.threadId, clientUserMessageId, text: input.text });
      record = { ...record, status: 'queued', queuedSubmissionId: accepted.queuedSubmissionId };
      await this.save(record);
      this.log('info', 'desktop notification queued; UI delivery unconfirmed');
      return this.receipt(record);
    } catch (e) {
      await this.markUncertain(record);
      const conflict = e instanceof DesktopQueueError && ['client_id_conflict', 'duplicate_client_id'].includes(e.code);
      throw new DesktopDeliveryError(conflict ? 'notification_drift' : 'acceptance_unknown',
        conflict ? 'Desktop queue content or identity conflicts with this notification.'
          : 'Desktop notification acceptance is uncertain; inspect the same durable intent before retrying.');
    }
  }

  private async markUncertain(record: DeliveryRecord): Promise<void> {
    try { await this.save({ ...record, status: 'uncertain' }); }
    catch { this.log('warn', 'desktop notification checkpoint update failed; no automatic second add'); }
  }
}
