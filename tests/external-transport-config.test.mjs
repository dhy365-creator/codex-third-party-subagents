import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EXTERNAL_CODEX_TRANSPORT_ENABLED,
  EXTERNAL_ERROR_CODES,
  createExternalCodexTransport,
} from '../src/transports/external-codex.mjs';
import { assertPrivateTree } from '../src/transports/external-fs-safety.mjs';
import {
  describeTransportRegistry,
  resolveEnabledTransportFactory,
} from '../src/transports/index.mjs';
import { createExternalTransportFixture } from './helpers/external-transport-fixture.mjs';

test('External adapter registry is disabled and factory creation has no side effects', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  assert.equal(EXTERNAL_CODEX_TRANSPORT_ENABLED, false);
  assert.deepEqual(describeTransportRegistry().map((entry) => entry.name), ['external-codex']);
  assert.throws(
    () => resolveEnabledTransportFactory('external-codex'),
    (error) => error.code === EXTERNAL_ERROR_CODES.DISABLED,
  );
  await assert.rejects(fs.access(fixture.stateRoot));
  assert.equal(fixture.adapter.describe().enabled, false);
  assert.equal(fixture.adapter.describe().billable, true);
  await assert.rejects(fs.access(fixture.stateRoot));
});

test('prepare creates an owner-only isolated tree and minimal provider config', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const parentBefore = await fs.readFile(path.join(fixture.parentCodexHome, 'config.toml'), 'utf8');
  const prepared = await fixture.adapter.prepare(fixture.request(), fixture.context);
  const root = fixture.executionRoot(prepared.executionId);
  const config = await fs.readFile(path.join(root, 'home', 'config.toml'), 'utf8');
  for (const directory of ['home', 'results', 'logs', 'evidence', 'archive']) {
    assert.equal((await fs.lstat(path.join(root, directory))).mode & 0o777, 0o700);
  }
  assert.equal((await assertPrivateTree(root)).pass, true);
  assert.match(config, /model = "deepseek-v4-flash"/u);
  assert.match(config, /model_provider = "deepseek"/u);
  assert.match(config, /sandbox_mode = "read-only"/u);
  assert.match(config, /plugins = false/u);
  assert.match(config, /request_max_retries = 0/u);
  assert.match(config, /stream_max_retries = 0/u);
  assert.match(config, /fake-credential/u);
  assert.doesNotMatch(config, /must-not-be-inherited|sk-[A-Za-z0-9_-]{20,}/u);
  for (const name of ['AGENTS.md', 'agents', 'plugins', 'skills', 'hooks', 'memory', 'marketplaces']) {
    await assert.rejects(fs.access(path.join(root, 'home', name)));
  }
  assert.equal(await fs.readFile(path.join(fixture.parentCodexHome, 'config.toml'), 'utf8'), parentBefore);
});

test('prepare rejects invalid tuples, permissions, timeouts, fields, and credential-like task data', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const attempts = [
    fixture.request({ providerRole: 'deepseek_pro_worker' }),
    fixture.request({ permissionProfile: 'danger-full-access' }),
    fixture.request({ timeoutMs: 9999 }),
    { ...fixture.request(), unknownTransportField: true },
    fixture.request({ message: `token=${'a'.repeat(32)}` }),
    fixture.request({ taskName: `sk-${'x'.repeat(24)}` }),
  ];
  for (const request of attempts) {
    await assert.rejects(
      fixture.adapter.prepare(request, fixture.context),
      (error) => error.code === EXTERNAL_ERROR_CODES.PREPARE,
    );
  }
  await assert.rejects(fs.access(fixture.stateRoot));
});

test('prepare rejects cwd and expectedScope symlink escapes before slot acquisition', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const outside = path.join(fixture.base, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  const cwdLink = path.join(fixture.approvedRoot, 'cwd-link');
  await fs.symlink(fixture.cwd, cwdLink);
  await assert.rejects(
    fixture.adapter.prepare(fixture.request({ cwd: cwdLink }), fixture.context),
    (error) => error.code === EXTERNAL_ERROR_CODES.PREPARE,
  );
  const scopeLink = path.join(fixture.cwd, 'escape');
  await fs.symlink(outside, scopeLink);
  await assert.rejects(
    fixture.adapter.prepare(fixture.request({ expectedScope: ['escape/file.txt'] }), fixture.context),
    (error) => error.code === EXTERNAL_ERROR_CODES.PREPARE,
  );
  await assert.rejects(
    fixture.adapter.prepare(
      fixture.request({ cwd: '/' }),
      { approvedRoot: '/', parentCodexHome: fixture.parentCodexHome },
    ),
    (error) => error.code === EXTERNAL_ERROR_CODES.PREPARE,
  );
  await assert.rejects(
    fixture.adapter.prepare(
      fixture.request(),
      { approvedRoot: '/', parentCodexHome: fixture.parentCodexHome },
    ),
    (error) => error.code === EXTERNAL_ERROR_CODES.PREPARE,
  );
  await assert.rejects(fs.access(path.join(fixture.stateRoot, 'active.json')));
});

test('production execution gate blocks child spawn even after non-billable preparation', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const adapter = createExternalCodexTransport({
    stateRoot: fixture.stateRoot,
    codexPath: fixture.codexPath,
    catalogSource: path.resolve('tests/fixtures/catalog.json'),
    credentialCommand: {
      kind: 'keychain',
      command: '/usr/bin/security',
      args: ['find-generic-password', '-a', 'fixture-user', '-s', 'codex-deepseek-api-key', '-w'],
    },
  });
  const prepared = await adapter.prepare(fixture.request(), fixture.context);
  await assert.rejects(
    adapter.execute(prepared),
    (error) => error.code === EXTERNAL_ERROR_CODES.DISABLED,
  );
  await assert.rejects(fs.access(path.join(fixture.executionRoot(prepared.executionId), 'home', 'capture.json')));
});
