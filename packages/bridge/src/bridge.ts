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
 * Managed execution attaches only explicitly bound durable threads, independent
 * of history format. desktop_inbox queues to the existing desktop owner and
 * observes complete history without resuming it or starting its queued turns.
 */
import { CodexClient, lastAgentMessage, type TurnTerminal } from './codexClient.js';
import { LocalState, type DispatchRecord } from './state.js';
import { RelayClient } from './relayClient.js';
import { DesktopDelivery, DesktopDeliveryError, type DesktopDeliveryReceipt } from './desktopDelivery.js';
import { NativeTaskDelivery } from './nativeDelivery.js';
import { DesktopInbox } from './desktopInbox.js';
import { legacyDesktopReport, plainDesktopReport } from './desktopReport.js';
import type { WsEvent } from '@relay/protocol';

export interface Binding {
  alias: string;
  role: string;
  task: string;
  project: string;
  ownerLabel?: string;
  threadId?: string | null;
  convId?: string | null;
  desktopThreadId?: string | null;
  nativeReceiverThreadId?: string | null;
}

export interface BridgeOptions {
  relayUrl: string;
  deviceToken?: string;
  pairing?: { code: string; alias: string; role: string; task: string; ownerLabel?: string; desktopThreadId?: string };
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
  /** Queue acceptance alone does not confirm the report is visible in its target UI. */
  resultDeliveryMode?: 'push_turn' | 'manual_read' | 'desktop_queue' | 'native_task';
  /** Registered threadId remains identity; desktopThreadId is the existing owner-run executor. */
  executionMode?: 'managed' | 'desktop_inbox';
  nativeInboxDir?: string;
}

export interface DesktopReplayReceipt extends DesktopDeliveryReceipt {
  requestId: string;
  resultId: string;
  localConvId: string;
  deliveryMode?: 'native_task';
  nativeJobId?: string;
  desktopThreadId?: string;
  receiverThreadId?: string;
  nativeStatus?: string;
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
  private desktopDelivery?: DesktopDelivery;
  private nativeDelivery?: NativeTaskDelivery;
  private desktopInbox?: DesktopInbox;
  private desktopPoll?: NodeJS.Timeout;
  private desktopScan?: Promise<void>;
  private byAlias = new Map<string, Binding>();
  private byConv = new Map<string, Binding>();
  private turnWaiters = new Map<string, { threadId: string; refresh: () => Promise<void> }>();
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

  private isQueuedDeliveryMode(): boolean {
    return this.opts.resultDeliveryMode === 'desktop_queue' || this.opts.resultDeliveryMode === 'native_task';
  }

  private initializeDelivery(state: LocalState): void {
    const log = (level: string, message: string) => this.log(level, message);
    if (this.opts.executionMode === 'desktop_inbox') {
      this.desktopInbox = new DesktopInbox(this.codex, state);
      this.desktopDelivery = new DesktopDelivery(this.codex, state, log);
    } else if (this.opts.resultDeliveryMode === 'native_task') {
      this.nativeDelivery = new NativeTaskDelivery(this.codex, state, this.opts.nativeInboxDir!, log);
    } else if (this.opts.resultDeliveryMode === 'desktop_queue') {
      this.desktopDelivery = new DesktopDelivery(this.codex, state, log);
    }
  }

  private async verifyDeliveryTargets(binding: Binding): Promise<void> {
    if (this.nativeDelivery) {
      await this.nativeDelivery.verifyTargets(binding.nativeReceiverThreadId!, binding.desktopThreadId!);
    } else if (this.desktopDelivery) {
      await this.desktopDelivery.verifyTarget(binding.desktopThreadId!);
    }
  }

  private validateDesktopBindings(): void {
    if (this.opts.executionMode !== undefined && !['managed', 'desktop_inbox'].includes(this.opts.executionMode)) {
      throw new Error('unsupported execution mode');
    }
    if (this.opts.executionMode === 'desktop_inbox') {
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (this.opts.resultDeliveryMode !== undefined || this.opts.nativeInboxDir
        || this.opts.bindings.some((b) => b.nativeReceiverThreadId)) {
        throw new Error('desktop_inbox owns direct input/report delivery; remove legacy result delivery and receiver settings');
      }
      if (this.opts.pairing) {
        if (this.opts.bindings.length || !uuid.test(this.opts.pairing.desktopThreadId ?? '')) {
          throw new Error('desktop_inbox pairing requires an existing exact desktopThreadId and empty bindings');
        }
      } else {
        if (!this.opts.deviceToken || !this.opts.bindings.length || this.opts.bindings.some((b) =>
          !b.alias || !b.convId || !b.threadId || !uuid.test(b.desktopThreadId ?? ''))) {
          throw new Error('desktop_inbox requires existing identity bindings and exact desktop targets');
        }
        for (const field of ['alias', 'convId', 'threadId', 'desktopThreadId'] as const) {
          if (new Set(this.opts.bindings.map((b) => b[field])).size !== this.opts.bindings.length) {
            throw new Error('desktop_inbox requires unique identities and desktop targets');
          }
        }
      }
      return;
    }
    if (!this.isQueuedDeliveryMode()) return;
    if (!this.opts.deviceToken || this.opts.pairing || !this.opts.bindings.length
      || this.opts.bindings.some((b) => !b.alias || !b.threadId || !b.convId || !b.desktopThreadId)) {
      throw new Error('queued delivery requires an existing credential and complete existing bindings; pairing bootstrap is unavailable');
    }
    for (const field of ['alias', 'convId', 'threadId'] as const) {
      if (new Set(this.opts.bindings.map((b) => b[field])).size !== this.opts.bindings.length) {
        throw new Error('queued delivery requires unique binding aliases, conversations and execution threads');
      }
    }
    if (this.opts.resultDeliveryMode === 'native_task') {
      const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      if (!this.opts.nativeInboxDir || this.opts.bindings.some((b) => !uuid.test(b.desktopThreadId!)
        || !uuid.test(b.nativeReceiverThreadId ?? '')
        || b.desktopThreadId!.toLowerCase() === b.nativeReceiverThreadId!.toLowerCase())) {
        throw new Error('native_task requires an inbox directory and distinct exact receiver/desktop target UUIDs');
      }
    }
  }

  /** One-shot report delivery: no executor startup, registration or inbox work. */
  async startReplay(state: LocalState): Promise<void> {
    if (!this.isQueuedDeliveryMode()) throw new Error('desktop replay requires desktop_queue or native_task mode');
    this.validateDesktopBindings();
    this.state = state;
    this.codex = new CodexClient({ command: this.opts.codexCommand, args: this.opts.codexArgs,
      cwd: this.opts.cwd, env: this.opts.codexEnv, shell: this.opts.codexShell, experimentalApi: true });
    this.codex.on('exit', (code: number) => this.log('warn', `codex exited (${code})`));
    this.relay = new RelayClient({ baseUrl: this.opts.relayUrl, deviceToken: this.opts.deviceToken });
    try {
      await this.codex.start();
      this.initializeDelivery(state);
      for (const b of this.opts.bindings) {
        await this.verifyDeliveryTargets(b);
        let current: any;
        try { current = await this.relay.me({ conv_id: b.convId! }); }
        catch { throw new Error('desktop replay could not verify the authenticated conversation binding'); }
        if (current?.conv_id !== b.convId || current.profile !== this.opts.profile || current.thread_id !== b.threadId
          || current.project !== b.project) {
          throw new Error('desktop replay conversation identity differs from the existing configuration');
        }
        this.bindConv(b.convId!, b);
      }
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  async start(state: LocalState): Promise<void> {
    this.state = state;
    this.validateDesktopBindings();
    if (this.opts.executionMode === 'desktop_inbox') {
      const discovery = new RelayClient({ baseUrl: this.opts.relayUrl });
      if (!await discovery.supportsDesktopInbox()) {
        throw new Error('Relay desktop_inbox capability is unavailable; no claim, grant or queue add was attempted');
      }
    }
    this.codex = new CodexClient({
      command: this.opts.codexCommand,
      args: this.opts.codexArgs,
      cwd: this.opts.cwd,
      env: this.opts.codexEnv,
      shell: this.opts.codexShell,
      // Managed bindings may retain their identity while history becomes
      // paginated; full persisted-turn pagination requires explicit opt-in.
      experimentalApi: true,
    });
    this.codex.on('notification', (n: any) => this.onNotification(n));
    this.codex.on('exit', (code: number) => this.log('warn', `codex exited (${code})`));
    await this.codex.start();
    this.initializeDelivery(state);

    // C5: never hard-code the model — read what this CLI actually offers and
    // flag a mismatch (thread/start accepts any string, so a wrong model only
    // surfaces at turn time; see m1-compat-report §3 局限 1).
    const models = this.desktopInbox ? [] : await this.codex.modelList().catch(() => [] as string[]);
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
    if (this.desktopInbox) {
      this.desktopPoll = setInterval(() => {
        if (this.stopping || this.desktopScan) return;
        this.desktopScan = this.safe(async () => {
          await this.reconcile();
          await this.flushOutbox();
        }, 'desktopInboxObserve').finally(() => { this.desktopScan = undefined; });
      }, 1000);
    }
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
    if (this.desktopInbox) {
      // Keep the registered identity untouched. Do not resume or register the
      // former executor, and never take the desktop owner's writer lock.
      if (!b.threadId || !b.convId || !b.desktopThreadId) throw new Error('desktop_inbox identity is incomplete');
      if (existing?.conv_id && existing.conv_id !== b.convId) throw new Error('saved conversation differs from config');
      const current = await this.relay.me({ conv_id: b.convId });
      if (current?.conv_id !== b.convId || current.thread_id !== b.threadId || current.profile !== this.opts.profile
        || current.project !== b.project) throw new Error('desktop_inbox authenticated identity differs from configuration');
      await this.desktopInbox.verifyTarget(b.desktopThreadId);
      await this.state.saveBinding(b.alias, this.opts.profile, b.threadId, b.convId);
      this.byAlias.set(b.alias, b);
      this.bindConv(b.convId, b);
      return;
    }
    if (this.desktopDelivery || this.nativeDelivery) {
      if (!b.threadId || !(b.convId ?? existing?.conv_id) || !b.desktopThreadId) {
        throw new Error('queued delivery requires an existing exact execution thread, conversation and desktop target');
      }
      await this.verifyDeliveryTargets(b);
    }
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
      const threadId = this.desktopInbox ? p.desktopThreadId! : await this.codex.threadStart(this.opts.model, this.opts.cwd, p.alias);
      if (this.desktopInbox) await this.desktopInbox.verifyTarget(threadId);
      await this.state.saveBinding(p.alias, this.opts.profile, threadId);
      receipt = { status: 'ready', thread_id: threadId, ...(this.desktopInbox ? { execution_mode: 'desktop_inbox' } : {}) };
      await this.state.saveBootstrap(p.alias, receipt);
    } else {
      if (this.desktopInbox) {
        if (receipt.execution_mode !== 'desktop_inbox' || receipt.thread_id !== p.desktopThreadId) {
          throw new Error('pairing receipt execution target changed; automatic redemption paused');
        }
        await this.desktopInbox.verifyTarget(receipt.thread_id);
      } else {
        if (receipt.execution_mode === 'desktop_inbox') throw new Error('pairing receipt execution mode changed');
        await this.codex.threadResume(receipt.thread_id);
      }
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
      project: row.project, threadId: receipt.thread_id, convId: row.conv_id,
      ...(this.desktopInbox ? { desktopThreadId: receipt.thread_id } : {}) };
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
      const resultId = typeof e.payload.result_id === 'string' ? e.payload.result_id : undefined;
      return this.safe(() => this.deliverResultToConversation(requestId, resultId), 'deliverResult');
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
      if (waiter && waiter.threadId === n.params?.threadId) {
        // Notifications may contain a summary or empty item stub. Only a
        // complete persisted read of this same execution thread can settle it.
        void waiter.refresh();
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
    if (this.desktopInbox) return this.processDesktopRequest(requestId);
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

    let terminal: TurnTerminal;
    try { terminal = await this.waitForTurn(turnId, binding.threadId!); }
    catch {
      await this.state.finish(requestId, 'result_pending_verify');
      this.log('warn', 'execution history remains unverified; no terminal result fabricated or request replayed');
      return;
    }
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

  private async processDesktopRequest(requestId: string): Promise<void> {
    const inbox = this.desktopInbox!;
    const previous = await this.state.get(requestId);
    if (previous && ['completed', 'failed', 'interrupted', 'abandoned'].includes(previous.status)) return;
    const meta = await this.relay.getRequest(requestId);
    const b = this.byConv.get(meta.to_conv);
    if (!b?.threadId || !b.desktopThreadId || meta.request_id !== requestId || !Number.isFinite(meta.expires_at)) {
      throw new Error('desktop inbox request identity is unavailable');
    }
    let record = await inbox.get(requestId);
    if (!record) {
      // An intent from the old managed executor is not an unexecuted request.
      // Migration must never execute it again in the desktop owner.
      if (previous) {
        await this.state.finish(requestId, 'result_pending_verify');
        return;
      }
      if (meta.exec_status !== 'pending' || ['expired', 'rejected'].includes(meta.delivery_status) || meta.expires_at <= Date.now()) return;
      await this.state.intent(requestId, meta.root_request_id, meta.to_conv, b.desktopThreadId, `[[relay-inbox:${requestId}]]`);
      const request = await this.relay.claim(requestId);
      if (request.request_id !== requestId || request.to_conv !== b.convId || typeof request.body !== 'string') {
        throw new Error('desktop inbox claim identity differs from its binding');
      }
      await inbox.verifyTarget(b.desktopThreadId);
      const permit = await this.relay.authorizeStart(requestId, 'desktop_inbox');
      if (permit?.exec_status !== 'pending' || permit.started_at !== null || !Number.isFinite(permit.start_authorized_at)) {
        throw new Error('Relay does not support a pending desktop queue permit; no queue add attempted');
      }
      const text = [`[[relay-inbox:${requestId}]]`, `${request.type} from ${request.from_conv}`,
        '这是一条发给当前对话的跨设备请求。请在当前对话处理并回复；不创建其他执行对话或接收器。', request.body].join('\n\n');
      record = await inbox.enqueue({ requestId, convId: b.convId!, identityThreadId: b.threadId,
        targetThreadId: b.desktopThreadId, text });
      this.log('info', `desktop inbox queued or uncertain ${requestId}; owner execution remains unconfirmed`);
    }
    inbox.assertBinding(record, b.convId!, b.threadId, b.desktopThreadId);
    if (previous && previous.thread_id !== record.targetThreadId) throw new Error('desktop dispatch target differs from its checkpoint');
    if (record.status === 'cancelled') {
      await this.state.finish(requestId, 'abandoned');
      return;
    }
    const unavailable = ['expired', 'rejected'].includes(meta.delivery_status) || meta.expires_at <= Date.now()
      || record.cancelRequested === true;
    if (unavailable && !record.turnId) {
      if (await inbox.cancel(record)) await this.state.finish(requestId, 'abandoned');
      else await this.state.finish(requestId, 'result_pending_verify');
      return;
    }
    let turn: any;
    try { turn = await inbox.observe(record); }
    catch {
      await this.state.finish(requestId, 'result_pending_verify');
      this.log('warn', `desktop inbox history cannot verify ${requestId}; no second add or result`);
      return;
    }
    if (!turn) return; // queued/uncertain is not executed, even after a long wait
    record = { ...record, status: 'observed', turnId: turn.id };
    await inbox.save(record);
    await this.state.recordTurn(requestId, turn.id);
    try {
      const started = await this.relay.start(requestId, turn.id);
      if (started?.turn_id !== turn.id) {
        await this.state.finish(requestId, 'result_pending_verify');
        return;
      }
      {
        // STATUS can change the request row both before and after a RESULT.
        // Always verify the canonical report, independent of current row status.
        const snapshot = await this.relay.readResult(requestId);
        if (snapshot?.request?.request_id !== requestId || snapshot.request.to_conv !== b.convId
          || snapshot.request.turn_id !== turn.id || !Array.isArray(snapshot.results)) {
          await this.state.finish(requestId, 'result_pending_verify');
          return;
        }
        const canonical = snapshot.results.filter((r: any) => r.kind === 'RESULT' && r.is_first === true);
        if (canonical.length) {
          const report = canonical[0];
          const status = report.exec_status ?? 'completed';
          const matches = canonical.length === 1 && report.request_id === requestId
            && report.evidence === `codex-thread:${b.desktopThreadId}#turn:${turn.id}`
            && ['completed', 'failed', 'interrupted'].includes(turn.status) && status === turn.status
            && typeof report.body === 'string' && Boolean(report.body) && report.body === lastAgentMessage(turn);
          await this.state.finish(requestId, matches ? status : 'result_pending_verify');
          return;
        }
        // A terminal STATUS alone proves no return. Keep observing until actual
        // desktop history has an answer; nonterminal states continue below.
        if (['completed', 'failed', 'interrupted'].includes(started.exec_status)
          && !['completed', 'failed', 'interrupted'].includes(turn.status)) {
          await this.state.finish(requestId, 'result_pending_verify');
          return;
        }
      }
      if (!['running', 'waiting_user', 'result_pending_verify', 'completed', 'failed', 'interrupted'].includes(started.exec_status)) {
        await this.state.finish(requestId, 'result_pending_verify');
        return;
      }
    } catch {
      await this.state.finish(requestId, 'result_pending_verify');
      return;
    }
    if (!['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    const text = lastAgentMessage(turn);
    if (!text) {
      await this.state.finish(requestId, 'result_pending_verify');
      return; // Do not fabricate a desktop owner's report from a status stub.
    }
    await this.submitWithOutbox(requestId, { conv_id: b.convId, kind: 'RESULT', exec_status: turn.status,
      turn_id: turn.id, body: text, evidence: `codex-thread:${b.desktopThreadId}#turn:${turn.id}`,
      result_missing: turn.status !== 'completed' });
    await this.state.finish(requestId, turn.status);
  }

  private async onCancel(requestId: string): Promise<void> {
    if (this.desktopInbox) {
      const record = await this.desktopInbox.get(requestId);
      if (record) {
        record.cancelRequested = true;
        await this.desktopInbox.save(record);
        await this.processRequest(requestId);
      }
      return;
    }
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
  private async deliverResultToConversation(requestId: string, resultId?: string): Promise<void> {
    if (this.stopping) return;
    if (this.desktopInbox) {
      const snapshot = await this.readDesktopReports(requestId);
      // The destination already executed in this exact desktop conversation.
      // Only reports for locally originated requests become new display input.
      if (snapshot.request.to_conv === snapshot.localConvId) return;
      const reports = resultId ? snapshot.eligible.filter((r: any) => r.result_id === resultId) : snapshot.eligible;
      for (const report of reports) await this.deliverDesktopReport(snapshot, report);
      return;
    }
    if (this.isQueuedDeliveryMode()) {
      await this.maybeReplayDesktop(requestId, resultId, resultId === undefined);
      return;
    }
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

  /** Replay a real persisted Relay report as display data, without executing it. */
  async replayDesktopRequest(requestId: string, resultId?: string): Promise<DesktopReplayReceipt> {
    const snapshot = await this.readDesktopReports(requestId);
    const latest = resultId === undefined ? snapshot.eligible[snapshot.eligible.length - 1]
      : snapshot.eligible.find((row: any) => row.result_id === resultId);
    if (!latest) throw new DesktopDeliveryError('report_pending', 'No eligible persisted Relay report is available yet.');
    return this.deliverDesktopReport(snapshot, latest);
  }

  private async readDesktopReports(requestId: string): Promise<{
    request: any; localConvId: string; binding: Binding; eligible: any[];
  }> {
    if ((!this.desktopDelivery && !this.nativeDelivery) || this.stopping) {
      throw new DesktopDeliveryError('desktop_delivery_unavailable', 'Desktop queue delivery is not running.');
    }
    if (!/^r-[a-zA-Z0-9_-]+$/.test(requestId)) {
      throw new DesktopDeliveryError('invalid_request_id', 'An exact Relay request ID is required.');
    }
    let snapshot: any;
    try { snapshot = await this.relay.readResult(requestId); }
    catch { throw new DesktopDeliveryError('report_unavailable', 'The persisted Relay report could not be read.'); }
    const request = snapshot?.request;
    if (request?.request_id !== requestId || !Array.isArray(snapshot?.results)) {
      throw new DesktopDeliveryError('invalid_report', 'The persisted Relay report has an unexpected identity or shape.');
    }
    const localConvs = [...new Set([request.to_conv, request.return_addr, request.from_conv])]
      .filter((id): id is string => typeof id === 'string' && this.byConv.has(id));
    if (localConvs.length !== 1) {
      throw new DesktopDeliveryError('ambiguous_local_party', 'The report must identify exactly one locally bound conversation.');
    }
    const localConvId = localConvs[0];
    const binding = this.byConv.get(localConvId)!;
    if (!binding.desktopThreadId) throw new DesktopDeliveryError('target_unavailable', 'The local conversation has no desktop target.');
    // Ignore malformed unrelated rows rather than preventing another valid
    // report from being delivered. Exact-ID replay still cannot substitute it.
    const reports = snapshot.results.filter((row: any) => row && (row.kind === 'RESULT' || row.kind === 'STATUS')
      && row.request_id === requestId && typeof row.result_id === 'string' && Boolean(row.result_id)
      && typeof row.body === 'string' && (row.exec_status === null || typeof row.exec_status === 'string'));
    // The snapshot is ordered by creation. STATUS remains eligible after a
    // RESULT; duplicate archived RESULT rows never become notifications. Use
    // each RESULT's own terminal status (null defaults to completed on Relay),
    // since later STATUS can change request status. Live events select exact IDs.
    const eligible = reports.filter((row: any) => row.kind === 'STATUS'
      || (row.is_first === true && ['completed', 'failed', 'interrupted'].includes(row.exec_status ?? 'completed')));
    return { request, localConvId, binding, eligible };
  }

  /** Compatibility for old Relay events without result_id: scan this request only. */
  private async replayDesktopReports(requestId: string): Promise<void> {
    const snapshot = await this.readDesktopReports(requestId);
    let pending = 0;
    for (const report of snapshot.eligible) {
      try { await this.deliverDesktopReport(snapshot, report); }
      catch {
        // An earlier uncertain/consumed queue entry does not authorize a
        // second add, and must not suppress a distinct later report either.
        pending++;
      }
    }
    if (pending) throw new DesktopDeliveryError('reports_pending', 'Some desktop notification receipts remain unresolved; no second add was attempted.');
  }

  private async deliverDesktopReport(snapshot: { request: any; localConvId: string; binding: Binding }, latest: any): Promise<DesktopReplayReceipt> {
    const { request, localConvId, binding } = snapshot;
    const requestId = request.request_id;
    const legacyText = legacyDesktopReport(request, latest, localConvId);
    const key = `relay-result:${requestId}:${latest.result_id}:${localConvId}`;
    const receipt = this.nativeDelivery
      ? await this.nativeDelivery.deliver({ key, receiverThreadId: binding.nativeReceiverThreadId!,
        targetThreadId: binding.desktopThreadId!, text: plainDesktopReport(request, latest, localConvId), legacyText,
        requestId, resultId: latest.result_id, localConvId })
      : await this.desktopDelivery!.deliver({ key, threadId: binding.desktopThreadId!,
        text: plainDesktopReport(request, latest, localConvId), format: 'plain_v2', legacyText });
    return { ...receipt, requestId, resultId: latest.result_id, localConvId };
  }

  private async maybeReplayDesktop(requestId: string, resultId?: string, allReports = false): Promise<void> {
    if (!this.isQueuedDeliveryMode() || this.stopping) return;
    try {
      if (allReports) await this.replayDesktopReports(requestId);
      else await this.replayDesktopRequest(requestId, resultId);
    }
    catch (e) {
      // This must never enter the Relay result outbox or expose remote bodies.
      const code = e instanceof DesktopDeliveryError ? e.code : 'desktop_delivery_failed';
      this.log('warn', `desktop notification pending (${code}); UI delivery unconfirmed`);
    }
  }

  private waitForTurn(turnId: string, threadId: string): Promise<TurnTerminal> {
    // Execution authorization is separate from the history storage format.
    // Display targets are never registered with managedThreadRead.
    const timeoutMs = this.opts.turnTimeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      let done = false;
      let readable = false;
      let activeRead: Promise<void> | undefined;
      const cleanup = () => {
        done = true;
        this.turnWaiters.delete(turnId);
        clearInterval(poll);
        clearTimeout(timer);
      };
      const finish = (t: TurnTerminal) => {
        if (done) return;
        cleanup();
        resolve(t);
      };
      const refresh = (): Promise<void> => {
        if (done) return Promise.resolve();
        if (activeRead) return activeRead;
        activeRead = (async () => {
          try {
            const thread = await this.codex.managedThreadRead(threadId);
            if (done) return;
            const turn = thread.turns.find((x: any) => x.id === turnId);
            readable = Boolean(turn && ['completed', 'failed', 'interrupted', 'inProgress'].includes(turn.status));
            if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
              finish({ turnId, status: turn.status, text: lastAgentMessage(turn), raw: turn });
            }
          } catch {
            readable = false;
          } finally {
            activeRead = undefined;
          }
        })();
        return activeRead;
      };
      this.turnWaiters.set(turnId, { threadId, refresh });
      const poll = setInterval(() => void refresh(), 300);
      const timer = setTimeout(() => {
        void (async () => {
          await refresh();
          if (done) return;
          if (readable) {
            // Preserve the existing explicit timeout/missing-result report
            // only when full history positively shows this turn still running.
            finish({ turnId, status: 'failed', text: '', raw: { status: 'timeout' } });
          } else {
            cleanup();
            reject(new Error('managed execution terminal history is unavailable'));
          }
        })();
      }, timeoutMs);
      void refresh();
    });
  }

  // ---- §5.3 crash-window reconciliation ----------------------------------

  async reconcile(): Promise<{ adopted: number; ambiguous: number; restarted: number; pending: number }> {
    const result = { adopted: 0, ambiguous: 0, restarted: 0, pending: 0 };
    if (this.desktopInbox) {
      for (const rec of await this.state.listUnfinished()) {
        if (this.stopping) break;
        await this.processRequest(rec.request_id);
        const after = await this.state.get(rec.request_id);
        if (after && ['completed', 'failed', 'interrupted'].includes(after.status)) result.adopted++;
        else result.pending++;
      }
      return result;
    }
    for (const rec of await this.state.listUnfinished()) {
      const binding = this.byConv.get(rec.to_conv);
      if (!binding?.threadId) {
        await this.state.finish(rec.request_id, 'result_pending_verify');
        result.pending++;
        continue;
      }
      if (rec.turn_id) {
        // We already know the turn: just read its terminal state.
        const thread = await this.codex.managedThreadRead(binding.threadId).catch(() => null);
        const turn = thread?.turns?.find((x: any) => x.id === rec.turn_id);
        if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
          const status = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed';
          await this.state.finish(rec.request_id, status);
          await this.submitWithOutbox(rec.request_id, {
            conv_id: rec.to_conv,
            kind: 'RESULT',
            exec_status: status,
            turn_id: rec.turn_id,
            body: lastAgentMessage(turn) || `(recovered; status=${status})`,
            evidence: `codex-thread:${binding.threadId}#turn:${rec.turn_id}`,
            result_missing: status !== 'completed' || !lastAgentMessage(turn),
          });
          result.adopted++;
        } else {
          await this.state.finish(rec.request_id, 'result_pending_verify');
          result.pending++;
        }
        continue;
      }
      // status 'starting' with no turnId: search thread history by marker.
      const thread = await this.codex.managedThreadRead(binding.threadId).catch(() => null);
      if (!thread || thread.id !== binding.threadId || thread.historyComplete !== true || !Array.isArray(thread.turns)) {
        // A failed read is not positive evidence of an empty history. Starting
        // again here could duplicate work; require human reconciliation.
        await this.state.finish(rec.request_id, 'result_pending_verify');
        this.log('warn', `history unavailable for ${rec.request_id}; automatic replay paused`);
        result.pending++;
        continue;
      }
      const matches = thread.turns.filter((t: any) =>
        (t.items ?? []).some((i: any) => i.type === 'userMessage' && (
          (typeof i.text === 'string' && i.text.includes(rec.marker))
          || (Array.isArray(i.content) && i.content.some((part: any) => part.type === 'text'
            && typeof part.text === 'string' && part.text.includes(rec.marker)))
        )),
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
          result_missing: status !== 'completed' || !lastAgentMessage(turn),
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
    let submitted: any;
    try {
      submitted = await this.relay.submitResult(requestId, payload);
    } catch (e) {
      this.log('warn', `relay submit failed, queueing ${requestId}: ${(e as Error).message}`);
      await this.state.enqueue('result', requestId, payload);
      return;
    }
    if (submitted?.result?.kind === 'RESULT' && submitted.result.is_first === false) return;
    await this.maybeReplayDesktop(requestId,
      typeof submitted?.result?.result_id === 'string' ? submitted.result.result_id : undefined);
  }

  async flushOutbox(): Promise<number> {
    let sent = 0;
    for (const item of await this.state.pendingOutbox()) {
      let submitted: any;
      try {
        submitted = await this.relay.submitResult(item.request_id, item.payload);
        await this.state.deleteOutbox(item.id);
        sent++;
      } catch {
        break; // still offline; keep order
      }
      if (submitted?.result?.kind !== 'RESULT' || submitted.result.is_first !== false) {
        await this.maybeReplayDesktop(item.request_id,
          typeof submitted?.result?.result_id === 'string' ? submitted.result.result_id : undefined);
      }
    }
    if (sent) this.log('info', `flushed ${sent} queued results`);
    return sent;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.desktopPoll) clearInterval(this.desktopPoll);
    await this.desktopScan;
    this.relay?.close();
    await this.codex?.close();
  }
}
