/**
 * Device WebSocket channel (§9 #3): presence, heartbeat (30s/90s per §7.2),
 * event push and cursor-based replay after reconnect.
 */
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Store, StoreEvent } from './domain.js';
import { nowMs } from './util.js';

interface Conn {
  ws: WebSocket;
  deviceId: string;
  convs: string[];
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true });
  private conns = new Map<string, Set<Conn>>();
  private sweeper?: NodeJS.Timeout;
  private flusher?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private onRevoked: (deviceId: string) => void,
  ) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      void this.onUpgrade(req, socket, head);
    });

    // Drain store events to subscribers + persist for replay.
    this.flusher = setInterval(() => void this.flush(), 25);
    // Presence sweeper: mark devices offline when no heartbeat within window.
    this.sweeper = setInterval(() => void this.sweep(), 5000);
  }

  private async onUpgrade(req: any, socket: any, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v1/device') {
      socket.destroy();
      return;
    }
    const token =
      url.searchParams.get('token') ??
      (req.headers['x-device-token'] as string | undefined) ??
      this.bearerFrom(req.headers['authorization']);
    // Authenticate *before* upgrading: an invalid token never reaches the
    // application protocol (§1.2-B: identity comes from the connection).
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      await this.store.authDevice(token);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.onConnection(ws, token);
    });
  }

  private bearerFrom(h?: string | string[]): string | undefined {
    const v = Array.isArray(h) ? h[0] : h;
    if (v && v.toLowerCase().startsWith('bearer ')) return v.slice(7).trim();
    return undefined;
  }

  private async onConnection(ws: WebSocket, token: string): Promise<void> {
    let deviceId: string;
    try {
      ({ device_id: deviceId } = await this.store.authDevice(token));
    } catch {
      ws.close(4001, 'unauthorized');
      return;
    }
    const conn: Conn = { ws, deviceId, convs: [] };
    if (!this.conns.has(deviceId)) this.conns.set(deviceId, new Set());
    this.conns.get(deviceId)!.add(conn);
    await this.store.touchDevice(deviceId);
    ws.send(JSON.stringify({ type: 'hello', device_id: deviceId, server_time: nowMs() }));

    ws.on('message', (raw) => void this.onMessage(conn, raw.toString()));
    ws.on('close', () => {
      this.conns.get(deviceId)?.delete(conn);
    });
    ws.on('error', () => {
      this.conns.get(deviceId)?.delete(conn);
    });
  }

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'heartbeat') {
      await this.store.touchDevice(conn.deviceId);
      const convs: string[] = Array.isArray(msg.convs) ? msg.convs : conn.convs;
      conn.convs = convs;
      for (const c of convs) await this.store.markSeen(c);
      conn.ws.send(JSON.stringify({ type: 'heartbeat_ack', server_time: nowMs() }));
    } else if (msg.type === 'resume') {
      const cursor = Number(msg.cursor ?? 0);
      const rows = await this.store.db.query<any>(
        'SELECT * FROM events WHERE device_id=$1 AND id>$2 ORDER BY id ASC LIMIT 1000',
        [conn.deviceId, cursor],
      );
      for (const r of rows) {
        conn.ws.send(
          JSON.stringify({ type: 'event', event: r.event, id: Number(r.id), payload: JSON.parse(r.payload) }),
        );
      }
      conn.ws.send(JSON.stringify({ type: 'resume_done', cursor: rows.length ? Number(rows[rows.length - 1].id) : cursor }));
    }
  }

  private async flush(): Promise<void> {
    const events = this.store.drainEvents();
    for (const e of events) {
      if (e.event === 'revoked') this.onRevoked(e.device_id);
      const rows = await this.store.db.query<any>(
        `INSERT INTO events(device_id, event, payload, created_at) VALUES($1,$2,$3,$4) RETURNING id`,
        [e.device_id, e.event, JSON.stringify(e.payload), nowMs()],
      );
      const id = Number(rows[0].id);
      const frame = JSON.stringify({ type: 'event', event: e.event, id, payload: e.payload });
      for (const conn of this.conns.get(e.device_id) ?? []) {
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(frame);
      }
      if (e.event === 'revoked') {
        // §6: revoking a device immediately blocks it and closes its connections.
        for (const conn of this.conns.get(e.device_id) ?? []) conn.ws.close(4003, 'revoked');
        this.conns.delete(e.device_id);
      }
    }
  }

  private async sweep(): Promise<void> {
    const now = nowMs();
    const rows = await this.store.db.query<any>(
      'SELECT device_id, last_seen_at, revoked_at FROM devices',
    );
    for (const r of rows) {
      const offline =
        r.revoked_at !== null ||
        r.last_seen_at === null ||
        now - Number(r.last_seen_at) > this.store.cfg.offline_after_s * 1000;
      if (offline) {
        for (const conn of this.conns.get(r.device_id) ?? []) {
          if (conn.ws.readyState === WebSocket.OPEN) {
            conn.ws.send(JSON.stringify({ type: 'presence', online: false }));
          }
        }
      }
    }
  }

  /** Latest event id for a device (used by a reconnecting client asking where to resume). */
  async cursor(deviceId: string): Promise<number> {
    const rows = await this.store.db.query<any>(
      'SELECT COALESCE(MAX(id),0) AS c FROM events WHERE device_id=$1',
      [deviceId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  close(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.flusher) clearInterval(this.flusher);
    for (const set of this.conns.values()) for (const c of set) c.ws.close();
    this.wss.close();
  }
}
