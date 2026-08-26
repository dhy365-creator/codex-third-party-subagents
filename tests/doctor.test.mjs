import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, parseDoctorArgs, formatDoctorSummary } from '../src/doctor.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';
import { install } from '../src/installer.mjs';

const fixtureCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog.json',
);

function customAgentHost(version = '0.147.0') {
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

async function setupHome(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-doctor-home-'));
  if (t?.after) t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const codexDir = path.join(homeDir, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'config.toml'), 'model = "gpt-4o"\nmodel_provider = "openai"\n');
  return homeDir;
}

async function snapshot(directory) {
  const entries = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const info = await fs.lstat(target);
      const relative = path.relative(directory, target);
      if (entry.isDirectory()) {
        entries.push([relative, 'directory', info.mode & 0o777]);
        await visit(target);
      } else {
        entries.push([relative, 'file', info.mode & 0o777, await fs.readFile(target, 'utf8')]);
      }
    }
  }
  await visit(directory);
  return entries;
}

test('parseDoctorArgs supports supported doctor flags', () => {
  const parsed = parseDoctorArgs([
    '--provider',
    'deepseek',
    '--model',
    'deepseek-v4-flash',
    '--home-dir',
    '/tmp/fixture-home',
    '--help',
  ]);
  assert.equal(parsed.provider, 'deepseek');
  assert.equal(parsed.model, 'deepseek-v4-flash');
  assert.equal(parsed.help, true);
  assert.equal(parsed['home-dir'], '/tmp/fixture-home');
  assert.throws(() => parseDoctorArgs(['--home-dir', 'relative']), /absolute path/);
});

test('doctor is blocked outside macOS', async () => {
  const homeDir = await setupHome({});
  const result = await runDoctor({
    homeDir,
    platform: 'linux',
    provider: 'deepseek',
    nodeVersion: 'v20.14.0',
    keychainReadyImpl: async () => true,
  });
  assert.equal(result.status, 'BLOCKED');
  const platformCheck = result.checks.find((check) => check.name === 'Operating system');
  assert.equal(platformCheck?.status, 'BLOCKED');
});

test('doctor reports keychain missing and uninstalled state', async (t) => {
  const homeDir = await setupHome(t);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => false,
  });
  assert.equal(result.installed, false);
  const stateCheck = result.checks.find((check) => check.name === 'Installation state');
  assert.equal(stateCheck?.status, 'WARN');
  const keychainCheck = result.checks.find((check) => check.name === 'Keychain credential');
  assert.equal(keychainCheck?.status, 'BLOCKED');
  assert.equal(keychainCheck?.detail.includes('missing'), true);
  assert.equal(result.status, 'BLOCKED');
});

test('doctor validates installed worker with no errors when prerequisites are met', {
  skip: process.platform === 'win32' && 'macOS installation permission semantics',
}, async (t) => {
  const homeDir = await setupHome(t);
  const options = {
    homeDir,
    uid: process.getuid?.(),
    username: 'fixture-user',
    nodePath: process.execPath,
    platform: 'darwin',
    env: {
      ...process.env,
      DEEPSEEK_WORKER_BRIDGE_ROOT: path.join(homeDir, 'fake-bridge'),
    },
    plan: 'plus',
    sparkAvailable: false,
    lunaAvailable: true,
    threshold: 50,
    confirmMainPreserved: true,
    consentData: true,
    catalogSource: fixtureCatalog,
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  };
  await install({ ...options, apply: true });
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    env: options.env,
    uid: options.uid,
    username: options.username,
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  });
  assert.equal(result.installed, true);
  assert.equal(result.status !== 'BLOCKED', true);
  const installCheck = result.checks.find((check) => check.name === 'Installation state');
  assert.equal(installCheck?.status, 'PASS');
  const verifyCheck = result.checks.find((check) => check.name === 'Verify prerequisites');
  assert.equal(verifyCheck?.status, 'PASS');
});

test('doctor does not expose private verifier issue paths', async (t) => {
  const homeDir = await setupHome(t);
  const options = {
    homeDir,
    uid: process.getuid?.(),
    username: 'fixture-user',
    nodePath: process.execPath,
    platform: 'darwin',
    env: {
      ...process.env,
      CODEX_THIRD_PARTY_WORKER_BRIDGE_ROOT: path.join(homeDir, 'fake-bridge'),
    },
    plan: 'plus',
    sparkAvailable: false,
    lunaAvailable: true,
    threshold: 50,
    confirmMainPreserved: true,
    consentData: true,
    catalogSource: fixtureCatalog,
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  };
  await install({ ...options, apply: true });
  const result = await runDoctor({
    ...options,
    provider: 'deepseek',
    verifyImpl: async () => ({
      configured: false,
      issues: [`managed file is missing: ${homeDir}/private-worker.toml`],
    }),
  });
  const output = formatDoctorSummary(result);
  assert.equal(output.includes(homeDir), false);
  assert.match(output, /1 local configuration issue/);
});

test('doctor blocks 0.149 cross-provider use even when multi_agent is enabled', async (t) => {
  const homeDir = await setupHome(t);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
  });
  assert.equal(result.checks.find((check) => check.name === 'Multi-agent availability')?.status, 'PASS');
  const hostCheck = result.checks.find((check) => check.name === 'Host cross-provider subagent');
  assert.equal(hostCheck?.status, 'BLOCKED');
  assert.match(hostCheck?.detail ?? '', /inherit provider configuration/);
});

test('doctor blocks an unknown Host when capability inspection fails', async (t) => {
  const homeDir = await setupHome(t);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => { throw new Error('unavailable'); },
  });
  const hostCheck = result.checks.find((check) => check.name === 'Host cross-provider subagent');
  assert.equal(hostCheck?.status, 'BLOCKED');
  assert.match(hostCheck?.detail ?? '', /unknown/);
});

test('doctor blocks when model does not match selected provider', async (t) => {
  const homeDir = await setupHome(t);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    model: 'not-supported-model',
    keychainReadyImpl: async () => true,
  });
  const modelCheck = result.checks.find((check) => check.name === 'Model');
  assert.equal(modelCheck?.status, 'BLOCKED');
  assert.equal(result.status, 'BLOCKED');
});

test('doctor reports the selected Pro worker and keeps Flash distinct', {
  skip: process.platform === 'win32' && 'macOS installation permission semantics',
}, async (t) => {
  const homeDir = await setupHome(t);
  const options = {
    homeDir,
    uid: process.getuid?.(),
    username: 'fixture-user',
    nodePath: process.execPath,
    platform: 'darwin',
    env: {
      ...process.env,
      DEEPSEEK_WORKER_BRIDGE_ROOT: path.join(homeDir, 'fake-bridge'),
    },
    plan: 'plus',
    sparkAvailable: false,
    lunaAvailable: true,
    threshold: 50,
    confirmMainPreserved: true,
    consentData: true,
    catalogSource: fixtureCatalog,
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  };
  await install({ ...options, apply: true });
  await install({ ...options, model: 'pro', apply: true });
  const pro = await runDoctor({ ...options, provider: 'deepseek', model: 'pro' });
  assert.equal(pro.model, 'deepseek-v4-pro');
  assert.equal(pro.worker, 'deepseek_pro_worker');
  assert.equal(pro.profile, 'pro');
  assert.equal(pro.checks.find((check) => check.name === 'Expected worker')?.status, 'PASS');
  assert.equal(pro.checks.find((check) => check.name === 'Installation state')?.status, 'PASS');

  const flash = await runDoctor({ ...options, provider: 'deepseek', model: 'flash' });
  assert.equal(flash.model, 'deepseek-v4-flash');
  assert.equal(flash.worker, 'deepseek_worker');
});

test('doctor blocks an explicit Pro selection when only Flash is installed', {
  skip: process.platform === 'win32' && 'macOS installation permission semantics',
}, async (t) => {
  const homeDir = await setupHome(t);
  const options = {
    homeDir,
    uid: process.getuid?.(),
    username: 'fixture-user',
    nodePath: process.execPath,
    platform: 'darwin',
    env: {
      ...process.env,
      DEEPSEEK_WORKER_BRIDGE_ROOT: path.join(homeDir, 'fake-bridge'),
    },
    plan: 'plus',
    sparkAvailable: false,
    lunaAvailable: true,
    threshold: 50,
    confirmMainPreserved: true,
    consentData: true,
    catalogSource: fixtureCatalog,
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  };
  await install({ ...options, apply: true });
  const result = await runDoctor({ ...options, provider: 'deepseek', model: 'pro' });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.checks.find((check) => check.name === 'Installation state')?.detail, 'selected model profile is not installed');
});

test('doctor summary output does not leak private paths', async (t) => {
  const homeDir = await setupHome(t);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
  });
  const output = formatDoctorSummary(result);
  assert.equal(output.includes(homeDir), false);
  assert.equal(output.includes(os.tmpdir()), false);
});

test('doctor does not modify the inspected home', async (t) => {
  const homeDir = await setupHome(t);
  const before = await snapshot(homeDir);
  await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
  });
  assert.deepEqual(await snapshot(homeDir), before);
});

test('doctor Keychain lookup asks only whether the item exists', async (t) => {
  const homeDir = await setupHome(t);
  let capturedArgs;
  await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    execFileImpl: async (_command, args) => {
      capturedArgs = args;
      return { stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(capturedArgs.slice(0, 1), ['find-generic-password']);
  assert.equal(capturedArgs.includes('-w'), false);
  assert.equal(capturedArgs.includes('-g'), false);
});
