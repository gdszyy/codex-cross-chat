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

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private initialized = false;

  constructor(private opts: CodexClientOptions) {
    super();
  }

  async start(timeoutMs = 15000): Promise<void> {
    this.child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: this.opts.shell === true,
    }) as ChildProcessWithoutNullStreams;
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    // Never let a stdin write error (e.g. after the child exits) crash the
    // process as an unhandled stream error.
    this.child.stdin.on('error', (e: Error) => this.emit('stdinError', e.message));
    this.child.on('exit', (code) => {
      this.emit('exit', code);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`codex process exited (${code})`));
      }
      this.pending.clear();
    });
    await this.rpc(
      'initialize',
      {
        clientInfo: { name: 'codex-relay-bridge', title: 'Codex Relay Bridge', version: '0.1.0' },
        // Declare only what the bridge needs (compat §7 R6) — not experimentalApi.
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      timeoutMs,
    );
    this.send({ method: 'initialized' });
    this.initialized = true;
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
      this.send({ id: msg.id, result: { approved: false, reason: 'relay bridge does not auto-approve' } });
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
      this.send({ id, method, params });
    });
  }

  async threadStart(model: string, cwd?: string): Promise<string> {
    const res = await this.rpc('thread/start', {
      cwd: cwd ?? this.opts.cwd,
      sandbox: 'read-only',
      ephemeral: false,
      model,
    });
    return res.thread.id;
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
    return this.child !== undefined && this.child.exitCode === null;
  }

  async close(): Promise<void> {
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
