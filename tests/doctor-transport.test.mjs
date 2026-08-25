import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDoctor } from '../src/doctor.mjs';
import { writeExternalFlashEvidence } from '../src/external-evidence-store.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';

function customAgentHost(version = '0.149.0') {
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-doctor-transport-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const codexDir = path.join(homeDir, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'config.toml'), 'model = "gpt-5.6-sol"\n');
  return { homeDir, codexDir };
}

function check(result, name) {
  return result.checks.find((entry) => entry.name === name);
}

function strictEvidence() {
  return {
    schemaVersion: 1,
    taskName: 'phase3-flash-e2e-fixture',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: 'external-codex',
    configured: true,
    discoverable: null,
    providerResolved: true,
    taskDelivered: true,
    runtimeExecuted: true,
    runtimeVerified: true,
    configurationReady: true,
    ready: true,
    evidenceSource: 'local-installation',
    credentialReady: true,
    hostVersion: '0.149.0',
    codexBinary: 'codex',
    verifiedAt: '2026-08-24T00:00:00.000Z',
    providerAttribution: {
      sessionRef: 'runtime:session:fixture',
      providers: ['deepseek'],
      models: ['deepseek-v4-flash'],
      endpointRef: 'runtime:config:fixture',
    },
    acceptance: {
      resultValid: true,
      workspaceScopeValid: true,
      lifecycleValid: true,
      credentialSafetyValid: true,
      parentIsolationValid: true,
    },
    evidenceRefs: [{ kind: 'runtime', ref: 'runtime:fixture', sha256: 'a'.repeat(64) }],
  };
}

test('Doctor reports Native and disabled External Transport separately on 0.149', async (t) => {
  const { homeDir } = await setupHome(t);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  });
  assert.equal(check(result, 'Native Transport eligibility')?.status, 'BLOCKED');
  assert.equal(check(result, 'External Transport module')?.status, 'PASS');
  assert.equal(check(result, 'External feature gate')?.status, 'WARN');
  assert.equal(check(result, 'External Codex exec prerequisite')?.status, 'PASS');
  assert.equal(check(result, 'External isolated runtime root')?.status, 'WARN');
  assert.equal(check(result, 'External permission profile')?.status, 'PASS');
  assert.equal(check(result, 'External provider tuple')?.status, 'PASS');
  assert.equal(check(result, 'External credential readiness')?.status, 'PASS');
  assert.equal(check(result, 'External maintainer evidence')?.status, 'PASS');
  assert.equal(check(result, 'External local runtime evidence')?.status, 'WARN');
  assert.equal(check(result, 'External Transport eligibility')?.status, 'WARN');
  assert.equal(result.transports.external.featureGate.enabled, false);
  assert.equal(result.transports.external.eligibility.eligible, false);
  assert.equal(result.transports.external.localEvidence.runtimeVerified, false);
});

test('Doctor read-only inspection recognizes an existing owner-only External runtime root', async (t) => {
  const { homeDir, codexDir } = await setupHome(t);
  const runtimeRoot = path.join(codexDir, 'external-transports', 'codex-third-party-workers');
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeRoot, 0o700);
  const before = await fs.stat(runtimeRoot);
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  });
  assert.equal(check(result, 'External isolated runtime root')?.status, 'PASS');
  const after = await fs.stat(runtimeRoot);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('Doctor reads strict stored Flash evidence without making a live request', async (t) => {
  const { homeDir, codexDir } = await setupHome(t);
  const runtimeRoot = path.join(codexDir, 'external-transports', 'codex-third-party-workers');
  await writeExternalFlashEvidence(runtimeRoot, strictEvidence());
  const result = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  });
  assert.equal(check(result, 'External local runtime evidence')?.status, 'PASS');
  assert.equal(result.transports.external.localEvidence.runtimeVerified, true);
  assert.equal(result.transports.external.eligibility.eligible, false);
});

test('Doctor fails closed on result-like External evidence and keeps Pro evidence unknown', async (t) => {
  const { homeDir } = await setupHome(t);
  const invalid = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
    externalTransportEvidence: {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      runtimeVerified: true,
    },
  });
  assert.equal(check(invalid, 'External local runtime evidence')?.status, 'BLOCKED');
  assert.equal(invalid.transports.external.localEvidence.providerResolved, false);

  const pro = await runDoctor({
    homeDir,
    platform: 'darwin',
    provider: 'deepseek',
    model: 'pro',
    keychainReadyImpl: async () => true,
    inspectCustomAgentHostImpl: async () => customAgentHost(),
  });
  assert.equal(check(pro, 'External maintainer evidence')?.status, 'WARN');
  assert.equal(pro.transports.external.maintainerEvidence.runtimeEvidence, 'UNKNOWN');
});
