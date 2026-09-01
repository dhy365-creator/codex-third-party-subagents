#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = Object.freeze([
  'tests/windows-phase1.test.mjs',
  'tests/windows-phase2a.test.mjs',
  'tests/windows-acceptance-native.test.mjs',
]);
const credentialName = /(?:API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/iu;
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !credentialName.test(name) && name !== 'NODE_OPTIONS'));

process.stdout.write([
  'Windows acceptance harness: repository-owned, synthetic, and Provider-offline.',
  'Portable coverage runs on every platform; native gates use explicit node:test skips.',
  `Suites: ${suites.join(', ')}`,
  '',
].join('\n'));

const child = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...suites], {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
  shell: false,
});
process.exitCode = child.status ?? 1;
