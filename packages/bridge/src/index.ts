import fs from 'node:fs';
import { Bridge } from './bridge.js';
import { LocalState } from './state.js';
import { openLocalPg } from './db.js';
import { configOptions } from './config.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const cfgPath = value('--config') ?? process.env.BRIDGE_CONFIG;
  if (!cfgPath) throw new Error('--config <path> or BRIDGE_CONFIG required');
  const opts = configOptions(cfgPath, value('--pair-code-file'));
  await fs.promises.mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
  const db = await openLocalPg(opts.stateDir);
  const state = new LocalState(db);
  await state.init();
  const bridge = new Bridge({ ...opts, onLog: (level, message) => {
    const line = `[bridge ${new Date().toISOString()}] ${level}: ${message}`;
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
    void state.log(level, message);
  } });
  try { await bridge.start(state); }
  catch (e) { await bridge.stop(); await db.close(); throw e; }
  console.log('[bridge] running');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(() => {
  // Bootstrap network errors can reflect one-time secrets. Keep stderr safe;
  // durable local intent distinguishes unknown outcome from a clean start.
  console.error('[bridge] startup failed; check local config and bootstrap receipt before retrying');
  process.exit(1);
});
