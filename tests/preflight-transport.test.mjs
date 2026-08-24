import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPreflight } from '../src/preflight-runtime.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';

function customAgentHost(version) {
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preflight-transport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentPath = path.join(root, 'deepseek_worker.toml');
  const catalogPath = path.join(root, 'catalog.json');
  const configPath = path.join(root, 'worker.json');
  await fs.writeFile(agentPath, [
    'name = "deepseek_worker"',
    'description = "fixture"',
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    'developer_instructions = """',
    'fixture',
    '"""',
  ].join('\n'));
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [{ slug: 'deepseek-v4-flash', input_modalities: ['text'] }],
  }));
  const config = {
    threshold: 10,
    sparkAvailable: true,
    lunaAvailable: true,
    bridgePath: path.join(root, 'bridge'),
    agentPath,
    catalogPath,
    configPath,
    keychainAccount: 'fixture-user',
    keychainService: 'fixture-service',
    providerId: 'deepseek',
    platform: 'darwin',
    profiles: [{
      id: 'flash',
      providerRole: 'deepseek_worker',
      model: 'deepseek-v4-flash',
      agentPath,
      catalogPath,
    }],
    defaultProviderRole: 'deepseek_worker',
  };
  await fs.writeFile(configPath, JSON.stringify(config));
  return { root, config };
}

function request(root, overrides = {}) {
  return {
    version: 1,
    operation: 'spawn',
    requestedAgent: 'deepseek_worker',
    taskName: 'bounded_task',
    message: 'bounded text task',
    cwd: root,
    providerSuitable: true,
    ...overrides,
  };
}

test('compatible Native preflight returns an ALLOW Transport decision and preserves the tuple', async (t) => {
  const { root, config } = await setup(t);
  let bridgeRequest;
  const result = await runPreflight(request(root), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.147.0'),
    readRateLimits: async () => ({}),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    inspectProjectAgentLayersImpl: async () => ({ safe: true }),
    createBridgeImpl: async (value) => { bridgeRequest = value; },
  });
  assert.equal(result.transportDecision.decision, 'ALLOW');
  assert.equal(result.transportDecision.selectedTransport, 'native');
  assert.equal(result.transportDecision.providerId, 'deepseek');
  assert.equal(result.transportDecision.providerRole, 'deepseek_worker');
  assert.equal(result.transportDecision.model, 'deepseek-v4-flash');
  assert.equal(bridgeRequest.providerId, 'deepseek');
  assert.equal(bridgeRequest.model, 'deepseek-v4-flash');
});

test('explicit External request is blocked before credentials, bridge, or child execution', async (t) => {
  const { root, config } = await setup(t);
  let credentialChecked = false;
  let bridgeCreated = false;
  let quotaRead = false;
  const result = await runPreflight(request(root, {
    transportPreference: 'external',
    billableAuthorized: true,
  }), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.147.0'),
    readRateLimits: async () => { quotaRead = true; return {}; },
    keychainReadyImpl: async () => { credentialChecked = true; return true; },
    createBridgeImpl: async () => { bridgeCreated = true; },
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.transportDecision.decision, 'BLOCK');
  assert.equal(result.transportDecision.selectedTransport, null);
  assert.match(result.reason, /default-off/);
  assert.equal(credentialChecked, false);
  assert.equal(quotaRead, false);
  assert.equal(bridgeCreated, false);
});

test('0.149 auto policy reports both Native block and disabled External without provider inspection', async (t) => {
  const { root, config } = await setup(t);
  let credentialChecked = false;
  let bridgeCreated = false;
  const result = await runPreflight(request(root, {
    requestedAgent: 'spark-worker',
  }), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
    keychainReadyImpl: async () => { credentialChecked = true; return true; },
    createBridgeImpl: async () => { bridgeCreated = true; },
  });
  assert.equal(result.agentType, 'spark-worker');
  assert.equal(result.bridgePrepared, false);
  assert.equal(result.transportDecision.decision, 'BLOCK');
  assert.match(result.transportDecision.reason, /native=.*inherit provider configuration/);
  assert.match(result.transportDecision.reason, /external=.*default-off/);
  assert.equal(credentialChecked, false);
  assert.equal(bridgeCreated, false);
});

test('billable authorization alone cannot bypass the default-off production gate', async (t) => {
  const { root, config } = await setup(t);
  const result = await runPreflight(request(root, {
    transportPreference: 'external-codex',
    billableAuthorized: true,
  }), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.147.0'),
  });
  assert.equal(result.transportDecision.decision, 'BLOCK');
  assert.equal(result.transportDecision.billableAuthorized, true);
  assert.equal(result.action, 'deny');
});

test('an unsuitable explicit provider task is denied without Provider or Model substitution', async (t) => {
  const { root, config } = await setup(t);
  const result = await runPreflight(request(root, { providerSuitable: false }), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.147.0'),
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.transportDecision.decision, 'BLOCK');
  assert.equal(result.transportDecision.providerId, 'deepseek');
  assert.equal(result.transportDecision.model, 'deepseek-v4-flash');
  assert.match(result.reason, /not suitable/);
});

test('an explicit provider request with missing credential readiness is blocked, not substituted', async (t) => {
  const { root, config } = await setup(t);
  let bridgeCreated = false;
  const result = await runPreflight(request(root), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.147.0'),
    readRateLimits: async () => ({}),
    keychainReadyImpl: async () => false,
    bridgeBusyImpl: async () => false,
    createBridgeImpl: async () => { bridgeCreated = true; },
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.transportDecision.decision, 'BLOCK');
  assert.equal(result.transportDecision.providerReady, false);
  assert.equal(result.transportDecision.providerId, 'deepseek');
  assert.equal(result.transportDecision.model, 'deepseek-v4-flash');
  assert.equal(bridgeCreated, false);
});
