import type { CodexClient } from './codexClient.js';
import { DesktopDelivery, type DesktopDeliveryState, type DesktopDeliveryReceipt } from './desktopDelivery.js';
import { NativeJobStore } from './nativeJobStore.js';

export interface NativeDeliveryInput {
  key: string; receiverThreadId: string; targetThreadId: string; text: string; legacyText?: string;
  requestId: string; resultId: string; localConvId: string;
}
export interface NativeDeliveryReceipt extends DesktopDeliveryReceipt {
  deliveryMode: 'native_task'; nativeJobId: string; desktopThreadId: string; receiverThreadId: string; nativeStatus: string;
}
/** Queue a job to a real native receiver. Only that receiver calls the host tool. */
export class NativeTaskDelivery {
  private queue: DesktopDelivery;
  private jobs: NativeJobStore;
  constructor(codex: Pick<CodexClient, 'rpc'>, _state: DesktopDeliveryState, inboxDir: string,
    private log: (level: string, message: string) => void = () => {}) {
    this.jobs = new NativeJobStore(inboxDir);
    this.queue = new DesktopDelivery(codex, this.jobs);
  }
  async verifyTargets(receiverThreadId: string, targetThreadId: string) {
    if (receiverThreadId === targetThreadId) throw new Error('Native receiver and destination must be different real tasks');
    await this.queue.verifyTarget(receiverThreadId);
    await this.queue.verifyTarget(targetThreadId);
  }
  async deliver(input: NativeDeliveryInput): Promise<NativeDeliveryReceipt> {
    await this.verifyTargets(input.receiverThreadId, input.targetThreadId);
    const job = await this.jobs.prepare({ key: `native-forward:${input.key}`, receiverThreadId: input.receiverThreadId,
      targetThreadId: input.targetThreadId, requestId: input.requestId, resultId: input.resultId,
      localConvId: input.localConvId, text: input.text }, input.legacyText);
    const priorClaim = await this.jobs.status(job.id);
    const priorQueue = await this.jobs.getDesktopDelivery(job.key);
    if (priorClaim && !priorQueue) {
      throw new Error('Native job already has a claim but its receiver queue receipt is missing; no second queue add');
    }
    // Stable routing metadata only. The receiver's separately authorized setup
    // owns the CLI entry point; moving this module cannot change queue hashes.
    const text = ['[[relay-native-job:v1]]', JSON.stringify({ inboxDir: this.jobs.dir, jobId: job.id,
      receiverThreadId: job.receiverThreadId, targetThreadId: job.targetThreadId }, null, 2)].join('\n\n');
    const receipt = await this.queue.deliver({ key: job.key, threadId: input.receiverThreadId, text });
    const claim = await this.jobs.status(job.id);
    this.log('info', 'native receiver queue accepted; native claim/submit and target UI visibility are separate');
    return { ...receipt, deliveryMode: 'native_task', nativeJobId: job.id, desktopThreadId: input.targetThreadId,
      receiverThreadId: input.receiverThreadId, nativeStatus: claim?.status ?? 'queued' };
  }
}
