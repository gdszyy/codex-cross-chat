/**
 * Bridge -> relay client. Holds the device token (never the root key) and speaks
 * HTTP for control + WebSocket for push (§9 #3). Implements heartbeat 30s,
 * offline 90s awareness, and exponential reconnect backoff capped at 60s (§7.2).
 */
import WebSocket from 'ws';
import type { WsEvent } from '@relay/protocol';

export interface RelayClientOptions {
  baseUrl: string;
  deviceToken: string;
  heartbeatMs?: number;
  maxBackoffMs?: number;
  onEvent?: (e: WsEvent) => void;
  onPresence?: (online: boolean) => void;
  onLog?: (level: string, message: string) => void;
  /** Called after every (re)connect, once the resume cursor has been replayed. */
  onConnected?: () => void;
  /** Durable event cursor (survives restarts). */
  cursorStore?: { get(): Promise<number>; set(value: number): Promise<void> };
  /**
   * Conversation ids this bridge currently hosts. Sent with every heartbeat so
   * the server can refresh their `last_seen_at` (§2.2 presence.mode=heartbeat).
   * Without this the conversation presence decays to offline even while the
   * device-level heartbeat keeps flowing.
   */
  convsProvider?: () => string[];
}

/** §7.2 exponential reconnect backoff, single interval capped at `maxMs`. */
export function backoffDelay(attempt: number, maxMs: number, initialMs = 500): number {
  const raw = initialMs * 2 ** Math.max(0, attempt);
  return Math.min(raw, maxMs);
}

export class RelayClient {
  private ws?: WebSocket;
  private cursor = 0;
  private attempt = 0;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  private connected = false;
  private heartbeatMs: number;
  private maxBackoffMs: number;

  constructor(private opts: RelayClientOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
  }

  private log(level: string, message: string) {
    this.opts.onLog?.(level, message);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private async http(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.opts.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.deviceToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const err = new Error(
        `relay ${method} ${path} -> ${res.status} ${parsed?.error?.code ?? ''} ${parsed?.error?.message ?? ''}`,
      );
      (err as any).status = res.status;
      (err as any).code = parsed?.error?.code;
      throw err;
    }
    return parsed?.data ?? parsed;
  }

  // ---- conversation-facing ------------------------------------------------

  roster(filter: Record<string, string> = {}) {
    const qs = new URLSearchParams(filter).toString();
    return this.http('GET', `/v1/roster${qs ? '?' + qs : ''}`);
  }

  me(binding: { conv_id?: string; profile?: string; thread_id?: string }) {
    const qs = new URLSearchParams(
      Object.entries(binding).filter(([, v]) => v !== undefined) as [string, string][],
    ).toString();
    return this.http('GET', `/v1/roster/me?${qs}`);
  }

  inbox(convId: string) {
    return this.http('GET', `/v1/inbox?for=${encodeURIComponent(convId)}`);
  }

  registerRoster(input: Record<string, unknown>) {
    return this.http('POST', '/v1/roster/register', input);
  }

  join(input: Record<string, unknown>) {
    return this.http('POST', '/v1/roster/join', input);
  }

  sendRequest(input: Record<string, unknown>) {
    return this.http('POST', '/v1/requests', input);
  }

  getRequest(id: string) {
    return this.http('GET', `/v1/requests/${encodeURIComponent(id)}`);
  }

  readResult(id: string) {
    return this.http('GET', `/v1/requests/${encodeURIComponent(id)}/result`);
  }

  cancel(input: Record<string, unknown>) {
    return this.http('POST', `/v1/requests/${encodeURIComponent(String(input.request_id))}/cancel`, input);
  }

  claim(requestId: string) {
    return this.http('POST', `/v1/requests/${encodeURIComponent(requestId)}/claim`, {});
  }

  start(requestId: string, turnId: string) {
    return this.http('POST', `/v1/requests/${encodeURIComponent(requestId)}/start`, { turn_id: turnId });
  }

  submitResult(requestId: string, input: Record<string, unknown>) {
    return this.http('POST', `/v1/requests/${encodeURIComponent(requestId)}/result`, input);
  }

  // ---- WS -----------------------------------------------------------------

  connect(): void {
    this.closed = false;
    const url = this.opts.baseUrl.replace(/^http/, 'ws') + `/v1/device?token=${this.opts.deviceToken}`;
    this.log('info', `ws connecting ${url.replace(/token=[^&]+/, 'token=***')}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.attempt = 0;
      this.log('info', 'ws open');
      void (async () => {
        // §7.2/§8.2: resume from the *persisted* cursor so events that arrived
        // while this bridge was down are replayed, not silently dropped.
        if (this.opts.cursorStore) {
          try {
            this.cursor = Math.max(this.cursor, await this.opts.cursorStore.get());
          } catch {
            /* keep in-memory cursor */
          }
        }
        this.send({ type: 'hello' });
        if (this.cursor > 0) this.send({ type: 'resume', cursor: this.cursor });
        this.opts.onConnected?.();
        this.startHeartbeat();
      })();
    });

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'event') {
        this.cursor = Math.max(this.cursor, Number(msg.id ?? 0));
        void this.opts.cursorStore?.set(this.cursor);
        this.opts.onEvent?.({ event: msg.event, id: msg.id, payload: msg.payload });
      } else if (msg.type === 'resume_done') {
        this.cursor = Math.max(this.cursor, Number(msg.cursor ?? 0));
        void this.opts.cursorStore?.set(this.cursor);
      } else if (msg.type === 'presence') {
        this.opts.onPresence?.(msg.online === true);
      } else if (msg.type === 'heartbeat_ack') {
        this.opts.onPresence?.(true);
      }
    });

    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (e) => this.log('warn', `ws error: ${(e as Error).message}`));
  }

  private scheduleReconnect() {
    this.connected = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.closed) return;
    const delay = backoffDelay(this.attempt, this.maxBackoffMs);
    this.log('warn', `ws closed; reconnect in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
    this.attempt++;
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const beat = () => {
      const convs = this.opts.convsProvider?.() ?? [];
      // §2.2: heartbeat presence must name the hosted conversations — omit the
      // field entirely when there are none (the server keeps the last set).
      this.send(convs.length ? { type: 'heartbeat', convs } : { type: 'heartbeat' });
    };
    beat(); // refresh immediately on (re)connect instead of waiting one interval
    this.heartbeat = setInterval(beat, this.heartbeatMs);
  }

  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }
}
