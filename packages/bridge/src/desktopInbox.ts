/** Execute only through the existing desktop owner's queue. Never acquires a writer. */
import { createHash } from 'node:crypto';
import type { CodexClient } from './codexClient.js';
import { DesktopDelivery, type DesktopDeliveryState } from './desktopDelivery.js';
import { DesktopQueueClient, desktopSubmissionMatches } from './desktopQueue.js';

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const key = (id: string) => `desktop-inbox:${id}`;
export interface DesktopInboxRecord {
  version: 1; requestId: string; convId: string; identityThreadId: string; targetThreadId: string;
  clientId: string; textHash: string; marker: string;
  status: 'prepared' | 'queued' | 'uncertain' | 'observed' | 'cancel_pending' | 'cancelled';
  queuedSubmissionId?: string; turnId?: string; cancelRequested?: boolean;
}
export class DesktopInbox {
  private queue: DesktopQueueClient;
  private delivery: DesktopDelivery;
  constructor(private codex: CodexClient, private state: DesktopDeliveryState) {
    this.queue = new DesktopQueueClient(codex);
    this.delivery = new DesktopDelivery(codex, state);
  }
  async verifyTarget(threadId: string) {
    // A complete inventory proves this concrete public queue is available;
    // absence is not permission to create/resume/replace the target.
    try {
      await this.queue.verifyTarget(threadId);
      await this.queue.lookup({ threadId, clientUserMessageId: 'relay-desktop-capability-readonly' });
      await this.codex.desktopThreadRead(threadId);
    } catch { throw new Error('desktop inbox target/history is unavailable or incompatible; no writer or replacement was requested'); }
  }
  async get(requestId: string): Promise<DesktopInboxRecord | null> {
    const r = await this.state.getDesktopDelivery(`inbox-intent:${requestId}`);
    if (r && (r.version !== 1 || r.requestId !== requestId || typeof r.targetThreadId !== 'string'
      || typeof r.identityThreadId !== 'string' || typeof r.convId !== 'string'
      || r.clientId !== `relay-desktop-${hash(key(requestId))}` || !/^[a-f0-9]{64}$/.test(r.textHash)
      || r.marker !== `[[relay-inbox:${requestId}]]`
      || (r.queuedSubmissionId !== undefined && (typeof r.queuedSubmissionId !== 'string' || !r.queuedSubmissionId))
      || (r.turnId !== undefined && (typeof r.turnId !== 'string' || !r.turnId))
      || !['prepared', 'queued', 'uncertain', 'observed', 'cancel_pending', 'cancelled'].includes(r.status))) {
      throw new Error('desktop inbox checkpoint is invalid; automatic dispatch paused');
    }
    return r;
  }
  async save(record: DesktopInboxRecord) { await this.state.saveDesktopDelivery(`inbox-intent:${record.requestId}`, record); }
  assertBinding(r: DesktopInboxRecord, convId: string, identity: string, target: string) {
    if (r.convId !== convId || r.identityThreadId !== identity || r.targetThreadId !== target) {
      throw new Error('desktop inbox binding changed; automatic dispatch paused');
    }
  }
  async enqueue(input: { requestId: string; convId: string; identityThreadId: string; targetThreadId: string; text: string }) {
    if (await this.get(input.requestId)) throw new Error('desktop inbox already has an intent; no second queue add');
    let record: DesktopInboxRecord = { version: 1, requestId: input.requestId, convId: input.convId,
      identityThreadId: input.identityThreadId, targetThreadId: input.targetThreadId,
      marker: `[[relay-inbox:${input.requestId}]]`, clientId: `relay-desktop-${hash(key(input.requestId))}`,
      textHash: hash(input.text), status: 'prepared' };
    await this.save(record); // This outer intent also covers a crash before DesktopDelivery prepares.
    try {
      const receipt = await this.delivery.deliver({ key: key(input.requestId), threadId: input.targetThreadId, text: input.text });
      record = { ...record, status: 'queued', queuedSubmissionId: receipt.queuedSubmissionId };
      await this.save(record);
    } catch {
      await this.save({ ...record, status: 'uncertain' });
    }
    return record;
  }
  async observe(record: DesktopInboxRecord): Promise<any | null> {
    let history;
    try { history = await this.codex.desktopThreadRead(record.targetThreadId); }
    catch { throw new Error('desktop inbox complete history is unavailable; execution remains unverified'); }
    const matches: any[] = [];
    for (const turn of history.turns) {
      for (const item of turn.items) {
        if (item.type !== 'userMessage') continue;
        const exactClient = item.clientId === record.clientId;
        const texts = item.content.filter((p: any) => p.type === 'text');
        const exactBody = item.content.length === 1 && texts.length === 1 && hash(texts[0].text) === record.textHash;
        const marker = texts.some((p: any) => p.text.includes(record.marker));
        if (!exactClient && !marker) continue;
        // Client IDs are correlation, not origin. Never accept ID-only matching
        // with changed content, or a marker quoted in another user's message.
        if (!exactBody || !marker || (item.clientId != null && !exactClient)) {
          throw new Error('desktop inbox history correlation conflicts with its durable intent');
        }
        if (turn.items.filter((candidate: any) => candidate.type === 'userMessage').length !== 1) {
          throw new Error('desktop inbox turn contains multiple user messages; its answer cannot be assigned to one request');
        }
        matches.push(turn);
      }
    }
    if (matches.length > 1 || (record.turnId && matches.length === 1 && matches[0].id !== record.turnId)) {
      throw new Error('desktop inbox history has ambiguous execution; no automatic result');
    }
    if (record.turnId && matches.length === 0) throw new Error('desktop inbox previously observed turn is unavailable');
    return matches[0] ?? null;
  }
  async cancel(record: DesktopInboxRecord): Promise<boolean> {
    record.cancelRequested = true;
    record.status = 'cancel_pending';
    await this.save(record);
    // Check complete history first: an owner may already have consumed it.
    if (await this.observe(record)) return false;
    const entry = await this.queue.lookup({ threadId: record.targetThreadId, clientUserMessageId: record.clientId });
    if (!entry) return false; // consumed/unknown never means safely cancelled
    if (record.queuedSubmissionId && entry.id !== record.queuedSubmissionId) throw new Error('desktop inbox queue identity changed');
    const text = (entry.input[0] as any)?.text;
    if (typeof text !== 'string' || hash(text) !== record.textHash || !desktopSubmissionMatches(entry, text)) {
      throw new Error('desktop inbox queue content changed; cannot delete');
    }
    record.queuedSubmissionId = entry.id;
    await this.save(record);
    const result = await this.codex.rpc('thread/queue/delete', { threadId: record.targetThreadId, queuedSubmissionId: entry.id });
    if (result?.deleted !== true) return false;
    // Deletion's true receipt is authoritative only for that exact queue item;
    // a later history observation still wins over a cancellation claim.
    if (await this.observe(record)) return false;
    record.status = 'cancelled';
    await this.save(record);
    return true;
  }
}
