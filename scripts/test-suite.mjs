#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windowsPhase2Suites = new Set([
  'bridge.test.mjs',
  'doctor-transport.test.mjs',
  'external-flash-runtime.test.mjs',
  'external-fs-safety.test.mjs',
  'external-live-request-ledger.test.mjs',
  'external-transport-adapter.test.mjs',
  'external-transport-config.test.mjs',
  'external-transport-process.test.mjs',
  'install.test.mjs',
]);

const args = ['--test'];
if (process.platform === 'win32') {
  const selected = fs.readdirSync(path.join(root, 'tests'))
    .filter((name) => name.endsWith('.test.mjs') && !windowsPhase2Suites.has(name))
    .sort()
    .map((name) => path.join('tests', name));
  process.stdout.write([
    'Windows Phase 1: configuration, credential, ACL, and fail-closed tests are enabled.',
    `Windows Phase 2 runtime suites skipped: ${[...windowsPhase2Suites].sort().join(', ')}`,
    'Windows Phase 2 runtime suite skipped: spikes/external-child/test/external-child.test.mjs',
    '',
  ].join('\n'));
  args.push(...selected);
}

const child = spawnSync(process.execPath, args, {
  cwd: root,
  env: { ...process.env, DEEPSEEK_API_KEY: undefined },
  stdio: 'inherit',
  windowsHide: true,
});
process.exitCode = child.status ?? 1;
