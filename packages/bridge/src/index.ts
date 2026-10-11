/**
 * Bridge daemon entry point. Reads a JSON config file (path from `--config` or
 * BRIDGE_CONFIG), then runs the bridge until stopped.
 *
 * The config holds the *device token* (never the root key). See
 * docs/bridge-config.example.json for the shape.
 */
import fs from 'node:fs';
import { Bridge, type Binding } from './bridge.js';
import { LocalState } from './state.js';
import { openLocalPg } from './db.js';

interface BridgeConfig {
  relay_url: string;
  device_token: string;
  profile?: string;
  codex_command?: string;
  codex_args?: string[];
  model?: string;
  cwd?: string;
  allow_sources?: string[];
  state_dir?: string;
  turn_timeout_ms?: number;
  heartbeat_ms?: number;
  bindings: Binding[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--config');
  const cfgPath = cfgIdx >= 0 ? args[cfgIdx + 1] : process.env.BRIDGE_CONFIG;
  if (!cfgPath) {
    console.error('[bridge] --config <path> or BRIDGE_CONFIG required');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as BridgeConfig;
  const db = await openLocalPg(raw.state_dir);
  const state = new LocalState(db);
  await state.init();

  const bridge = new Bridge({
    relayUrl: raw.relay_url,
    deviceToken: raw.device_token,
    profile: raw.profile ?? 'default',
    codexCommand: raw.codex_command ?? 'codex',
    codexArgs: raw.codex_args ?? ['app-server', '--stdio'],
    model: raw.model ?? 'gpt-5.6-luna',
    cwd: raw.cwd ?? process.cwd(),
    bindings: raw.bindings ?? [],
    allowSources: raw.allow_sources,
    turnTimeoutMs: raw.turn_timeout_ms,
    heartbeatMs: raw.heartbeat_ms,
    onLog: (level, message) => {
      const line = `[bridge ${new Date().toISOString()}] ${level}: ${message}`;
      if (level === 'warn' || level === 'error') console.error(line);
      else console.log(line);
      void state.log(level, message);
    },
  });

  await bridge.start(state);
  console.log('[bridge] running');

  const shutdown = async () => {
    console.log('[bridge] shutting down');
    await bridge.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[bridge] fatal', err);
  process.exit(1);
});
