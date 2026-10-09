// Probe: spawn the MCP server the same way the test does and print raw output.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(__dirname, '..', 'packages', 'bridge', 'src', 'mcp', 'server.ts');
const cwd = path.resolve(__dirname, '..', 'packages', 'bridge');

const variants = [
  ['--import', 'tsx', server],
  ['--import', 'tsx/esm', server],
  [path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), server],
];

for (const args of variants) {
  await new Promise((resolve) => {
    const label = args[0];
    console.log(`\n=== variant: ${label} ===`);
    const child = spawn(process.execPath, [...args, '--conv-id', 'c-test'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RELAY_URL: 'http://127.0.0.1:1', RELAY_DEVICE_TOKEN: 'x' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => console.log('spawn error:', e.message));
    child.on('exit', (code) => {
      console.log('exit', code, 'stdout=', JSON.stringify(out.slice(0, 300)), 'stderr=', JSON.stringify(err.slice(0, 300)));
      resolve();
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    setTimeout(() => child.stdin.end(), 700);
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2500);
  });
}
