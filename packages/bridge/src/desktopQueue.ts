/**
 * Public App Server queue adapter, verified against CLI 0.149.0.
 *
 * Only reads thread metadata and lists/adds queue submissions. It never starts,
 * resumes, forks or creates a thread and never starts a queued/model turn.
 * The caller owns an explicit configured thread UUID, durable intent/receipt,
 * authorization and cross-process serialization. clientUserMessageId is a
 * correlation key, NOT an assumed server-side idempotency guarantee.
 */
import type { CodexClient } from './codexClient.js';

export interface DesktopQueueInput {
  threadId: string;
  clientUserMessageId: string;
  text: string;
}

export interface DesktopQueueReceipt {
  queuedSubmissionId: string;
  accepted: true;
}

export interface DesktopQueuedSubmission {
  id: string;
  clientUserMessageId: string;
  input: unknown[];
}

export interface DesktopQueueTarget {
  id: string;
  historyMode: 'paginated';
  status: unknown;
}

export type DesktopQueueErrorCode = 'invalid_thread_id' | 'invalid_submission' | 'target_unavailable'
  | 'target_mismatch' | 'unsupported_history' | 'lookup_unavailable' | 'invalid_queue_response'
  | 'duplicate_client_id' | 'client_id_conflict' | 'acceptance_unknown';

/** Locally controlled diagnostics never echo queue text or raw server errors. */
export class DesktopQueueError extends Error {
  constructor(public readonly code: DesktopQueueErrorCode, message: string) {
    super(message);
    this.name = 'DesktopQueueError';
  }
}

const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateThreadId(threadId: string): void {
  if (typeof threadId !== 'string' || !THREAD_UUID.test(threadId)) {
    throw new DesktopQueueError('invalid_thread_id', 'Desktop queue requires an exact thread UUID, never a title or alias.');
  }
}

function validateClientId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new DesktopQueueError('invalid_submission', 'A stable nonempty clientUserMessageId is required.');
  }
}

function isSubmission(value: any): value is DesktopQueuedSubmission {
  return typeof value?.id === 'string' && Boolean(value.id) && typeof value.clientUserMessageId === 'string'
    && Array.isArray(value.input);
}

export function desktopSubmissionMatches(submission: DesktopQueuedSubmission, text: string): boolean {
  if (submission.input.length !== 1) return false;
  const item = submission.input[0] as any;
  return item?.type === 'text' && item.text === text
    && (item.text_elements === undefined || (Array.isArray(item.text_elements) && item.text_elements.length === 0))
    && Object.keys(item).every((key) => ['type', 'text', 'text_elements'].includes(key));
}

function receipt(entry: DesktopQueuedSubmission, text: string): DesktopQueueReceipt {
  if (!desktopSubmissionMatches(entry, text)) {
    throw new DesktopQueueError('client_id_conflict', 'Existing clientUserMessageId belongs to different queue content.');
  }
  return { queuedSubmissionId: entry.id, accepted: true };
}

export class DesktopQueueClient {
  private inFlight = new Map<string, { text: string; operation: Promise<DesktopQueueReceipt> }>();

  constructor(private readonly codex: Pick<CodexClient, 'rpc'>) {}

  async verifyTarget(threadId: string): Promise<DesktopQueueTarget> {
    validateThreadId(threadId);
    let response: any;
    try { response = await this.codex.rpc('thread/read', { threadId, includeTurns: false }); }
    catch { throw new DesktopQueueError('target_unavailable', 'Desktop queue target metadata is unavailable.'); }
    const thread = response?.thread;
    if (thread?.id !== threadId || thread.ephemeral === true) {
      throw new DesktopQueueError('target_mismatch', 'Desktop queue target identity or persistence does not match.');
    }
    if (thread.historyMode !== 'paginated') {
      throw new DesktopQueueError('unsupported_history', 'Desktop queue target must use paginated history.');
    }
    // A different process may own the active writer. Do not resume, cancel or
    // reinterpret this read-only process's notLoaded status as missing history.
    return { id: thread.id, historyMode: 'paginated', status: thread.status };
  }

  /** Full cursor scan, including pages after a match, to detect ambiguous IDs. */
  async lookup(input: { threadId: string; clientUserMessageId: string }): Promise<DesktopQueuedSubmission | null> {
    validateClientId(input.clientUserMessageId);
    await this.verifyTarget(input.threadId);
    let cursor: string | undefined;
    let match: DesktopQueuedSubmission | null = null;
    const seen = new Set<string>();
    for (;;) {
      let page: any;
      try {
        page = await this.codex.rpc('thread/queue/list', { threadId: input.threadId, limit: 100,
          ...(cursor !== undefined ? { cursor } : {}) });
      } catch { throw new DesktopQueueError('lookup_unavailable', 'Desktop queue inventory could not be completely read.'); }
      if (!Array.isArray(page?.data) || !page.data.every(isSubmission)) {
        throw new DesktopQueueError('invalid_queue_response', 'Desktop queue inventory has an unexpected shape.');
      }
      for (const entry of page.data as DesktopQueuedSubmission[]) {
        if (entry.clientUserMessageId !== input.clientUserMessageId) continue;
        if (match) throw new DesktopQueueError('duplicate_client_id', 'Multiple queue submissions share this clientUserMessageId.');
        match = entry;
      }
      if (page.nextCursor === null || page.nextCursor === undefined) return match;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || seen.has(page.nextCursor)) {
        throw new DesktopQueueError('invalid_queue_response', 'Desktop queue pagination did not advance.');
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  /**
   * First-attempt enqueue only. Persist intent BEFORE calling this method.
   * After an acceptance_unknown failure, use lookup for that SAME durable
   * client ID; absence from a later queue is not permission to call add again
   * (the desktop may already have consumed it).
   */
  async enqueue(input: DesktopQueueInput): Promise<DesktopQueueReceipt> {
    validateThreadId(input.threadId);
    validateClientId(input.clientUserMessageId);
    if (typeof input.text !== 'string' || !input.text.length) {
      throw new DesktopQueueError('invalid_submission', 'Desktop queue content must be a nonempty string.');
    }
    const key = JSON.stringify([input.threadId, input.clientUserMessageId]);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.text !== input.text) {
        throw new DesktopQueueError('client_id_conflict', 'Concurrent clientUserMessageId belongs to different queue content.');
      }
      return existing.operation;
    }
    const operation = this.enqueueOnce(input);
    this.inFlight.set(key, { text: input.text, operation });
    try { return await operation; }
    finally { this.inFlight.delete(key); }
  }

  private async enqueueOnce(input: DesktopQueueInput): Promise<DesktopQueueReceipt> {
    const prior = await this.lookup(input);
    if (prior) return receipt(prior, input.text);
    let result: any;
    try {
      // Text is JSON-RPC data; it never enters a command or shell argument.
      result = await this.codex.rpc('thread/queue/add', { threadId: input.threadId,
        clientUserMessageId: input.clientUserMessageId,
        input: [{ type: 'text', text: input.text, text_elements: [] }] });
    } catch {
      return this.recoverUnknown(input);
    }
    const entry = result?.queuedSubmission;
    if (!isSubmission(entry) || entry.clientUserMessageId !== input.clientUserMessageId || !desktopSubmissionMatches(entry, input.text)) {
      return this.recoverUnknown(input);
    }
    // This is an accepted queue submission, NOT delivered text or a model turn.
    return receipt(entry, input.text);
  }

  private async recoverUnknown(input: DesktopQueueInput): Promise<DesktopQueueReceipt> {
    let found: DesktopQueuedSubmission | null;
    try { found = await this.lookup(input); }
    catch (e) {
      if (e instanceof DesktopQueueError && e.code === 'duplicate_client_id') throw e;
      throw new DesktopQueueError('acceptance_unknown', 'Queue acceptance is unknown; inspect the same durable intent before retrying.');
    }
    if (found) return receipt(found, input.text);
    throw new DesktopQueueError('acceptance_unknown', 'Queue acceptance is unknown; no automatic second add was attempted.');
  }
}
