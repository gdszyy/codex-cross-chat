/**
 * Codex App Server adapter: spawns the pinned CLI over stdio and speaks
 * JSON-RPC 2.0 (newline-delimited). Pins CLI 0.149.0 (mechanism-design §10 D13);
 * only touches App Server interfaces — never writes ~/.codex (R3).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

export interface CodexClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Run through a shell (needed on Windows for a `.cmd` CLI wrapper). */
  shell?: boolean;
  /** Explicit opt-in for consumers of locally verified experimental APIs. */
  experimentalApi?: boolean;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface TurnTerminal {
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  text: string;
  raw: any;
}

/** Complete persisted history for an explicitly attached execution binding. */
export interface ManagedThreadHistory {
  id: string;
  ephemeral: false;
  historyMode: 'legacy' | 'paginated';
  historyComplete: true;
  turns: any[];
  [field: string]: any;
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private initialized = false;
  private managedThreadIds = new Set<string>();

  constructor(private opts: CodexClientOptions) {
    super();
  }

  async start(timeoutMs = 15000): Promise<void> {
    this.managedThreadIds.clear();
    this.child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.opts.shell === true,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    // Never let a stdin write error (e.g. after the child exits) crash the
    // process as an unhandled stream error.
    this.child.stdin.on('error', (e: Error) => this.emit('stdinError', e.message));
    this.child.on('error', () => {
      this.initialized = false;
      this.rejectPending(new Error('codex process could not start'));
      this.emit('transportError', 'codex process could not start');
    });
    this.child.on('exit', (code) => {
      this.initialized = false;
      this.managedThreadIds.clear();
      this.emit('exit', code);
      this.rejectPending(new Error(`codex process exited (${code})`));
    });
    await this.rpc(
      'initialize',
      {
        clientInfo: { name: 'codex-relay-bridge', title: 'Codex Relay Bridge', version: '0.1.0' },
        // Existing managed-thread consumers stay on the stable API by default.
        capabilities: { experimentalApi: this.opts.experimentalApi === true, requestAttestation: false },
      },
      timeoutMs,
    );
    this.send({ method: 'initialized' });
    this.initialized = true;
  }

  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private send(obj: any): void {
    const child = this.child;
    if (!child || child.exitCode !== null || !child.stdin.writable) {
      // Called after the process ended (e.g. a late event during shutdown).
      // Reject through the pending-promise path instead of emitting an
      // unhandled ERR_STREAM_WRITE_AFTER_END on the socket.
      throw new Error('codex process is not running');
    }
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Server -> client request. The bridge never auto-approves on behalf of
      // the user (§4 step 5); deny by responding with an explicit refusal.
      this.emit('serverRequest', msg);
      try { this.send({ id: msg.id, result: { approved: false, reason: 'relay bridge does not auto-approve' } }); }
      catch { this.emit('transportError', 'codex exited before approval refusal could be delivered'); }
      return;
    }
    if (msg.method) this.emit('notification', msg);
  }

  rpc<T = any>(method: string, params: any, timeoutMs = 20000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  async threadStart(model: string, cwd?: string, name = 'Relay managed conversation'): Promise<string> {
    const res = await this.rpc('thread/start', {
      cwd: cwd ?? this.opts.cwd,
      sandbox: 'read-only',
      ephemeral: false,
      model,
    });
    const id = res.thread?.id;
    if (typeof id !== 'string' || !id) throw new Error('thread/start did not return a thread id');
    this.assertManagedThread(id, res.thread);
    // CLI 0.149.0 can return a path for an empty legacy thread before its
    // rollout exists. A real zero-turn, cross-process probe confirms that
    // thread/name/set persists it without spending a model turn. Do this
    // BEFORE publishing the thread's relay binding, never synthesize history.
    await this.rpc('thread/name/set', { threadId: id, name });
    this.managedThreadIds.add(id);
    try { await this.managedThreadRead(id); }
    catch (e) { this.managedThreadIds.delete(id); throw e; }
    return id;
  }

  /** Resume the exact stored T1 thread; never create/fork a replacement. */
  async threadResume(threadId: string): Promise<any> {
    // The caller supplies its persisted execution binding. Metadata validation
    // happens before attaching a writer; display/queue reads never authorize it.
    this.managedThreadIds.delete(threadId);
    try {
      const metadata = await this.threadRead(threadId, false);
      this.assertManagedThread(threadId, metadata);
      const res = await this.rpc('thread/resume', { threadId,
        ...(metadata.historyMode === 'paginated' ? { excludeTurns: true } : {}) });
      this.assertManagedThread(threadId, res.thread);
      if (res.thread.canAcceptDirectInput !== true) {
        throw new Error('managed thread recovery rejected: resume did not confirm direct input capability');
      }
      this.managedThreadIds.add(threadId);
      return await this.managedThreadRead(threadId);
    } catch (e) { this.managedThreadIds.delete(threadId); throw e; }
  }

  private assertManagedThread(threadId: string, thread: any): void {
    if (thread?.id !== threadId || thread.ephemeral !== false
      || thread.canAcceptDirectInput === false || !['legacy', 'paginated'].includes(thread.historyMode)) {
      throw new Error('managed thread recovery rejected: expected the same non-ephemeral thread with a supported history mode');
    }
  }

  private validateTurns(turns: any, paginated: boolean, seenTurns: Set<string>, seenItems: Set<string>): void {
    if (!Array.isArray(turns)) throw new Error('managed thread history has no complete turn array');
    for (const turn of turns) {
      if (!turn || typeof turn.id !== 'string' || !turn.id || seenTurns.has(turn.id)
        || !['completed', 'failed', 'interrupted', 'inProgress'].includes(turn.status)
        || !Array.isArray(turn.items) || (turn.itemsView !== undefined && turn.itemsView !== 'full')) {
        throw new Error('managed thread history contains incomplete, duplicate or invalid turns');
      }
      seenTurns.add(turn.id);
      for (const item of turn.items) {
        if (!item || typeof item !== 'object' || typeof item.type !== 'string' || !item.type
          || (paginated && (typeof item.id !== 'string' || !item.id))
          || (typeof item.id === 'string' && seenItems.has(item.id))) {
          throw new Error('managed thread history contains incomplete, duplicate or invalid items');
        }
        if (item.type === 'agentMessage' && typeof item.text !== 'string') {
          throw new Error('managed thread history contains an incomplete agent message');
        }
        if (item.type === 'userMessage') {
          const legacyText = !paginated && typeof item.text === 'string' && item.content === undefined;
          if (!legacyText && (!Array.isArray(item.content) || item.content.some((part: any) => !part || typeof part !== 'object'
            || !['text', 'image', 'localImage', 'audio', 'localAudio', 'skill', 'mention'].includes(part.type)
            || (part.type === 'text' && typeof part.text !== 'string')))) {
            throw new Error('managed thread history contains an incomplete user message');
          }
        }
        if (typeof item.id === 'string') seenItems.add(item.id);
      }
    }
  }

  /** Never treats unsupported/partial history as an empty, replayable thread. */
  async managedThreadRead(threadId: string): Promise<ManagedThreadHistory> {
    if (!this.managedThreadIds.has(threadId)) {
      throw new Error('managed history requires an explicitly attached execution binding');
    }
    const metadata = await this.threadRead(threadId, false);
    this.assertManagedThread(threadId, metadata);
    const seenTurns = new Set<string>(), seenItems = new Set<string>();
    if (metadata.historyMode === 'legacy') {
      const thread = await this.threadRead(threadId, true);
      this.assertManagedThread(threadId, thread);
      if (thread.historyMode !== 'legacy') throw new Error('managed history mode changed during its read');
      // The versioned legacy Turn contract defaults an omitted itemsView to full.
      this.validateTurns(thread.turns, false, seenTurns, seenItems);
      return { ...thread, historyComplete: true };
    }
    const turns: any[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0, itemCount = 0;
    for (;;) {
      if (++pages > 1000) throw new Error('managed thread history exceeds the complete-read page limit');
      // CLI 0.149.0 full explicitly includes all persisted items for each turn.
      // The default summary/notLoaded views cannot prove a marker is absent.
      const page = await this.rpc('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 100,
        ...(cursor === undefined ? {} : { cursor }) });
      this.validateTurns(page?.data, true, seenTurns, seenItems);
      turns.push(...page.data);
      itemCount += page.data.reduce((sum: number, turn: any) => sum + turn.items.length, 0);
      if (turns.length > 100000 || itemCount > 1000000) throw new Error('managed thread history exceeds the complete-read resource limit');
      if (page.nextCursor === null || page.nextCursor === undefined) {
        return { ...metadata, turns, historyComplete: true };
      }
      if (!page.data.length || typeof page.nextCursor !== 'string' || !page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new Error('managed thread pagination did not advance');
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async threadRead(threadId: string, includeTurns = true): Promise<any> {
    const res = await this.rpc('thread/read', { threadId, includeTurns });
    return res.thread;
  }

  async turnStart(threadId: string, text: string, model?: string): Promise<string> {
    const res = await this.rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      clientUserMessageId: `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ...(model ? { model } : {}),
    });
    return res.turn.id;
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.rpc('turn/interrupt', { threadId, turnId });
  }

  async modelList(): Promise<string[]> {
    try {
      const res = await this.rpc('model/list', {});
      const arr = res?.data ?? res?.models ?? [];
      return (arr as any[]).map((m) => m.id ?? m.model ?? String(m));
    } catch {
      return [];
    }
  }

  get isRunning(): boolean {
    return this.initialized && this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  async close(): Promise<void> {
    this.managedThreadIds.clear();
    if (this.child && this.child.exitCode === null) {
      this.child.stdin.end();
      const c = this.child;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          c.kill();
          resolve();
        }, 2000);
        c.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

/** Extract the last agentMessage text from a turn's items. */
export function lastAgentMessage(turn: any): string {
  const items = turn?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === 'agentMessage') return it.text ?? '';
  }
  return '';
}
