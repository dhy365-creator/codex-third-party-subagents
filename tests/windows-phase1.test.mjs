import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  credentialBackend,
  credentialReady,
  deleteCredential,
  retrieveCredential,
  storeCredential,
} from '../src/credentials.mjs';
import {
  CredentialBackendError,
  classifyWindowsCredentialError,
} from '../src/credentials/windows-credential-manager.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';
import { install } from '../src/installer.mjs';
import {
  captureWindowsSecurityDescriptor,
  privatePathReady,
} from '../src/platform-security.mjs';
import { runPreflight } from '../src/preflight-runtime.mjs';
import { uninstall } from '../src/uninstaller.mjs';
import { verify } from '../src/verifier.mjs';

const productionCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'production-catalog.json',
);

function host(version = '0.149.0') {
  const compatibility = evaluateHostCompatibility({ version, multiAgent: true });
  return {
    supported: compatibility.configurationInstallAllowed,
    version,
    multiAgent: true,
    multiAgentV2: false,
    compatibility,
    reason: compatibility.reason,
  };
}

function memoryCredentialBackend() {
  const values = new Map();
  return async (request) => {
    if (request.operation === 'write') {
      values.set(request.target, request.secret);
      return { status: 'OK' };
    }
    if (request.operation === 'read') {
      if (!values.has(request.target)) throw new CredentialBackendError('NOT_FOUND');
      return { status: 'OK', secret: values.get(request.target) };
    }
    if (request.operation === 'delete') {
      if (!values.delete(request.target)) throw new CredentialBackendError('NOT_FOUND');
      return { status: 'OK' };
    }
    throw new CredentialBackendError('INVALID_OPERATION');
  };
}

test('credential dispatch preserves Darwin, supports Win32, and rejects other platforms', async () => {
  let command;
  const darwin = await credentialReady({
    platform: 'darwin', account: 'fixture-user', service: 'fixture-service',
    execFileImpl: async (file, args) => { command = { file, args }; return { stdout: '' }; },
  });
  assert.equal(darwin, true);
  assert.equal(command.file, '/usr/bin/security');
  assert.deepEqual(command.args, ['find-generic-password', '-a', 'fixture-user', '-s', 'fixture-service']);
  assert.equal(credentialBackend('win32'), 'windows-credential-manager');
  assert.throws(() => credentialBackend('linux'), { code: 'CREDENTIAL_PLATFORM_UNSUPPORTED' });
});

test('Windows credential adapter writes, retrieves, matches, deletes, and classifies errors', async () => {
  const invokeImpl = memoryCredentialBackend();
  const target = `codex-third-party-subagents-phase1-unit-${crypto.randomUUID()}`;
  const source = crypto.randomBytes(32);
  await storeCredential({ platform: 'win32', target, account: 'fixture-user', secret: source, invokeImpl });
  const retrieved = await retrieveCredential({ platform: 'win32', target, invokeImpl });
  assert.equal(crypto.timingSafeEqual(source, retrieved), true);
  retrieved.fill(0);
  assert.equal(await credentialReady({ platform: 'win32', target, invokeImpl }), true);
  assert.equal(await deleteCredential({ platform: 'win32', target, invokeImpl }), true);
  assert.equal(await credentialReady({ platform: 'win32', target, invokeImpl }), false);
  assert.equal(await deleteCredential({ platform: 'win32', target, invokeImpl }), false);
  assert.equal(classifyWindowsCredentialError(new CredentialBackendError('ACCESS_DENIED')), 'ACCESS_DENIED');
  await assert.rejects(
    credentialReady({ platform: 'win32', target: 'unrelated-generic-credential', invokeImpl }),
    { code: 'INVALID_TARGET_NAMESPACE' },
  );
  const marker = 'synthetic-secret-must-not-appear';
  await assert.rejects(
    storeCredential({
      platform: 'win32', target, account: 'fixture-user', secret: marker,
      invokeImpl: async () => { throw new CredentialBackendError('ACCESS_DENIED'); },
    }),
    (error) => error.code === 'ACCESS_DENIED' && !error.message.includes(marker),
  );
  source.fill(0);
});

async function windowsFixture(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-windows-phase1-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return {
    homeDir,
    options: {
      homeDir,
      username: 'fixture-user',
      nodePath: process.execPath,
      platform: 'win32',
      env: { ...process.env, CODEX_THIRD_PARTY_WORKER_BRIDGE_ROOT: path.join(homeDir, 'bridge') },
      provider: 'deepseek',
      model: 'flash',
      transport: 'external',
      externalFlashBeta: true,
      plan: 'plus',
      sparkAvailable: false,
      lunaAvailable: true,
      threshold: 50,
      confirmMainPreserved: true,
      consentData: true,
      catalogSource: productionCatalog,
      credentialReadyImpl: async () => true,
      inspectCustomAgentHostImpl: async () => host(),
    },
  };
}

test('Windows installer apply is ACL-backed, idempotent, verifiable, and safely uninstallable', {
  skip: process.platform !== 'win32' && 'requires native Windows ACLs',
}, async (t) => {
  const fixture = await windowsFixture(t);
  const dry = await install(fixture.options);
  assert.equal(dry.dryRun, true);
  await assert.rejects(fs.stat(path.join(fixture.homeDir, '.codex')), /ENOENT/u);

  const first = await install({ ...fixture.options, apply: true });
  assert.equal(first.applied, true);
  assert.equal(first.credentialBackend, 'windows-credential-manager');
  assert.equal(first.transportPlan.external.featureEnabled, false);
  assert.equal(first.transportPlan.external.runtimeRouteEnabled, false);
  assert.equal(await privatePathReady(first.manifestPath, { kind: 'file', platform: 'win32' }), true);
  const agent = await fs.readFile(first.environment.agentPath, 'utf8');
  assert.match(agent, /credential-runtime-blocker\.mjs/u);
  assert.doesNotMatch(agent, /\/usr\/bin\/security/u);
  assert.doesNotMatch(agent, /DEEPSEEK_API_KEY/u);

  const second = await install({ ...fixture.options, apply: true });
  assert.equal(second.managedFiles.every((record) => record.changed === false), true);

  const checked = await verify({
    ...fixture.options,
    checkKeychain: true,
    credentialReadyImpl: async () => true,
  });
  assert.equal(checked.configured, true);
  assert.equal(checked.configurationReady, true);
  assert.equal(checked.ready, true);
  assert.equal(checked.credentialBackend, 'windows-credential-manager');
  assert.equal(checked.runtimeVerified, false);
  assert.equal(checked.providerRuntimeReady, false);
  assert.equal(checked.providerRuntimeStatus, 'BLOCKED_PENDING_PHASE_2');
  assert.equal(checked.transports.external.runtimeVerified, false);

  const doctor = await runDoctor({
    ...fixture.options,
    codexDetected: true,
    credentialReadyImpl: async () => true,
  });
  assert.equal(doctor.configurationSupported, true);
  assert.equal(doctor.providerRuntimeStatus, 'BLOCKED_PENDING_PHASE_2');
  assert.equal(doctor.checks.some((item) => item.name === 'Windows credential backend' && item.status === 'PASS'), true);

  const fresh = await verify({
    ...fixture.options,
    checkKeychain: true,
    credentialReadyImpl: async () => true,
  });
  assert.equal(fresh.configured, true);
  assert.equal(fresh.runtimeVerified, false);

  const uninstallOptions = { ...fixture.options, model: undefined };
  const removed = await uninstall({ ...uninstallOptions, apply: true });
  assert.equal(removed.applied, true);
  assert.equal(removed.keychainRemoved, false);
  const secondRemoval = await uninstall({ ...uninstallOptions, apply: true });
  assert.equal(secondRemoval.alreadyUninstalled, true);
  const remainingFiles = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target); else remainingFiles.push(target);
    }
  }
  await walk(fixture.homeDir);
  assert.deepEqual(remainingFiles, []);
});

test('Windows uninstall restores a pre-existing file security descriptor', {
  skip: process.platform !== 'win32' && 'requires native Windows ACLs',
}, async (t) => {
  const fixture = await windowsFixture(t);
  const codexDir = path.join(fixture.homeDir, '.codex');
  const agentsPath = path.join(codexDir, 'AGENTS.md');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(agentsPath, '# Existing user rules\n');
  const before = await captureWindowsSecurityDescriptor(agentsPath);

  await install({ ...fixture.options, apply: true });
  assert.notEqual(await captureWindowsSecurityDescriptor(agentsPath), before);
  await fs.appendFile(agentsPath, '# User edit after install\n');
  await install({ ...fixture.options, apply: true });
  await uninstall({ ...fixture.options, model: undefined, apply: true });

  assert.equal(
    await fs.readFile(agentsPath, 'utf8'),
    '# Existing user rules\n# User edit after install\n',
  );
  assert.equal(await captureWindowsSecurityDescriptor(agentsPath), before);
});

test('Windows install rejects a junction in the managed path before credential access', {
  skip: process.platform !== 'win32' && 'requires a native Windows junction',
}, async (t) => {
  const fixture = await windowsFixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-windows-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(fixture.homeDir, '.codex'), 'junction');
  let credentialChecked = false;
  await assert.rejects(install({
    ...fixture.options,
    apply: true,
    credentialReadyImpl: async () => { credentialChecked = true; return true; },
  }), /symlink|junction|reparse/u);
  assert.equal(credentialChecked, false);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('Windows preflight keeps live Provider runtime fail-closed even with a compatible mocked Host', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-windows-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentPath = path.join(root, 'deepseek_worker.toml');
  const catalogPath = path.join(root, 'catalog.json');
  const configPath = path.join(root, 'worker.json');
  await fs.writeFile(agentPath, 'name = "deepseek_worker"\ndescription = "fixture"\nmodel = "deepseek-v4-flash"\nmodel_provider = "deepseek"\ndeveloper_instructions = """fixture"""\n');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'deepseek-v4-flash', input_modalities: ['text'] }] }));
  let credentialChecked = false;
  let bridgeCreated = false;
  const result = await runPreflight({
    version: 1, operation: 'spawn', requestedAgent: 'deepseek_worker', taskName: 'bounded',
    message: 'bounded task', cwd: root, providerSuitable: true,
  }, {
    platform: 'win32', threshold: 50, sparkAvailable: false, lunaAvailable: true,
    bridgePath: path.join(root, 'bridge'), configPath, keychainAccount: 'fixture-user',
    providerId: 'deepseek', defaultProviderRole: 'deepseek_worker',
    profiles: [{ id: 'flash', providerRole: 'deepseek_worker', model: 'deepseek-v4-flash', agentPath, catalogPath }],
  }, {
    inspectCustomAgentHostImpl: async () => host('0.147.0'),
    credentialReadyImpl: async () => { credentialChecked = true; return true; },
    createBridgeImpl: async () => { bridgeCreated = true; },
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /Windows provider runtime is disabled/u);
  assert.equal(credentialChecked, false);
  assert.equal(bridgeCreated, false);
});
