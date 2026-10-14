/**
 * Pure-logic unit tests (§7.2 reconnect backoff, mock fault parsing contract).
 */
import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, RelayClient } from '../src/relayClient.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configOptions, readConfig, secureAtomicJson } from '../src/config.js';

describe('pairing credential destination', () => {
  it('rejects changed relay/profile/state/alias before persisting a newly issued credential', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pair-config-test-'));
    try {
      const cfg = path.join(dir, 'bridge.json');
      await fs.promises.writeFile(path.join(dir, 'code.txt'), 'test-only-code');
      for (const change of ['relay', 'profile', 'state', 'alias']) {
        await secureAtomicJson(cfg, { relay_url: 'https://relay.example.com',
          pairing: { alias: 'B', role: 'worker', task: 't', code_file: 'code.txt' } });
        const opts = configOptions(cfg);
        await opts.preparePairing!();
        const changed = readConfig(cfg);
        if (change === 'relay') changed.relay_url = 'https://different.example.com';
        if (change === 'profile') changed.profile = 'other';
        if (change === 'state') changed.state_dir = 'other-state';
        if (change === 'alias') changed.pairing!.alias = 'other';
        await secureAtomicJson(cfg, changed);
        await expect(opts.persistPairing!({ device_id: 'test-device', device_token: 'test-only-new-token',
          binding: { alias: 'B', role: 'worker', task: 't', project: 'p', threadId: 'th', convId: 'c' },
          pairing_id: 'pair', peer_conv_id: 'peer' })).rejects.toThrow('identity changed');
        expect(readConfig(cfg).device_token).toBeUndefined();
      }
      await fs.promises.mkdir(path.join(dir, '.git'));
      await expect(secureAtomicJson(cfg, {})).rejects.toThrow('outside Git');
      expect(() => configOptions(cfg)).toThrow('outside Git');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  });
});

describe('credential transport', () => {
  it('never reflects peer error messages, error codes or supplied ids into diagnostics', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: {
      code: 'test_secret_one_time_code', message: 'test-secret-device-token' } }), { status: 400 }));
    try {
      const client = new RelayClient({ baseUrl: 'https://relay.example.com' });
      await expect(client.revokeInvitation('c-test', 'test-secret-mistaken-for-id')).rejects.toThrow('relay POST request -> 400');
      try { await client.revokeInvitation('c-test', 'test-secret-mistaken-for-id'); }
      catch (e) {
        expect(String(e)).not.toContain('test-secret');
        expect(String(e)).not.toContain('test_secret');
      }
    } finally { vi.unstubAllGlobals(); }
  });
  it('allows local tests and TLS but rejects public plaintext before any request', () => {
    expect(() => new RelayClient({ baseUrl: 'http://127.0.0.1:8788' })).not.toThrow();
    expect(() => new RelayClient({ baseUrl: 'https://relay.example.com' })).not.toThrow();
    expect(() => new RelayClient({ baseUrl: 'http://relay.example.com' })).toThrow('HTTPS');
    expect(() => new RelayClient({ baseUrl: 'https://secret@relay.example.com' })).toThrow('HTTPS');
  });
});

describe('§7.2 reconnect backoff', () => {
  it('grows exponentially and is capped at 60s', () => {
    expect(backoffDelay(0, 60_000)).toBe(500);
    expect(backoffDelay(1, 60_000)).toBe(1000);
    expect(backoffDelay(2, 60_000)).toBe(2000);
    expect(backoffDelay(7, 60_000)).toBe(60_000);
    // never exceeds the ceiling, however many attempts have failed
    expect(backoffDelay(50, 60_000)).toBe(60_000);
  });

  it('honours a custom ceiling', () => {
    expect(backoffDelay(3, 5_000)).toBe(4_000);
    expect(backoffDelay(4, 5_000)).toBe(5_000);
  });
});
