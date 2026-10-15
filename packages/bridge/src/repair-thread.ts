#!/usr/bin/env node
/** Explicit loss recovery. No model turns, no replacement during daemon startup. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexClient } from './codexClient.js';
import { configOptions, readConfig, secureAtomicJson } from './config.js';
import { RelayClient } from './relayClient.js';
import { LocalState } from './state.js';
import { openLocalPg } from './db.js';

class RepairError extends Error {}

interface RepairIntent {
  version: 1;
  relay_url: string;
  device_id: string;
  conv_id: string;
  profile: string;
  alias: string;
  old_thread_id: string;
  new_thread_id?: string;
  stage: 'prepared' | 'creating_thread' | 'thread_ready' | 'rebind_pending' | 'rebound' | 'complete';
  reason: 'lost_local_thread';
}

export async function repairThread(args: string[]): Promise<Record<string, unknown>> {
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  if (!args.includes('--ack-history-unrecoverable')) throw new RepairError('explicit --ack-history-unrecoverable required; stop the matching Bridge first');
  const fileArg = value('--config');
  const conv = value('--conv-id');
  if (!fileArg || !conv || !/^c-[a-z0-9]+$/.test(conv)) throw new RepairError('--config and exact --conv-id required');
  const file = path.resolve(fileArg);
  const raw = readConfig(file);
  if (!raw.device_token || raw.pairing) throw new RepairError('an already-paired private config without pending pairing is required');
  const opts = configOptions(file);
  const relay = new RelayClient({ baseUrl: raw.relay_url, deviceToken: raw.device_token });
  const initial = JSON.stringify(raw);
  const currentConfig = () => {
    const cfg = readConfig(file);
    if (JSON.stringify(cfg) !== initial) throw new RepairError('config changed during repair; inspect the existing intent, do not start another repair');
    return cfg;
  };
  const current = await relay.me({ conv_id: conv });
  if (current?.conv_id !== conv || current.tier !== 't1_managed' || current.roster_status !== 'active') throw new RepairError('repair requires this device\'s active T1 conversation');
  const requestedAlias = value('--alias');
  const configured = requestedAlias ? (raw.bindings ?? []).find((b) => b.alias === requestedAlias)
    : (raw.bindings ?? []).find((b) => b.convId === conv) ?? ((raw.bindings?.length === 1) ? raw.bindings[0] : undefined);
  if (requestedAlias && !configured) throw new RepairError('requested alias does not exist in this config; repair refused');
  if ((raw.bindings ?? []).filter((b) => b.convId === conv || b.threadId === current.thread_id).length > 1) {
    throw new RepairError('multiple configured bindings match this conversation; repair refused');
  }
  const alias = requestedAlias ?? configured?.alias;
  if (!alias) throw new RepairError('--alias is required when the local binding is ambiguous');
  if ((raw.bindings ?? []).filter((b) => b.alias === alias).length !== 1) throw new RepairError('selected alias must identify exactly one configured binding');
  if (configured?.convId && configured.convId !== conv) throw new RepairError('selected local binding belongs to another conversation');
  const intentFile = file + `.thread-repair-${conv}.json`;
  let intent: RepairIntent | undefined = fs.existsSync(intentFile)
    ? JSON.parse(await fs.promises.readFile(intentFile, 'utf8')) : undefined;
  if (intent && (intent.version !== 1 || intent.relay_url !== raw.relay_url || intent.device_id !== current.device_id ||
      intent.conv_id !== conv || intent.profile !== opts.profile || intent.alias !== alias || intent.reason !== 'lost_local_thread')) {
    throw new RepairError('existing repair intent differs from the selected identity; inspect it before continuing');
  }
  if (current.profile !== opts.profile) throw new RepairError('relay and local profile differ; repair paused');
  // Verify private replacement permissions before creating any new thread or
  // changing the relay. This also rejects Git/.codex secret destinations.
  await secureAtomicJson(file, currentConfig());
  await fs.promises.mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
  const db = await openLocalPg(opts.stateDir);
  const state = new LocalState(db);
  let codex: CodexClient | undefined;
  const connect = async () => {
    const c = new CodexClient({ command: opts.codexCommand, args: opts.codexArgs,
      cwd: opts.cwd, env: opts.codexEnv, shell: opts.codexShell, experimentalApi: true });
    try { await c.start(); }
    catch (e) { await c.close(); throw e; }
    return c;
  };
  try {
    await state.init();
    const stored = await state.getBinding(alias);
    if ((await state.listBindings()).filter((b) => b.conv_id === conv).length > 1) {
      throw new RepairError('multiple local-state bindings match this conversation; repair refused');
    }
    const acceptable = [current.thread_id, intent?.old_thread_id, intent?.new_thread_id].filter(Boolean);
    if (stored && (stored.profile !== opts.profile || (stored.conv_id && stored.conv_id !== conv) || !acceptable.includes(stored.thread_id))) {
      throw new RepairError('local state conflicts with repair identity; no binding changed');
    }
    if (configured?.threadId && !acceptable.includes(configured.threadId)) throw new RepairError('configured thread conflicts with repair identity');
    const exactLocalBinding = (configured?.threadId === current.thread_id && configured?.convId === conv) ||
      (stored?.thread_id === current.thread_id && stored?.conv_id === conv && stored?.profile === opts.profile);
    if (!intent && !exactLocalBinding) throw new RepairError('no exact local thread/conversation mapping exists; repair refused');
    const saveIntent = async () => secureAtomicJson(intentFile, intent);
    if (!intent) {
      codex = await connect();
      try {
        await codex.threadResume(current.thread_id);
        return { status: 'existing_thread_recoverable', conv_id: conv, thread_id: current.thread_id,
          action: 'restart the updated Bridge normally; no replacement performed', model_turn_calls: 0 };
      } catch (e) {
        if ((e as Error).message !== `-32600: no rollout found for thread id ${current.thread_id}`) {
          throw new RepairError('old thread recovery failed without positive no-rollout evidence; replacement refused');
        }
      }
      intent = { version: 1, relay_url: raw.relay_url, device_id: current.device_id, conv_id: conv,
        profile: opts.profile, alias, old_thread_id: current.thread_id, stage: 'prepared', reason: 'lost_local_thread' };
      await saveIntent();
    }
    if (current.thread_id !== intent.old_thread_id && current.thread_id !== intent.new_thread_id) throw new RepairError('relay thread differs from the saved repair intent; no overwrite allowed');
    if (!intent.new_thread_id) {
      if (intent.stage !== 'prepared') throw new RepairError('new-thread creation outcome unknown; inspect the existing CLI state, do not create another');
      intent.stage = 'creating_thread';
      await saveIntent();
      codex ??= await connect();
      intent.new_thread_id = await codex.threadStart(opts.model, opts.cwd, alias);
      intent.stage = 'thread_ready';
      await saveIntent();
      // Prove the replacement can be restored from disk by another process
      // before changing any remote identity or consuming pending requests.
      await codex.close();
      codex = undefined;
    }
    codex ??= await connect();
    await codex.threadResume(intent.new_thread_id);
    let rebound = current;
    if (current.thread_id !== intent.new_thread_id) {
      if (intent.stage === 'rebind_pending' && !args.includes('--retry-rebind')) {
        throw new RepairError('prior rebind outcome unknown and relay still reports old thread; inspect operation, then use --retry-rebind for this SAME intent');
      }
      intent.stage = 'rebind_pending';
      await saveIntent();
      currentConfig();
      try {
        const response = await fetch(raw.relay_url + `/v1/roster/${encodeURIComponent(conv)}/rebind`, {
          method: 'POST', headers: { 'x-device-token': raw.device_token, 'content-type': 'application/json' },
          body: JSON.stringify({ expected_thread_id: intent.old_thread_id, profile: intent.profile,
            thread_id: intent.new_thread_id, reason: intent.reason }), signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new RepairError('relay rebind refused or failed');
        const result = await response.json() as any;
        rebound = (result.data ?? result).conversation;
      } catch {
        // Query the original outcome before considering a retry. Never create
        // another thread on a timeout, conflict, server failure or lost reply.
        rebound = await relay.me({ conv_id: conv }).catch(() => null);
        if (rebound?.thread_id !== intent.new_thread_id) throw new RepairError('rebind not confirmed; retain existing intent and new thread for inspection');
      }
    }
    if (rebound?.conv_id !== conv || rebound.thread_id !== intent.new_thread_id || rebound.device_id !== intent.device_id || rebound.profile !== intent.profile) {
      throw new RepairError('rebind response identity mismatch; config unchanged, inspect existing intent');
    }
    intent.stage = 'rebound';
    await saveIntent();
    const next = currentConfig();
    const replacement = { ...(configured ?? { alias, role: rebound.role, task: rebound.task, project: rebound.project,
      ownerLabel: rebound.owner_label }), threadId: intent.new_thread_id, convId: conv };
    next.bindings = [...(next.bindings ?? []).filter((b) => b.alias !== alias), replacement];
    await secureAtomicJson(file, next);
    await state.saveBinding(alias, intent.profile, intent.new_thread_id, conv);
    intent.stage = 'complete';
    await saveIntent();
    return { status: 'repaired', conv_id: conv, old_thread_id: intent.old_thread_id, thread_id: intent.new_thread_id,
      intent_file: intentFile, model_turn_calls: 0, next: 'start the Bridge normally; do not automatically resubmit failed requests' };
  } finally {
    await codex?.close();
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('repair-thread --config <private-json> --conv-id <exact-owned-conv> [--alias <local-alias>] --ack-history-unrecoverable\nStop the matching Bridge first. Never changes a recoverable old thread. No model turns.\nAfter an uncertain rebind: inspect the same adjacent intent; --retry-rebind reuses that exact new thread.');
  else repairThread(args).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => {
    // Only locally controlled diagnostics are thrown above. Transport bodies,
    // config contents, model inputs, tokens and codes are never printed.
    console.error('[repair-thread] ' + (e instanceof RepairError ? e.message : 'repair failed; inspect the existing nonsecret intent before retrying')); 
    process.exitCode = 1;
  });
}

