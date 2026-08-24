import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/installer.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';

const fixtureCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog.json',
);
const productionCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'production-catalog.json',
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

async function setup(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-installer-transport-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const codexDir = path.join(homeDir, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  const configPath = path.join(codexDir, 'config.toml');
  const sentinel = 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n';
  await fs.writeFile(configPath, sentinel);
  return {
    homeDir,
    codexDir,
    configPath,
    sentinel,
    options: {
      homeDir,
      uid: process.getuid(),
      username: 'fixture-user',
      nodePath: process.execPath,
      platform: 'darwin',
      env: {
        ...process.env,
        CODEX_THIRD_PARTY_WORKER_BRIDGE_ROOT: path.join(homeDir, 'bridge'),
      },
      provider: 'deepseek',
      plan: 'plus',
      sparkAvailable: false,
      lunaAvailable: true,
      threshold: 50,
      confirmMainPreserved: true,
      consentData: true,
      catalogSource: fixtureCatalog,
      inspectCustomAgentHostImpl: async () => customAgentHost(),
    },
  };
}

test('Installer dry-run describes External prerequisites without activation or credential access', async (t) => {
  const fixture = await setup(t);
  let credentialChecked = false;
  const result = await install({
    ...fixture.options,
    transport: 'external',
    keychainReadyImpl: async () => { credentialChecked = true; return true; },
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.applied, false);
  assert.equal(result.transportPlan.requestedTransport, 'external-codex');
  assert.equal(result.transportPlan.configurationDecision, 'BLOCK');
  assert.equal(result.transportPlan.selectedTransport, null);
  assert.equal(result.transportPlan.external.featureEnabled, false);
  assert.equal(result.transportPlan.external.runtimeRouteEnabled, false);
  assert.equal(result.transportPlan.thirdPartyLiveRequests, 0);
  assert.equal(credentialChecked, false);
  assert.equal(await fs.readFile(fixture.configPath, 'utf8'), fixture.sentinel);
  await assert.rejects(
    fs.stat(path.join(fixture.codexDir, 'codex-third-party-workers-install.json')),
    /ENOENT/,
  );
});

test('Installer apply cannot activate the controlled External production path', async (t) => {
  const fixture = await setup(t);
  let credentialChecked = false;
  await assert.rejects(
    install({
      ...fixture.options,
      transport: 'external-codex',
      apply: true,
      keychainReadyImpl: async () => { credentialChecked = true; return true; },
    }),
    /separate controlled Flash E2E/,
  );
  assert.equal(credentialChecked, false);
  assert.equal(await fs.readFile(fixture.configPath, 'utf8'), fixture.sentinel);
  await assert.rejects(fs.stat(path.join(fixture.codexDir, 'agents')), /ENOENT/);
  await assert.rejects(
    fs.stat(path.join(fixture.codexDir, 'codex-third-party-workers-install.json')),
    /ENOENT/,
  );
});

test('explicit Flash Beta install writes configuration without enabling External routing', async (t) => {
  const fixture = await setup(t);
  const applied = await install({
    ...fixture.options,
    catalogSource: productionCatalog,
    transport: 'external',
    externalFlashBeta: true,
    apply: true,
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
    keychainReadyImpl: async () => true,
  });
  assert.equal(applied.applied, true);
  assert.equal(applied.transportPlan.externalFlashBetaConfiguration, true);
  assert.equal(applied.transportPlan.selectedTransport, null);
  assert.equal(applied.transportPlan.external.featureEnabled, false);
  assert.equal(applied.transportPlan.external.runtimeRouteEnabled, false);
  assert.equal(applied.transportPlan.thirdPartyLiveRequests, 0);
  const config = JSON.parse(await fs.readFile(applied.environment.configPath, 'utf8'));
  assert.equal(config.model, 'deepseek-v4-flash');
});

test('explicit Flash Beta install rejects an incomplete production catalog before writes', async (t) => {
  const fixture = await setup(t);
  let credentialChecked = false;
  await assert.rejects(install({
    ...fixture.options,
    transport: 'external',
    externalFlashBeta: true,
    apply: true,
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
    keychainReadyImpl: async () => { credentialChecked = true; return true; },
  }), (error) => error.code === 'PRODUCTION_CATALOG_INVALID');
  assert.equal(credentialChecked, false);
  assert.equal(await fs.readFile(fixture.configPath, 'utf8'), fixture.sentinel);
  await assert.rejects(
    fs.stat(path.join(fixture.codexDir, 'codex-third-party-workers-install.json')),
    /ENOENT/u,
  );
});

test('Flash Beta install flag is exact-tuple only', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(install({
    ...fixture.options,
    model: 'pro',
    transport: 'external',
    externalFlashBeta: true,
    apply: true,
    keychainReadyImpl: async () => true,
  }), /Public External installation remains disabled/u);
});

test('Installer keeps Native configuration behavior and reports blocked 0.149 analysis', async (t) => {
  const fixture = await setup(t);
  const native = await install({ ...fixture.options, transport: 'native' });
  assert.equal(native.transportPlan.configurationDecision, 'ALLOW');
  assert.equal(native.transportPlan.selectedTransport, 'native');
  const runtimeNames = native.managedFiles
    .filter((record) => record.kind === 'runtime')
    .map((record) => path.basename(record.path));
  assert.equal(runtimeNames.includes('transport-control-plane.mjs'), true);
  assert.equal(runtimeNames.includes('transport-contract.mjs'), true);
  assert.equal(runtimeNames.includes('transport-selection.mjs'), true);
  assert.equal(runtimeNames.some((name) => name.startsWith('external-')), false);

  const blocked = await install({
    ...fixture.options,
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
  });
  assert.equal(blocked.dryRun, true);
  assert.equal(blocked.transportPlan.configurationDecision, 'BLOCK');
  assert.equal(blocked.transportPlan.selectedTransport, null);
  assert.equal(blocked.transportPlan.thirdPartyLiveRequests, 0);
});

test('Installer rejects unknown Transport values before writing', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(
    install({ ...fixture.options, transport: 'provider-sidecar', apply: true }),
    /auto, native, or external/,
  );
  assert.equal(await fs.readFile(fixture.configPath, 'utf8'), fixture.sentinel);
});
