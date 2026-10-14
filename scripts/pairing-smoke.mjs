// Explicit operator smoke test; creates isolated test devices and revokes them.
// Usage: node scripts/pairing-smoke.mjs --root-env-file <private-file> --evidence <json>
// No model/App Server turns. Never prints credentials or pairing codes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const arg = (name) => { const n = process.argv.indexOf(name); return n < 0 ? undefined : process.argv[n + 1]; };
const base = arg('--url') ?? 'https://codex-cross-chat-production.up.railway.app';
const keyFile = arg('--root-env-file');
const evidenceFile = arg('--evidence');
if (!keyFile || !evidenceFile) throw new Error('--root-env-file and --evidence required');
const line = fs.readFileSync(keyFile, 'utf8').split(/\r?\n/).find((s) => /^\s*RELAY_ROOT_KEY\s*=/.test(s));
if (!line) throw new Error('Root key missing in private carrier');
const key = line.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
const deviceIds = [];
const evidence = { checked_at: new Date().toISOString(), url: base, model_turns: 0, checks: {}, cleanup: [] };
async function api(method, route, { body, token, root = false, status = 200 } = {}) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(25000),
    headers: { 'content-type': 'application/json', ...(root ? { 'x-root-key': key } : {}), ...(token ? { 'x-device-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, status, `${method} ${route}: unexpected HTTP status`);
  const data = await response.json();
  if (status < 400) assert.equal(data.ok, true, 'API returned failure');
  return data.data ?? data;
}
let failure = false;
try {
  const health = await api('GET', '/health');
  assert.equal(health.db, 'postgres');
  evidence.checks.health = health;
  const aDevice = await api('POST', '/v1/devices/register', { root: true, status: 201, body: { owner_label: 'pairing-release-smoke' } });
  deviceIds.push(aDevice.device_id);
  const nonce = Date.now();
  const a = await api('POST', '/v1/roster/register', { token: aDevice.device_token, status: 201,
    body: { profile: 'smoke', thread_id: `http-smoke-a-${nonce}`, alias: 'pairing-http-smoke-A', role: 'observer', task: 'zero-model release validation', project: `pairing-smoke-${nonce}`, tier: 't2_desktop' } });
  const invite = await api('POST', '/v1/pairing/invitations', { token: aDevice.device_token, status: 201, body: { conv_id: a.conv_id } });
  assert.ok(invite.expires_at - Date.now() <= 600000 && invite.expires_at - Date.now() > 550000);
  const payload = { code: invite.code, profile: 'smoke', thread_id: `http-smoke-b-${nonce}`, alias: 'pairing-http-smoke-B', role: 'observer', task: 'zero-model protocol executor', tier: 't2_desktop' };
  const attempts = await Promise.all([0, 1].map(async () => {
    const response = await fetch(base + '/v1/pairing/redeem', { method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return { status: response.status, result: await response.json() };
  }));
  const winner = attempts.find((r) => r.status === 201);
  for (const r of attempts) if (r.result?.data?.device?.device_id) deviceIds.push(r.result.data.device.device_id);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409], 'one concurrent redemption must win');
  const b = winner.result.data;
  evidence.checks.concurrent_redemption_single_winner = true;
  assert.notEqual(aDevice.device_id, b.device.device_id);
  assert.equal(typeof b.device.device_token, 'string');
  evidence.checks.independent_device = true;
  evidence.checks.addresses = { a: a.conv_id, b: b.conversation.conv_id };
  await api('POST', '/v1/pairing/redeem', { body: payload, status: 409 });
  evidence.checks.replay_rejected = true;
  const third = await api('POST', '/v1/roster/register', { token: aDevice.device_token, status: 201,
    body: { profile: 'smoke', thread_id: `http-smoke-third-${nonce}`, alias: 'unpaired-same-device', role: 'observer', project: a.project, tier: 't2_desktop' } });
  await api('POST', '/v1/requests', { token: aDevice.device_token, status: 403,
    body: { from_conv: third.conv_id, to: b.conversation.conv_id, type: 'QUERY', body: 'must not reach B' } });
  evidence.checks.third_conversation_denied = true;
  for (const [sender, target, senderToken, targetToken] of [
    [a, b.conversation, aDevice.device_token, b.device.device_token],
    [b.conversation, a, b.device.device_token, aDevice.device_token],
  ]) {
    const request = await api('POST', '/v1/requests', { token: senderToken, status: 201,
      body: { from_conv: sender.conv_id, to: target.conv_id, type: 'QUERY', body: 'release protocol smoke; no model execution' } });
    await api('POST', `/v1/requests/${request.request_id}/claim`, { token: targetToken });
    await api('POST', `/v1/requests/${request.request_id}/authorize-start`, { token: targetToken });
    await api('POST', `/v1/requests/${request.request_id}/start`, { token: targetToken, body: { turn_id: 'http-protocol-smoke-no-model' } });
    await api('POST', `/v1/requests/${request.request_id}/result`, { token: targetToken, status: 201,
      body: { conv_id: target.conv_id, kind: 'RESULT', body: 'protocol smoke acknowledged without model', evidence: 'HTTP protocol smoke; no Bridge/model', exec_status: 'completed' } });
    const result = await api('GET', `/v1/requests/${request.request_id}/result`, { token: senderToken });
    assert.ok(JSON.stringify(result).includes('protocol smoke acknowledged without model'));
  }
  evidence.checks.bidirectional_results = true;
  const pending = await api('POST', '/v1/requests', { token: aDevice.device_token, status: 201,
    body: { from_conv: a.conv_id, to: b.conversation.conv_id, type: 'QUERY', body: 'unpair blocks queued start' } });
  await api('POST', `/v1/pairings/${b.pairing_id}/revoke`, { token: b.device.device_token, body: { conv_id: b.conversation.conv_id } });
  await api('POST', `/v1/requests/${pending.request_id}/claim`, { token: b.device.device_token, status: 403 });
  await api('POST', `/v1/requests/${pending.request_id}/authorize-start`, { token: b.device.device_token, status: 403 });
  await api('POST', `/v1/requests/${pending.request_id}/cancel`, { token: aDevice.device_token, body: { from_conv: a.conv_id } });
  await api('POST', '/v1/requests', { token: aDevice.device_token, status: 403,
    body: { from_conv: a.conv_id, to: b.conversation.conv_id, type: 'QUERY', body: 'must fail after unpair' } });
  evidence.checks.unpair_blocks_new_and_pending = true;
  const revocable = await api('POST', '/v1/pairing/invitations', { token: aDevice.device_token, status: 201, body: { conv_id: a.conv_id } });
  await api('POST', `/v1/pairing/invitations/${revocable.invitation_id}/revoke`, { token: aDevice.device_token, body: { conv_id: a.conv_id } });
  await api('POST', '/v1/pairing/redeem', { status: 409, body: { ...payload, code: revocable.code } });
  evidence.checks.revoked_invitation_denied = true;
} catch (error) {
  failure = true;
  evidence.failure = error instanceof assert.AssertionError ? error.message : 'network/API operation failed; inspect server state before retry';
} finally {
  for (const id of deviceIds) {
    try { await api('POST', `/v1/devices/${id}/revoke`, { root: true }); evidence.cleanup.push({ device_id: id, revoked: true }); }
    catch { evidence.cleanup.push({ device_id: id, revoked: false }); failure = true; }
  }
  evidence.passed = !failure;
  fs.mkdirSync(path.dirname(path.resolve(evidenceFile)), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
}
if (failure) process.exit(1);
