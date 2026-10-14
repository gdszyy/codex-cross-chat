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
 *
 * Scope note (mechanism-design §0.5 / §11 T1-only + §6.1 T2-no-heartbeat):
 * this bridge only ever creates and reads **T1 managed** threads. `thread/read`
 * / `thread/resume` / `turn/start` on paginated T2 desktop threads fail closed
 * upstream, so the bridge never touches them; T2 conversations, if any, are
 * represented on the relay side with `delivery_mode=manual_pull` and carry no
 * heartbeat (presence is `last_pull_at` only).
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
  deviceToken?: string;
  pairing?: { code: string; alias: string; role: string; task: string; ownerLabel?: string };
  /** Must atomically persist the credential + full binding before any WS opens. */
  persistPairing?: (receipt: PairingReceipt) => Promise<void>;
  preparePairing?: () => Promise<void>;
  profile: string;
  codexCommand: string;
  codexArgs: string[];
  codexEnv?: Record<string, string>;
  codexShell?: boolean;
  model: string;
  cwd: string;
  bindings: Binding[];
  allowSources?: string[];
  turnTimeoutMs?: number;
  onLog?: (level: string, message: string) => void;
  heartbeatMs?: number;
  maxBackoffMs?: number;
  /** Read results explicitly without spending another model turn on this device. */
  resultDeliveryMode?: 'push_turn' | 'manual_read';
}

export interface PairingReceipt {
  device_id: string;
  device_token: string;
  binding: Binding;
  pairing_id: string;
  peer_conv_id: string;
}

export class Bridge {
  private state!: LocalState;
  private codex!: CodexClient;
  private relay!: RelayClient;
  private byAlias = new Map<string, Binding>();
  private byConv = new Map<string, Binding>();
  private turnWaiters = new Map<string, (t: TurnTerminal) => void>();
  private inFlight = new Set<string>();
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
      env: this.opts.codexEnv,
      shell: this.opts.codexShell,
    });
    this.codex.on('notification', (n: any) => this.onNotification(n));
    this.codex.on('exit', (code: number) => this.log('warn', `codex exited (${code})`));
    await this.codex.start();

    // C5: never hard-code the model — read what this CLI actually offers and
    // flag a mismatch (thread/start accepts any string, so a wrong model only
    // surfaces at turn time; see m1-compat-report §3 局限 1).
    const models = await this.codex.modelList().catch(() => [] as string[]);
    if (models.length) {
      this.log('info', `model/list: ${models.join(', ')}`);
      if (this.opts.model && !models.includes(this.opts.model)) {
        this.log('warn', `configured model ${this.opts.model} is not in model/list`);
      }
    }

    if (this.opts.pairing) await this.bootstrapPairing();
    if (!this.opts.deviceToken) throw new Error('device credential required; use pairing bootstrap');

    this.relay = new RelayClient({
      baseUrl: this.opts.relayUrl,
      deviceToken: this.opts.deviceToken,
      heartbeatMs: this.opts.heartbeatMs,
      maxBackoffMs: this.opts.maxBackoffMs,
      onLog: (l, m) => this.log(l, m),
      onEvent: (e) => void this.onEvent(e),
      // B2: durable cursor + a pull on every reconnect so nothing enqueued while
      // this bridge was down is silently lost.
      cursorStore: {
        get: () => this.state.getCursor(),
        set: (v) => this.state.setCursor(v),
      },
      onConnected: () => void this.safe(() => this.pullInbox().then(() => undefined), 'reconnectPull'),
      // §2.2: advertise the hosted conversations with every heartbeat so their
      // presence.online follows the bridge, not just the device connection.
      convsProvider: () => [...this.byConv.keys()].filter((c): c is string => Boolean(c)),
    });

    // 1) Ensure a thread per binding and register it with the relay.
    for (const b of this.opts.bindings) {
      await this.ensureBinding(b);
    }

    // 2) Reconcile any dispatch interrupted by a previous crash (§5.3).
    await this.reconcile();

    // 3) Flush anything queued while the relay was unreachable.
    await this.flushOutbox();

    // 3b) B2: pull anything that arrived while this bridge was offline —
    //     a restart must not require a fresh push event to notice back work.
    const pulled = await this.pullInbox();
    if (pulled) this.log('info', `startup inbox pull started ${pulled} request(s)`);

    // 4) Connect the device channel (push + heartbeat).
    this.relay.connect();
  }

  /**
   * Pull pending requests for every conversation this bridge owns.
   * Used at startup and on every reconnect (a device that was down receives no
   * events; the inbox is the authoritative back-stop).
   */
  async pullInbox(): Promise<number> {
    let started = 0;
    for (const b of this.byConv.values()) {
      if (!b.convId) continue;
      let inbox: any;
      try {
        inbox = await this.relay.inbox(b.convId);
      } catch (e) {
        this.log('warn', `inbox pull failed for ${b.convId}: ${(e as Error).message}`);
        continue;
      }
      for (const r of inbox.pending_for_me ?? []) {
        if (this.stopping) return started;
        await this.processRequest(r.request_id);
        started++;
      }
    }
    return started;
  }

  private async ensureBinding(b: Binding): Promise<void> {
    const existing = await this.state.getBinding(b.alias);
    if (existing && existing.profile !== this.opts.profile) throw new Error('saved binding profile differs from config; recovery paused');
    if (existing?.thread_id && b.threadId && existing.thread_id !== b.threadId) throw new Error('saved thread differs from config; recovery paused');
    if (!b.threadId && existing?.thread_id) b.threadId = existing.thread_id;
    if (!b.threadId) {
      b.threadId = await this.codex.threadStart(this.opts.model, this.opts.cwd, b.alias);
      // Keep the stable local thread even if registration fails or the process
      // stops. Never start another thread just because the relay was offline.
      await this.state.saveBinding(b.alias, this.opts.profile, b.threadId);
      this.log('info', `created thread for ${b.alias}: ${b.threadId}`);
    } else {
      // thread/read only reads persisted history; it does not attach the
      // thread to this new App Server process for turn/start. Missing history
      // is a blocking recovery error, never permission to replace the binding.
      await this.codex.threadResume(b.threadId);
      this.log('info', `resumed thread for ${b.alias}: ${b.threadId}`);
    }
    this.byAlias.set(b.alias, b);

    let current: any;
    try { current = await this.relay.me({ profile: this.opts.profile, thread_id: b.threadId }); }
    catch (e) { if ((e as any).code !== 'unbound') throw e; }
    if (!current?.conv_id) current = undefined;
    const expectedConv = b.convId ?? existing?.conv_id;
    if (expectedConv && current?.conv_id !== expectedConv) throw new Error('saved conversation binding unavailable or changed; recovery paused');
    if (current && current.project !== b.project) throw new Error('existing conversation project differs from config; registration paused');

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
      ...(this.opts.allowSources !== undefined ? { allow_sources: this.opts.allowSources }
        : current ? { allow_sources: current.allow_sources } : {}),
    });
    b.convId = row.conv_id;
    this.byConv.set(row.conv_id, b);
    await this.state.saveBinding(b.alias, this.opts.profile, b.threadId, row.conv_id);
    this.log('info', `${b.alias} registered as ${row.conv_id}`);
  }

  private async bootstrapPairing(): Promise<void> {
    const p = this.opts.pairing!;
    if (!this.opts.persistPairing) throw new Error('pairing requires durable config persistence');
    await this.opts.preparePairing?.();
    let receipt = await this.state.getBootstrap(p.alias);
    if (receipt?.status === 'redeemed') {
      throw new Error('pairing already redeemed; restart using the saved config without a pairing code');
    }
    if (receipt && receipt.status !== 'ready') {
      throw new Error('pairing outcome unknown; inspect saved config/relay before retrying (no automatic redemption)');
    }
    if (!receipt) {
      await this.state.saveBootstrap(p.alias, { status: 'creating_thread' });
      const threadId = await this.codex.threadStart(this.opts.model, this.opts.cwd, p.alias);
      await this.state.saveBinding(p.alias, this.opts.profile, threadId);
      receipt = { status: 'ready', thread_id: threadId };
      await this.state.saveBootstrap(p.alias, receipt);
    } else {
      await this.codex.threadResume(receipt.thread_id);
    }
    // Write intent BEFORE making a one-shot request. A timeout/crash can mean
    // the invitation was consumed: startup must not issue another request.
    await this.state.saveBootstrap(p.alias, { ...receipt, status: 'redeeming' });
    const client = new RelayClient({ baseUrl: this.opts.relayUrl, deviceToken: this.opts.deviceToken });
    const result = await client.redeem({ code: p.code, profile: this.opts.profile, thread_id: receipt.thread_id,
      alias: p.alias, role: p.role, task: p.task, ...(p.ownerLabel ? { owner_label: p.ownerLabel } : {}) });
    const token = result.device?.device_token ?? this.opts.deviceToken;
    const row = result.conversation;
    if (!token || !result.device?.device_id || !row?.conv_id || !row.project || !result.pairing_id || !result.peer_conv_id) {
      throw new Error('pairing response incomplete; outcome unknown, automatic retry disabled');
    }
    const b: Binding = { alias: p.alias, role: p.role, task: p.task, ownerLabel: p.ownerLabel,
      project: row.project, threadId: receipt.thread_id, convId: row.conv_id };
    await this.opts.persistPairing({ device_id: result.device.device_id, device_token: token, binding: b,
      pairing_id: result.pairing_id, peer_conv_id: result.peer_conv_id });
    await this.state.saveBinding(b.alias, this.opts.profile, b.threadId!, b.convId);
    await this.state.saveBootstrap(p.alias, { status: 'redeemed', thread_id: b.threadId, conv_id: b.convId,
      pairing_id: result.pairing_id, peer_conv_id: result.peer_conv_id });
    this.opts.deviceToken = token;
    this.opts.bindings = [...this.opts.bindings.filter((x) => x.alias !== b.alias), b];
    this.opts.pairing = undefined;
    this.log('info', `paired ${b.convId} with ${result.peer_conv_id}`);
  }

  /** Register a T1 conversation after its thread already exists. */
  bindConv(convId: string, b: Binding): void {
    this.byConv.set(convId, b);
  }

  // ---- event handling -----------------------------------------------------

  private async onEvent(e: WsEvent): Promise<void> {
    if (e.event === 'request.available') {
      const requestId = String(e.payload.request_id);
      if (e.payload.control === 'cancel') return this.safe(() => this.onCancel(requestId), 'cancel');
      return this.safe(() => this.processRequest(requestId), 'processRequest');
    }
    if (e.event === 'result.available') {
      const requestId = String(e.payload.request_id);
      return this.safe(() => this.deliverResultToConversation(requestId), 'deliverResult');
    }
    if (e.event === 'revoked') {
      this.log('warn', 'device revoked by relay');
    }
  }

  /**
   * Run background work without leaking an unhandled rejection when the bridge
   * is stopping mid-flight (the local store may already be closed by then).
   */
  private async safe(fn: () => Promise<void>, label: string): Promise<void> {
    if (this.stopping) return;
    try {
      await fn();
    } catch (e) {
      if (!this.stopping) this.log('warn', `${label} failed: ${(e as Error).message}`);
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
    if (this.stopping) return;
    // Guard against concurrent triggers for the same request (a WS event plus a
    // startup/reconnect inbox pull) starting the same turn twice.
    if (this.inFlight.has(requestId)) {
      this.log('info', `dedupe: ${requestId} already in flight`);
      return;
    }
    this.inFlight.add(requestId);
    try {
      await this.processRequestInner(requestId);
    } finally {
      this.inFlight.delete(requestId);
    }
  }

  private async processRequestInner(requestId: string): Promise<void> {
    const rec = await this.state.get(requestId);
    if (rec && ['running', 'completed', 'interrupted', 'failed', 'result_pending_verify', 'abandoned'].includes(rec.status)) {
      this.log('info', `dedupe: ${requestId} already ${rec.status}`);
      return;
    }

    // §4 step 3 order: write the local receipt record FIRST, then claim
    // ("device received"). The status endpoint (§9 #11) exposes to_conv without
    // the body, which is exactly what the intent row needs; the body itself only
    // arrives with the claim, and is deliberately absent from the status read.
    let meta: any;
    try {
      meta = await this.relay.getRequest(requestId);
    } catch (e) {
      this.log('warn', `cannot read ${requestId}: ${(e as Error).message}`);
      return;
    }
    const binding = this.byConv.get(meta.to_conv);
    if (!binding || !binding.threadId) {
      this.log('warn', `no local thread for ${meta.to_conv}; ignoring ${requestId}`);
      return;
    }
    const marker = `relay:${requestId}`;
    await this.state.intent(requestId, meta.root_request_id, meta.to_conv, binding.threadId, marker);

    // Now claim (the executor's delivery point) → the full row *including* body.
    let request: any;
    try {
      request = await this.relay.claim(requestId);
    } catch (e) {
      this.log('warn', `cannot claim ${requestId}: ${(e as Error).message}`);
      return;
    }

    const text = `[[${marker}]]\n${request.type} from ${request.from_conv}\n\n${request.body}`;
    try {
      // Claim is only a receipt. Acquire the current ACL-backed launch permit
      // before spending a local model turn; unpair between claim and here
      // must prevent execution. A successful permit is durable/in-flight.
      await this.relay.authorizeStart(requestId);
    } catch {
      await this.state.finish(requestId, 'abandoned');
      this.log('warn', `launch not authorized for ${requestId}; no local turn started`);
      return;
    }
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
      evidence: `codex-thread:${binding.threadId}#turn:${turnId}`,
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
    if (this.stopping) return;
    if (this.opts.resultDeliveryMode === 'manual_read') {
      this.log('info', `result available for ${requestId}; read explicitly (no local model turn)`);
      return;
    }
    const result = await this.relay.readResult(requestId);
    const owner = result.request ? this.byConv.get(result.request.return_addr) : undefined;
    if (!owner?.threadId) return;
    // §5.4: delivery is idempotent per item — a repeated event (or a STATUS that
    // arrives after a RESULT) must not re-push the same payload. The guard is
    // persisted so a restart cannot re-push either.
    const items = (result.results ?? []).filter((r: any) => r.kind === 'RESULT' || r.kind === 'STATUS');
    const latest = items[items.length - 1];
    if (!latest) return;
    const prev = await this.state.getDelivered(requestId);
    if (prev === latest.result_id) return;
    const text = `[[relay-result:${requestId}]]\n${latest.kind} for ${requestId} (from ${result.request.to_conv})\n\n${latest.body}`;
    try {
      const turnId = await this.codex.turnStart(owner.threadId, text, this.opts.model);
      await this.state.markDelivered(requestId, latest.result_id);
      this.log('info', `delivered ${latest.kind} ${requestId} into ${result.request.return_addr} turn=${turnId}`);
    } catch (e) {
      this.log('warn', `failed to deliver ${requestId}: ${(e as Error).message}`);
    }
  }

  private waitForTurn(turnId: string, threadId: string): Promise<TurnTerminal> {
    // T1-only: this thread was created by this bridge and is `historyMode:
    // legacy`, which is the only class where thread/read returns turns
    // (mechanism-design §0.5 wall). T2 paginated threads are never read.
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
            evidence: `codex-thread:${binding.threadId}#turn:${rec.turn_id}`,
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
      if (!thread || thread.id !== binding.threadId || thread.historyMode !== 'legacy' || !Array.isArray(thread.turns)) {
        // A failed read is not positive evidence of an empty history. Starting
        // again here could duplicate work; require human reconciliation.
        await this.state.finish(rec.request_id, 'result_pending_verify');
        this.log('warn', `history unavailable for ${rec.request_id}; automatic replay paused`);
        result.pending++;
        continue;
      }
      const matches = thread.turns.filter((t: any) =>
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
          evidence: `codex-thread:${binding.threadId}#turn:${turn.id}`,
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
