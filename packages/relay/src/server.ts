/**
 * Relay server wiring: HTTP router + WebSocket hub + background sweepers.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { Store } from './domain.js';
import { bootstrapDb, loadConfig, type Db } from './db.js';
import { handleHttp } from './router.js';
import { WsHub } from './ws.js';
import { HttpError } from './util.js';
import { DEFAULT_CONFIG, type RuntimeConfig } from '@relay/protocol';

export interface RelayOptions {
  db: Db;
  rootKey: string;
  config?: Partial<RuntimeConfig>;
  /** Disable background timers (used by tests that drive time manually). */
  background?: boolean;
}

export interface Relay {
  server: Server;
  store: Store;
  hub: WsHub;
  close(): Promise<void>;
  listen(port: number, host?: string): Promise<number>;
}

export async function createRelay(opts: RelayOptions): Promise<Relay> {
  // §8/D9: every non-secret parameter is a *database* config item with a
  // default. Seed the merged defaults, then read the effective config back out
  // of the database — the config table is the real source at runtime, not a
  // hard-coded object.
  await bootstrapDb(opts.db, { ...DEFAULT_CONFIG, ...(opts.config ?? {}) });
  const store = new Store(opts.db, await loadConfig(opts.db));
  const hub = new WsHub(store, () => {});
  const server = createHttpServer((req, res) => {
    handleHttp({ store, rootKey: opts.rootKey }, req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'internal_error';
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, error: { code, message: String(err?.message ?? err) } }));
    });
  });
  hub.attach(server);

  let expiry: NodeJS.Timeout | undefined;
  if (opts.background !== false) {
    expiry = setInterval(() => {
      void store.expireUnstarted();
    }, 60_000);
  }

  return {
    server,
    store,
    hub,
    async listen(port: number, host = '127.0.0.1'): Promise<number> {
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    },
    async close(): Promise<void> {
      if (expiry) clearInterval(expiry);
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await opts.db.close();
    },
  };
}
