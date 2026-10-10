/**
 * Relay entry point.
 *
 * The ONLY hand-set environment variable is the relay root key (RELAY_ROOT_KEY).
 * Everything else is either the Railway DATABASE_URL binding (production) or a
 * database-backed config item with a default (§8 single-key constraint).
 */
import { createRelay } from './server.js';
import { openPg, openPglite } from './db.js';

async function main(): Promise<void> {
  const rootKey = process.env.RELAY_ROOT_KEY;
  if (!rootKey) {
    console.error('[relay] RELAY_ROOT_KEY is required (the single hand-set environment variable)');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8788);
  // Bind a container-routable address by default: hosted platforms (e.g.
  // Railway) proxy to the container and cannot reach a loopback-only listener.
  // Local loopback use is opt-in via `HOST=127.0.0.1`. HOST is an *optional*
  // knob with a default, so RELAY_ROOT_KEY stays the only required hand-set
  // variable (§8 single-key constraint).
  const host = process.env.HOST ?? '0.0.0.0';

  const db = process.env.DATABASE_URL
    ? await openPg(process.env.DATABASE_URL)
    : await openPglite(process.env.PGLITE_DIR);
  console.log(
    `[relay] database=${db.kind}${process.env.DATABASE_URL ? ' (DATABASE_URL)' : ' (embedded pglite)'}`,
  );

  const relay = await createRelay({ db, rootKey });
  const actual = await relay.listen(port, host);
  console.log(`[relay] listening on http://${host}:${actual}  ws=/v1/device`);

  const shutdown = async () => {
    console.log('[relay] shutting down');
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[relay] fatal', err);
  process.exit(1);
});
