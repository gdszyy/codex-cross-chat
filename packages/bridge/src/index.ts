import fs from 'node:fs';
import path from 'node:path';
import { Bridge } from './bridge.js';
import { LocalState } from './state.js';
import { openLocalPg, type Db } from './db.js';
import { configOptions } from './config.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const cfgPath = value('--config') ?? process.env.BRIDGE_CONFIG;
  if (!cfgPath) throw new Error('--config <path> or BRIDGE_CONFIG required');
  const opts = configOptions(cfgPath, value('--pair-code-file'));
  await fs.promises.mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
  const lifecycleFile = path.join(opts.stateDir, 'bridge.lifecycle.jsonl');
  const secrets = new Set([opts.deviceToken, opts.pairing?.code].filter((s): s is string => Boolean(s)));
  const redact = (input: string) => {
    let text = input;
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/token=[^&\s]+/gi, 'token=***')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/("device_token"\s*:\s*")[^"]*/gi, '$1[REDACTED]');
  };
  const lifecycle = (event: string, details: Record<string, unknown> = {}) => {
    const line = redact(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details }));
    try { fs.appendFileSync(lifecycleFile, line + '\n', { mode: 0o600 }); }
    catch { console.error('[bridge] lifecycle file write failed'); }
  };
  let db: Db | undefined;
  let bridge: Bridge | undefined;
  let logQueue = Promise.resolve();
  let stopping = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    lifecycle('stopping', { reason, exit_code: exitCode });
    // A stalled local SQL write must not prevent an explicitly requested stop.
    const deadline = setTimeout(() => {
      lifecycle('shutdown_deadline', { exit_code: exitCode });
      process.exit(exitCode);
    }, 8000);
    deadline.unref();
    try { await bridge?.stop(); } catch { lifecycle('bridge_cleanup_failed'); }
    await logQueue;
    try { await db?.close(); } catch { lifecycle('database_cleanup_failed'); }
    lifecycle('stopped', { exit_code: exitCode });
    clearTimeout(deadline);
    process.exit(exitCode);
  };
  const fatal = (reason: string, error: unknown) => {
    const message = redact(error instanceof Error ? error.message : 'non-Error failure').slice(0, 1200);
    lifecycle(reason, { message });
    console.error(`[bridge] ${reason}: ${message}`);
    void shutdown(reason, 1);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT', 0); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM', 0); });
  process.on('uncaughtException', (error) => fatal('uncaught_exception', error));
  process.on('unhandledRejection', (error) => fatal('unhandled_rejection', error));
  process.on('exit', (code) => lifecycle('process_exit', { exit_code: code }));
  lifecycle('starting', { ppid: process.ppid, node_version: process.version });
  try {
    db = await openLocalPg(opts.stateDir);
    const state = new LocalState(db);
    await state.init();
    bridge = new Bridge({ ...opts, onLog: (level, message) => {
      const safeMessage = redact(message);
      const line = `[bridge ${new Date().toISOString()}] ${level}: ${safeMessage}`;
      if (level === 'warn' || level === 'error') console.error(line);
      else console.log(line);
      if (!stopping) logQueue = logQueue.then(() => state.log(level, safeMessage)).catch(() => {
        lifecycle('sql_log_failed');
      });
    } });
    await bridge.start(state);
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (typeof saved.device_token === 'string') secrets.add(saved.device_token);
    bridge.codexClient.on('exit', (code: number) => {
      if (!stopping) fatal('codex_process_exited', new Error(`Codex App Server exited (${code})`));
    });
    if (!bridge.codexClient.isRunning) throw new Error('Codex App Server exited during Bridge startup');
    lifecycle('running');
    console.log(`[bridge] running pid=${process.pid}`);
  } catch (error) { fatal('startup_failed', error); }
}

main().catch(() => {
  // Bootstrap network errors can reflect one-time secrets. Keep stderr safe;
  // durable local intent distinguishes unknown outcome from a clean start.
  console.error('[bridge] startup failed; check local config and bootstrap receipt before retrying');
  process.exit(1);
});
