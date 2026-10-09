#!/usr/bin/env node
/**
 * Bridge test runner: runs each test file in its own Node process.
 *
 * Each file spins up several embedded-Postgres (WASM) instances, and running
 * every file in one worker accumulates enough WASM pressure that later tests
 * become extremely slow. One process per file keeps the suite deterministic.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(import.meta.dirname, '..');
const candidates = [
  path.resolve(pkgDir, '../../node_modules/vitest/vitest.mjs'),
  path.resolve(pkgDir, 'node_modules/vitest/vitest.mjs'),
];
const cli = candidates.find((p) => fs.existsSync(p));
if (!cli) {
  console.error('[run-tests] cannot locate vitest cli');
  process.exit(1);
}

const files = fs
  .readdirSync(path.join(pkgDir, 'test'))
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

let failed = 0;
for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const res = spawnSync(process.execPath, [cli, 'run', path.join('test', file), '--reporter=basic'], {
    cwd: pkgDir,
    stdio: 'inherit',
  });
  if (res.status !== 0) failed++;
}
console.log(`\n[run-tests] ${files.length - failed}/${files.length} files passed`);
process.exit(failed === 0 ? 0 : 1);
