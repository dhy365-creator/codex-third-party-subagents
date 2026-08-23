import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTERNAL_CODEX_TRANSPORT_ENABLED,
} from '../src/transports/external-codex.mjs';
import {
  TRANSPORT_REGISTRY,
  describeTransportRegistry,
} from '../src/transports/index.mjs';
import { EXTERNAL_CONTROL_PLANE } from '../src/transport-control-plane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Phase 1 registry and Phase 2 control-plane gates agree that External is unreachable', () => {
  const entry = TRANSPORT_REGISTRY['external-codex'];
  assert.equal(EXTERNAL_CODEX_TRANSPORT_ENABLED, false);
  assert.equal(entry.enabled, false);
  assert.equal(entry.factory, null);
  assert.equal(EXTERNAL_CONTROL_PLANE.featureEnabled, false);
  assert.equal(EXTERNAL_CONTROL_PLANE.runtimeRouteEnabled, false);
  assert.equal(EXTERNAL_CONTROL_PLANE.factoryAvailable, false);
  assert.equal(describeTransportRegistry()[0].enabled, false);
});

test('active control-plane modules do not import or instantiate the External adapter', async () => {
  const activeFiles = [
    'src/doctor.mjs',
    'src/verifier.mjs',
    'src/preflight-runtime.mjs',
    'src/installer.mjs',
    'src/transport-control-plane.mjs',
    'src/transport-readiness.mjs',
    'src/transport-verification.mjs',
  ];
  for (const relative of activeFiles) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /createExternalCodexTransport/u, relative);
    assert.doesNotMatch(source, /resolveEnabledTransportFactory/u, relative);
    assert.doesNotMatch(source, /from ['"].*\/transports\/external-codex\.mjs['"]/u, relative);
  }
});

test('control-plane source contains no Provider request implementation', async () => {
  const files = [
    'src/transport-control-plane.mjs',
    'src/transport-readiness.mjs',
    'src/transport-verification.mjs',
  ];
  const source = (await Promise.all(files.map((relative) => (
    fs.readFile(path.join(root, relative), 'utf8')
  )))).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /https?\.request\s*\(/u);
  assert.doesNotMatch(source, /\bspawn\s*\(/u);
  assert.doesNotMatch(source, /\.execute\s*\(/u);
});
