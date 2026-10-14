#!/usr/bin/env node
/** Pairing controls run without starting Codex or a model turn. */
import { readConfig } from './config.js';
import { RelayClient } from './relayClient.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('pairing-cli invite|list|revoke|unpair --config <private-json> --conv-id <owned-conv>\nrevoke: --invitation-id <id>; unpair: --pairing-id <id>\nInvitation output includes a one-time secret: share only with the intended peer.');
    return;
  }
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const file = value('--config') ?? process.env.BRIDGE_CONFIG;
  if (!file) throw new Error('--config required');
  const cfg = readConfig(file);
  if (!cfg.device_token) throw new Error('saved device credential required');
  const conv = value('--conv-id');
  if (!conv) throw new Error('--conv-id required');
  const relay = new RelayClient({ baseUrl: cfg.relay_url, deviceToken: cfg.device_token });
  const owned = await relay.me({ conv_id: conv });
  if (owned?.conv_id !== conv) throw new Error('conversation ownership could not be verified');
  let result: unknown;
  switch (args[0]) {
    case 'invite': result = await relay.invite(conv); break;
    case 'list': result = await relay.pairings(conv); break;
    case 'revoke': {
      const id = value('--invitation-id');
      if (!id) throw new Error('--invitation-id required');
      result = await relay.revokeInvitation(conv, id); break;
    }
    case 'unpair': {
      const id = value('--pairing-id');
      if (!id) throw new Error('--pairing-id required');
      result = await relay.unpair(conv, id); break;
    }
    default: throw new Error('command must be invite, list, revoke or unpair');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
