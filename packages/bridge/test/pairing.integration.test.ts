import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Bridge, type BridgeOptions } from '../src/bridge.js';
import { configOptions, readConfig, secureAtomicJson } from '../src/config.js';
import { RelayClient } from '../src/relayClient.js';
import { MOCK_PATH, openState, registerDevice, startRelay, waitFor, type TestEnv } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
async function setup() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-pair-test-'));
  cleanups.push(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const env = await startRelay(); cleanups.push(() => env.close());
  const a = await registerDevice(env);
  const client = new RelayClient({ baseUrl: env.baseUrl, deviceToken: a.device_token });
  const row = await client.registerRoster({ profile: 'default', thread_id: 'thread-a', alias: 'A',
    role: 'manager', task: 'pairing', project: 'pair-project', tier: 't1_managed' });
  return { dir, env, client, row };
}
function mockOptions(opts: BridgeOptions, dir: string) {
  return { ...opts, codexCommand: process.execPath, codexArgs: [MOCK_PATH],
    codexEnv: { MOCK_STATE_FILE: path.join(dir, 'mock.json') } };
}
function mockState(dir: string) { return JSON.parse(fs.readFileSync(path.join(dir, 'mock.json'), 'utf8')); }
async function cli(command: string, cfg: string, conv: string, extra: string[] = []) {
  const entry = fileURLToPath(new URL('../src/pairing-cli.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', entry, command, '--config', cfg, '--conv-id', conv, ...extra],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true });
  return JSON.parse(stdout);
}
async function createPairConfig(env: TestEnv, dir: string, code: string, token?: string) {
  const cfg = path.join(dir, 'bridge.json');
  const codeFile = path.join(dir, 'code.txt');
  await fs.promises.writeFile(codeFile, code, { mode: 0o600 });
  await secureAtomicJson(cfg, { relay_url: env.baseUrl, ...(token ? { device_token: token } : {}),
    pairing: { alias: 'B', role: 'worker', task: 'receive', code_file: 'code.txt' } });
  return cfg;
}

describe('pairing bootstrap through real HTTP and mock Codex', () => {
  it('claim followed by unpair cannot start a model turn or fabricate a result', async () => {
    const { dir, env, client, row } = await setup();
    const invite = await client.invite(row.conv_id);
    const cfg = await createPairConfig(env, dir, invite.code);
    const local = await openState(path.join(dir, 'state')); cleanups.push(() => local.close());
    const bridge = new Bridge(mockOptions(configOptions(cfg), dir)); cleanups.push(() => bridge.stop());
    await bridge.start(local.state);
    const saved = readConfig(cfg);
    const realClaim = bridge.relayClient.claim.bind(bridge.relayClient);
    let claimed = false;
    bridge.relayClient.claim = async (id: string) => {
      const request = await realClaim(id);
      claimed = true;
      await client.unpair(row.conv_id, saved.pairing_receipts![0].pairing_id);
      return request;
    };
    const request = await client.sendRequest({ from_conv: row.conv_id, to: saved.bindings![0].convId,
      type: 'TASK', body: 'must never launch after pairing is removed' });
    await bridge.processRequest(request.request_id);
    await waitFor(async () => (await local.state.get(request.request_id))?.status === 'abandoned');
    expect(claimed).toBe(true);
    expect(mockState(dir).turns).toHaveLength(0);
    expect((await client.readResult(request.request_id)).results).toHaveLength(0);
  });

  it('creates independent B credentials and stable thread, persists before WS, and restarts without redeem or model turns', async () => {
    const { dir, env, client, row } = await setup();
    const invite = await client.invite(row.conv_id);
    const cfg = await createPairConfig(env, dir, invite.code);
    let stateHandle = await openState(path.join(dir, 'state'));
    cleanups.push(() => stateHandle.close());
    const opts = mockOptions(configOptions(cfg), dir);
    const persist = opts.persistPairing!;
    let savedBeforeConnection = false;
    let bridge!: Bridge;
    opts.persistPairing = async (r) => {
      await persist(r);
      expect(bridge.relayClient).toBeUndefined();
      expect(readConfig(cfg).device_token).toBe(r.device_token);
      savedBeforeConnection = true;
    };
    bridge = new Bridge(opts); cleanups.push(() => bridge.stop());
    await bridge.start(stateHandle.state);
    await waitFor(async () => bridge.relayClient.isConnected);
    const saved = readConfig(cfg);
    expect(savedBeforeConnection).toBe(true);
    expect(saved.device_id).not.toBe(row.device_id);
    expect(saved.device_token).toBeTruthy();
    expect(saved.pairing).toBeUndefined();
    expect(saved.bindings).toHaveLength(1);
    const b = saved.bindings![0];
    expect((await client.pairings(row.conv_id))[0].peer_conv_id).toBe(b.convId);
    expect(mockState(dir).threads).toHaveLength(1);
    expect(mockState(dir).turns).toHaveLength(0);
    expect(JSON.stringify(await stateHandle.state.logLines())).not.toContain(invite.code);
    if (process.platform !== 'win32') expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
    else {
      const aclFile = path.join(dir, 'acl.txt');
      execFileSync('icacls.exe', [cfg, '/save', aclFile, '/q'], { stdio: 'pipe', windowsHide: true });
      const acl = fs.readFileSync(aclFile, 'utf16le');
      expect(acl).toMatch(/D:P/); // Protected DACL: inheritance removed.
      expect(acl.match(/\(A;/g)).toHaveLength(1); // Only the current owner can access.
    }
    await bridge.stop();
    await stateHandle.close();
    stateHandle = await openState(path.join(dir, 'state'));
    const restarted = new Bridge(mockOptions(configOptions(cfg), dir)); cleanups.push(() => restarted.stop());
    await restarted.start(stateHandle.state);
    expect((await stateHandle.state.listBindings())[0].conv_id).toBe(b.convId);
    expect(mockState(dir).threads).toHaveLength(1);
    expect(mockState(dir).turns).toHaveLength(0);
    expect((await cli('list', cfg, b.convId!))[0].pairing_id).toBe(saved.pairing_receipts![0].pairing_id);
    const legacyCfg = path.join(dir, 'legacy-config.json');
    await secureAtomicJson(legacyCfg, { relay_url: env.baseUrl, device_token: saved.device_token, bindings: [] });
    const cliInvite = await cli('invite', legacyCfg, b.convId!);
    expect(cliInvite.inviter_conv_id).toBe(b.convId);
    await cli('revoke', cfg, b.convId!, ['--invitation-id', cliInvite.invitation_id]);
    await cli('unpair', cfg, b.convId!, ['--pairing-id', saved.pairing_receipts![0].pairing_id]);
    expect((await client.pairings(row.conv_id))[0].revoked_at).not.toBeNull();
  });

  it('keeps an existing credential when redeem correctly omits a new token', async () => {
    const { dir, env, client, row } = await setup();
    const bDevice = await registerDevice(env);
    const invite = await client.invite(row.conv_id);
    const cfg = await createPairConfig(env, dir, invite.code, bDevice.device_token);
    const local = await openState(path.join(dir, 'state')); cleanups.push(() => local.close());
    const bridge = new Bridge(mockOptions(configOptions(cfg), dir)); cleanups.push(() => bridge.stop());
    await bridge.start(local.state);
    expect(readConfig(cfg).device_token).toBe(bDevice.device_token);
    expect(readConfig(cfg).device_id).toBe(bDevice.device_id);
    expect(mockState(dir).turns).toHaveLength(0);
  });

  it('fails closed after lost persistence; restart never re-redeems or creates another thread', async () => {
    const { dir, env, client, row } = await setup();
    const invite = await client.invite(row.conv_id);
    const cfg = await createPairConfig(env, dir, invite.code);
    const local = await openState(path.join(dir, 'state')); cleanups.push(() => local.close());
    const opts = mockOptions(configOptions(cfg), dir);
    opts.persistPairing = async () => { throw new Error('disk unavailable'); };
    const bridge = new Bridge(opts); cleanups.push(() => bridge.stop());
    await expect(bridge.start(local.state)).rejects.toThrow('disk unavailable');
    await bridge.stop();
    expect((await local.state.getBootstrap('B')).status).toBe('redeeming');
    const restarted = new Bridge(mockOptions(configOptions(cfg), dir)); cleanups.push(() => restarted.stop());
    await expect(restarted.start(local.state)).rejects.toThrow('outcome unknown');
    expect(mockState(dir).threads).toHaveLength(1);
    expect(mockState(dir).turns).toHaveLength(0);
    expect(await client.pairings(row.conv_id)).toHaveLength(1);
    expect(readConfig(cfg).device_token).toBeUndefined();
  });
});
