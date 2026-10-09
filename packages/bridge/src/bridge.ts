/**
 * Bridge core: turns remote requests into local Codex turns and reports real
 * terminal results back, per docs/mechanism-design.md §3.2/§4/§5.
 *
 * Invariants:
 *  - Never writes ~/.codex (it only uses App Server interfaces).
 *  - One dedupe record per request_id; a retried delivery never starts twice.
 *  - Startup intent written before turn/start; turnId persisted right after.
 *  - Results that cannot be sent (relay down) go to a local outbox and replay.
 *  - On result.available for a conversation this bridge owns, it *pushes* the
 *    result into that conversation as a new turn (T1 delivery).
 */
import { CodexClient, lastAgentMessage, type TurnTerminal } from './codexClient.js';
import { LocalState, type DispatchRecord } from './state.js';
import { RelayClient } from './relayClient.js';
import type { WsEvent } from '@relay/protocol';

export interface Binding {
  alias: string;
  role: string;
  task: string;
  project: string;
  ownerLabel?: string;
  threadId?: string | null;
  convId?: string | null;
}

export interface BridgeOptions {
  relayUrl: string;
  deviceToken: string;
  profile: string;
  codexCommand: string;
  codexArgs: string[];
  model: string;
  cwd: string;
  bindings: Binding[];
  allowSources?: string[];
  turnTimeoutMs?: number;
  onLog?: (level: string, message: string) => void;
  heartbeatMs?: number;
  maxBackoffMs?: number;
}

export class Bridge {
  private state!: LocalState;
  private codex!: CodexClient;
  private relay!: RelayClient;
  private byAlias = new Map<string, Binding>();
  private byConv = new Map<string, Binding>();
  private turnWaiters = new Map<string, (t: TurnTerminal) => void>();
  private stopping = false;

  constructor(private opts: BridgeOptions) {}

  private log(level: string, message: string) {
    this.opts.onLog?.(level, message);
  }

  get relayClient(): RelayClient {
    return this.relay;
  }
  get localState(): LocalState {
    return this.state;
  }
  get codexClient(): CodexClient {
    return this.codex;
  }

  async start(state: LocalState): Promise<void> {
    this.state = state;
    this.codex = new CodexClient({
      command: this.opts.codexCommand,
      args: this.opts.codexArgs,
      cwd: this.opts.cwd,
    });
    this.codex.on('notification', (n: any) => this.onNotification(n));
    this.codex.on('exit', (code: number) => this.log('warn', `codex exited (${code})`));
    await this.codex.start();

    this.relay = new RelayClient({
      baseUrl: this.opts.relayUrl,
      deviceToken: this.opts.deviceToken,
      heartbeatMs: this.opts.heartbeatMs,
      maxBackoffMs: this.opts.maxBackoffMs,
      onLog: (l, m) => this.log(l, m),
      onEvent: (e) => void this.onEvent(e),
    });

    // 1) Ensure a thread per binding and register it with the relay.
    for (const b of this.opts.bindings) {
      await this.ensureBinding(b);
    }

    // 2) Reconcile any dispatch interrupted by a previous crash (§5.3).
    await this.reconcile();

    // 3) Flush anything queued while the relay was unreachable.
    await this.flushOutbox();

    // 4) Connect the device channel (push + heartbeat).
    this.relay.connect();
  }

  private async ensureBinding(b: Binding): Promise<void> {
    const existing = await this.state.getBinding(b.alias);
    if (!b.threadId && existing?.thread_id) b.threadId = existing.thread_id;
    if (!b.threadId) {
      b.threadId = await this.codex.threadStart(this.opts.model, this.opts.cwd);
      this.log('info', `created thread for ${b.alias}: ${b.threadId}`);
    }
    this.byAlias.set(b.alias, b);

    // Register (idempotent on the relay: same device+profile+thread → same conv).
    const row = await this.relay.registerRoster({
      profile: this.opts.profile,
      thread_id: b.threadId,
      alias: b.alias,
      role: b.role,
      task: b.task,
      project: b.project,
      owner_label: b.ownerLabel ?? 'owner',
      tier: 't1_managed',
      ...(this.opts.allowSources ? { allow_sources: this.opts.allowSources } : {}),
    });
    b.convId = row.conv_id;
    this.byConv.set(row.conv_id, b);
    await this.state.saveBinding(b.alias, this.opts.profile, b.threadId, row.conv_id);
    this.log('info', `${b.alias} registered as ${row.conv_id}`);
  }

  /** Register a T1 conversation after its thread already exists. */
  bindConv(convId: string, b: Binding): void {
    this.byConv.set(convId, b);
  }

  // ---- event handling -----------------------------------------------------

  private async onEvent(e: WsEvent): Promise<void> {
    if (e.event === 'request.available') {
      const requestId = String(e.payload.request_id);
      if (e.payload.control === 'cancel') return void this.onCancel(requestId);
      return void this.processRequest(requestId);
    }
    if (e.event === 'result.available') {
      const requestId = String(e.payload.request_id);
      return void this.deliverResultToConversation(requestId);
    }
    if (e.event === 'revoked') {
      this.log('warn', 'device revoked by relay');
    }
  }

  private onNotification(n: any): void {
    if (n.method === 'turn/completed') {
      const turn = n.params?.turn;
      if (!turn?.id) return;
      const waiter = this.turnWaiters.get(turn.id);
      if (waiter) {
        this.turnWaiters.delete(turn.id);
        waiter({
          turnId: turn.id,
          status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed',
          text: lastAgentMessage(turn),
          raw: turn,
        });
      }
    }
  }

  /** §5.3 dedupe + drive one request to a reported terminal state. */
  async processRequest(requestId: string): Promise<void> {
    const rec = await this.state.get(requestId);
    if (rec && ['running', 'completed', 'interrupted', 'result_pending_verify'].includes(rec.status)) {
      this.log('info', `dedupe: ${requestId} already ${rec.status}`);
      return;
    }

    let request: any;
    try {
      request = await this.relay.getRequest(requestId);
    } catch (e) {
      this.log('warn', `cannot fetch ${requestId}: ${(e as Error).message}`);
      return;
    }
    const binding = this.byConv.get(request.to_conv);
    if (!binding || !binding.threadId) {
      this.log('warn', `no local thread for ${request.to_conv}; ignoring ${requestId}`);
      return;
    }

    try {
      await this.relay.claim(requestId);
    } catch (e) {
      this.log('warn', `claim failed for ${requestId}: ${(e as Error).message}`);
    }

    const marker = `relay:${requestId}`;
    await this.state.intent(requestId, request.root_request_id, request.to_conv, binding.threadId, marker);

    const text = `[[${marker}]]\n${request.type} from ${request.from_conv}\n\n${request.body}`;
    let turnId: string;
    try {
      turnId = await this.codex.turnStart(binding.threadId, text, this.opts.model);
    } catch (e) {
      // The turn never started locally: record intent as failed so a retry is
      // safe (no execution has happened).
      await this.state.finish(requestId, 'failed');
      await this.submitWithOutbox(requestId, {
        conv_id: request.to_conv,
        kind: 'STATUS',
        exec_status: 'failed',
        body: `bridge failed to start turn: ${(e as Error).message}`,
      });
      return;
    }
    await this.state.recordTurn(requestId, turnId);
    try {
      await this.relay.start(requestId, turnId);
    } catch (e) {
      this.log('warn', `start report failed for ${requestId}: ${(e as Error).message}`);
    }

    const terminal = await this.waitForTurn(turnId, binding.threadId!);
    const exec = terminal.status;
    await this.state.finish(requestId, exec);
    await this.submitWithOutbox(requestId, {
      conv_id: request.to_conv,
      kind: 'RESULT',
      exec_status: exec,
      turn_id: turnId,
      body: terminal.text || `(no agent message; status=${exec})`,
      evidence: `mock://threads/${binding.threadId}/turns/${turnId}`,
      result_missing: exec !== 'completed' || !terminal.text,
    });
    this.log('info', `completed ${requestId} turn=${turnId} status=${exec}`);
  }

  private async onCancel(requestId: string): Promise<void> {
    const rec = await this.state.get(requestId);
    if (!rec || !rec.turn_id || rec.status !== 'running') return;
    const binding = this.byConv.get(rec.to_conv);
    if (!binding?.threadId) return;
    try {
      await this.codex.turnInterrupt(binding.threadId, rec.turn_id);
      this.log('info', `interrupted ${requestId}`);
    } catch (e) {
      this.log('warn', `interrupt failed for ${requestId}: ${(e as Error).message}`);
    }
  }

  /** T1 push delivery: a result for a conversation we own becomes a new turn. */
  private async deliverResultToConversation(requestId: string): Promise<void> {
    const result = await this.relay.readResult(requestId);
    const conv = result.request?.to_conv ?? result.request?.return_addr;
    const binding = conv ? this.byConv.get(conv) : undefined;
    const owner = result.request ? this.byConv.get(result.request.return_addr) : undefined;
    const target = owner ?? binding;
    if (!target?.threadId) return;
    const latest = (result.results ?? []).filter((r: any) => r.kind === 'RESULT').pop();
    if (!latest) return;
    const text = `[[relay-result:${requestId}]]\nRESULT for ${requestId} (from ${result.request.to_conv})\n\n${latest.body}`;
    try {
      const turnId = await this.codex.turnStart(target.threadId, text, this.opts.model);
      this.log('info', `delivered result ${requestId} into ${result.request.return_addr} turn=${turnId}`);
    } catch (e) {
      this.log('warn', `failed to deliver result ${requestId}: ${(e as Error).message}`);
    }
  }

  private waitForTurn(turnId: string, threadId: string): Promise<TurnTerminal> {
    const timeoutMs = this.opts.turnTimeoutMs ?? 120_000;
    return new Promise((resolve) => {
      let done = false;
      const finish = (t: TurnTerminal) => {
        if (done) return;
        done = true;
        this.turnWaiters.delete(turnId);
        clearInterval(poll);
        clearTimeout(timer);
        resolve(t);
      };
      this.turnWaiters.set(turnId, finish);
      const poll = setInterval(async () => {
        try {
          const thread = await this.codex.threadRead(threadId, true);
          const turn = (thread.turns ?? []).find((x: any) => x.id === turnId);
          if (turn && turn.status && turn.status !== 'inProgress') {
            finish({
              turnId,
              status: turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed',
              text: lastAgentMessage(turn),
              raw: turn,
            });
          }
        } catch {
          /* keep polling */
        }
      }, 300);
      const timer = setTimeout(() => {
        // §5.2: no expected report → keep the execution terminal state and mark
        // the result as missing rather than claiming business completion.
        finish({ turnId, status: 'failed', text: '', raw: { status: 'timeout' } });
      }, timeoutMs);
    });
  }

  // ---- §5.3 crash-window reconciliation ----------------------------------

  async reconcile(): Promise<{ adopted: number; ambiguous: number; restarted: number; pending: number }> {
    const result = { adopted: 0, ambiguous: 0, restarted: 0, pending: 0 };
    for (const rec of await this.state.listUnfinished()) {
      const binding = this.byConv.get(rec.to_conv);
      if (!binding?.threadId) {
        await this.state.finish(rec.request_id, 'result_pending_verify');
        result.pending++;
        continue;
      }
      if (rec.turn_id) {
        // We already know the turn: just read its terminal state.
        const thread = await this.codex.threadRead(binding.threadId, true).catch(() => null);
        const turn = thread?.turns?.find((x: any) => x.id === rec.turn_id);
        if (turn && turn.status && turn.status !== 'inProgress') {
          const status = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed';
          await this.state.finish(rec.request_id, status);
          await this.submitWithOutbox(rec.request_id, {
            conv_id: rec.to_conv,
            kind: 'RESULT',
            exec_status: status,
            turn_id: rec.turn_id,
            body: lastAgentMessage(turn) || `(recovered; status=${status})`,
            evidence: `mock://threads/${binding.threadId}/turns/${rec.turn_id}`,
            result_missing: status !== 'completed',
          });
          result.adopted++;
        } else {
          await this.state.finish(rec.request_id, 'result_pending_verify');
          result.pending++;
        }
        continue;
      }
      // status 'starting' with no turnId: search thread history by marker.
      const thread = await this.codex.threadRead(binding.threadId, true).catch(() => null);
      const matches = (thread?.turns ?? []).filter((t: any) =>
        (t.items ?? []).some((i: any) => typeof i.text === 'string' && i.text.includes(rec.marker)),
      );
      if (matches.length === 1) {
        const turn = matches[0];
        await this.state.recordTurn(rec.request_id, turn.id);
        const status = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed';
        if (turn.status === 'inProgress') {
          result.pending++;
          continue;
        }
        await this.state.finish(rec.request_id, status);
        await this.submitWithOutbox(rec.request_id, {
          conv_id: rec.to_conv,
          kind: 'RESULT',
          exec_status: status,
          turn_id: turn.id,
          body: lastAgentMessage(turn) || `(adopted; status=${status})`,
          evidence: `mock://threads/${binding.threadId}/turns/${turn.id}`,
        });
        result.adopted++;
      } else if (matches.length === 0) {
        // Positively no execution happened → safe to start.
        await this.processRequest(rec.request_id);
        result.restarted++;
      } else {
        // §5.3 无法唯一确认 → 结果待核对, pause auto-restart.
        await this.state.finish(rec.request_id, 'result_pending_verify');
        result.ambiguous++;
      }
    }
    return result;
  }

  // ---- outbox -------------------------------------------------------------

  private async submitWithOutbox(requestId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.relay.submitResult(requestId, payload);
    } catch (e) {
      this.log('warn', `relay submit failed, queueing ${requestId}: ${(e as Error).message}`);
      await this.state.enqueue('result', requestId, payload);
    }
  }

  async flushOutbox(): Promise<number> {
    let sent = 0;
    for (const item of await this.state.pendingOutbox()) {
      try {
        await this.relay.submitResult(item.request_id, item.payload);
        await this.state.deleteOutbox(item.id);
        sent++;
      } catch {
        break; // still offline; keep order
      }
    }
    if (sent) this.log('info', `flushed ${sent} queued results`);
    return sent;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.relay?.close();
    await this.codex?.close();
  }
}
