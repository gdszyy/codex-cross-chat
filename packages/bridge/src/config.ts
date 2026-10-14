import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Binding, BridgeOptions, PairingReceipt } from './bridge.js';

export interface BridgeConfig {
  relay_url: string;
  device_token?: string;
  device_id?: string;
  profile?: string;
  codex_command?: string;
  codex_args?: string[];
  model?: string;
  cwd?: string;
  allow_sources?: string[];
  state_dir?: string;
  turn_timeout_ms?: number;
  heartbeat_ms?: number;
  bindings?: Binding[];
  pairing?: { code_file?: string; alias: string; role: string; task: string; owner_label?: string };
  pairing_receipts?: { pairing_id: string; peer_conv_id: string; conv_id: string; thread_id: string }[];
}

function outsideCodex(file: string): string {
  const resolved = path.resolve(file);
  const rel = path.relative(path.join(os.homedir(), '.codex'), resolved);
  if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) {
    throw new Error('Bridge config and state must live outside ~/.codex');
  }
  return resolved;
}

function outsideGit(file: string): void {
  let dir = path.dirname(path.resolve(file));
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) throw new Error('credential config must be outside Git working trees');
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Create privately before writing secrets; replacement never exposes a partial receipt. */
export async function secureAtomicJson(file: string, value: unknown): Promise<void> {
  file = outsideCodex(file);
  outsideGit(file);
  const tmp = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.promises.open(tmp, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      const identity = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.match(/S-1-[0-9-]+/)?.[0];
      if (!sid) throw new Error('cannot establish private config owner');
      execFileSync(path.join(system32, 'icacls.exe'), [tmp, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { stdio: 'pipe', windowsHide: true });
    }
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    await fs.promises.rename(tmp, file);
  } catch (e) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

export function readConfig(file: string): BridgeConfig {
  return JSON.parse(fs.readFileSync(outsideCodex(file), 'utf8')) as BridgeConfig;
}

export function configOptions(file: string, codeFile?: string): BridgeOptions & { stateDir: string } {
  file = outsideCodex(file);
  const raw = readConfig(file);
  if (raw.pairing) outsideGit(file); // Refuse an unsafe destination BEFORE consuming the one-shot code.
  if (raw.pairing && (raw.bindings?.length ?? 0) > 0) throw new Error('pairing bootstrap requires an empty bindings list; use saved config after redemption');
  const relative = (p: string) => path.resolve(path.dirname(file), p);
  const pairFile = codeFile ? path.resolve(codeFile) : raw.pairing?.code_file ? relative(raw.pairing.code_file) : undefined;
  if (codeFile && !raw.pairing) throw new Error('--pair-code-file requires pairing alias/role/task in config');
  const code = pairFile ? fs.readFileSync(pairFile, 'utf8').trim() : undefined;
  if (raw.pairing && !code) throw new Error('pairing requires a nonempty --pair-code-file or pairing.code_file');
  const stateDir = outsideCodex(raw.state_dir ? relative(raw.state_dir) : file + '.state');
  const identity = (cfg: BridgeConfig) => JSON.stringify({ relay: cfg.relay_url, profile: cfg.profile ?? 'default',
    state: outsideCodex(cfg.state_dir ? relative(cfg.state_dir) : file + '.state'),
    device: cfg.device_token ?? null, deviceId: cfg.device_id ?? null, bindings: cfg.bindings ?? [],
    pairing: cfg.pairing ? { alias: cfg.pairing.alias, role: cfg.pairing.role, task: cfg.pairing.task,
      owner: cfg.pairing.owner_label ?? null, codeFile: cfg.pairing.code_file ? relative(cfg.pairing.code_file) : null } : null });
  const initialIdentity = identity(raw);
  const unchanged = (next: BridgeConfig) => {
    if (identity(next) !== initialIdentity) throw new Error('pairing config identity changed; inspect local/relay receipts before retry');
  };
  return {
    relayUrl: raw.relay_url, deviceToken: raw.device_token, profile: raw.profile ?? 'default',
    codexCommand: raw.codex_command ?? (process.platform === 'win32' ? 'cmd.exe' : 'codex'),
    codexArgs: raw.codex_args ?? (process.platform === 'win32' ? ['/d', '/s', '/c', 'codex app-server --stdio'] : ['app-server', '--stdio']),
    model: raw.model ?? 'gpt-5.6-luna', cwd: raw.cwd ?? process.cwd(), bindings: raw.bindings ?? [],
    allowSources: raw.allow_sources, turnTimeoutMs: raw.turn_timeout_ms, heartbeatMs: raw.heartbeat_ms, stateDir,
    ...(raw.pairing ? { pairing: { code: code!, alias: raw.pairing.alias, role: raw.pairing.role,
      task: raw.pairing.task, ownerLabel: raw.pairing.owner_label } } : {}),
    preparePairing: async () => {
      const next = readConfig(file);
      unchanged(next);
      // Prove this private destination can be replaced BEFORE requesting a new
      // credential. No root key, code or newly issued token is written here.
      await secureAtomicJson(file, next);
    },
    persistPairing: async (receipt: PairingReceipt) => {
      // Re-read so unrelated user settings aren't replaced by an old snapshot.
      const next = readConfig(file);
      unchanged(next);
      if (next.device_token && next.device_token !== receipt.device_token) throw new Error('config credential changed during pairing; inspect receipt before retry');
      next.device_token = receipt.device_token;
      next.device_id = receipt.device_id;
      next.bindings = [...(next.bindings ?? []).filter((b) => b.alias !== receipt.binding.alias), receipt.binding];
      next.pairing_receipts = [...(next.pairing_receipts ?? []), { pairing_id: receipt.pairing_id,
        peer_conv_id: receipt.peer_conv_id, conv_id: receipt.binding.convId!, thread_id: receipt.binding.threadId! }];
      delete next.pairing;
      await secureAtomicJson(file, next);
    },
  };
}
