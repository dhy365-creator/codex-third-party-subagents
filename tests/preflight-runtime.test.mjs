import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPreflight } from '../src/preflight-runtime.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';

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

function withCompatibleHost(overrides = {}) {
  return {
    inspectCustomAgentHostImpl: async () => customAgentHost(),
    ...overrides,
  };
}

function rateLimits({ sparkUsed = 100, generalUsed = 95 } = {}) {
  return {
    rateLimitsByLimitId: {
      spark: {
        limitId: 'spark',
        limitName: 'Codex Spark',
        primary: { usedPercent: sparkUsed },
      },
      codex: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: generalUsed },
      },
    },
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsw-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentPath = path.join(root, 'deepseek_worker.toml');
  const catalogPath = path.join(root, 'catalog.json');
  const configPath = path.join(root, 'worker.json');
  await fs.writeFile(agentPath, [
    'name = "deepseek_worker"',
    'description = "fixture"',
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    '',
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
  return config;
}

async function configureProProfile(config) {
  const root = path.dirname(config.agentPath);
  const agentPath = path.join(root, 'deepseek_pro_worker.toml');
  const catalogPath = path.join(root, 'deepseek-v4-pro.json');
  await fs.writeFile(agentPath, [
    'name = "deepseek_pro_worker"',
    'description = "fixture"',
    'model = "deepseek-v4-pro"',
    'model_provider = "deepseek"',
    '',
    'developer_instructions = """',
    'fixture',
    '"""',
  ].join('\n'));
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [{ slug: 'deepseek-v4-pro', input_modalities: ['text'] }],
  }));
  config.profiles.push({
    id: 'pro',
    providerRole: 'deepseek_pro_worker',
    model: 'deepseek-v4-pro',
    agentPath,
    catalogPath,
  });
}

function input(overrides = {}) {
  return {
    version: 1,
    operation: 'spawn',
    requestedAgent: 'spark-worker',
    taskName: 'bounded_task',
    message: 'bounded text and code task',
    cwd: '/tmp/worktree',
    deepseekSuitable: true,
    ...overrides,
  };
}

test('preflight prepares DeepSeek only after Spark is exhausted and quota is low', async (t) => {
  const config = await fixture(t);
  let bridgeRequest;
  const result = await runPreflight(input(), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    createBridgeImpl: async (request) => { bridgeRequest = request; },
  }));
  assert.equal(result.agentType, 'deepseek_worker');
  assert.equal(result.action, 'spawn');
  assert.equal(result.bridgePrepared, true);
  assert.deepEqual(result.worker, {
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    customAgentName: 'deepseek_worker',
  });
  assert.equal(bridgeRequest.message, 'bounded text and code task');
  assert.equal(bridgeRequest.model, 'deepseek-v4-flash');
});

test('preflight accepts legacy deepseekSuitable compatibility flag', async (t) => {
  const config = await fixture(t);
  const result = await runPreflight(input(), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    createBridgeImpl: async () => {},
    providerSuitable: undefined,
  }));
  assert.equal(result.bridgePrepared, true);
});

test('project Custom Agent layer forces OpenAI fallback before bridge creation', async (t) => {
  const config = await fixture(t);
  const project = path.join(path.dirname(config.agentPath), 'project');
  const projectAgents = path.join(project, '.codex', 'agents');
  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.mkdir(projectAgents, { recursive: true });
  await fs.writeFile(
    path.join(projectAgents, 'colliding-worker.toml'),
    'name = "deepseek_worker"\n',
  );
  let bridgeCreated = false;
  const result = await runPreflight(input({ cwd: project }), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    createBridgeImpl: async () => { bridgeCreated = true; },
  }));
  assert.equal(result.agentType, 'luna_worker');
  assert.equal(result.bridgePrepared, false);
  assert.equal(bridgeCreated, false);
  assert.match(result.reason, /project custom-agent layer/);
});

test('project Custom Agent inspection error also fails closed', async (t) => {
  const config = await fixture(t);
  const result = await runPreflight(input(), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    inspectProjectAgentLayersImpl: async () => { throw new Error('unreadable'); },
  }));
  assert.equal(result.agentType, 'luna_worker');
  assert.equal(result.bridgePrepared, false);
});

test('quota lookup failure keeps the requested OpenAI worker', async (t) => {
  const config = await fixture(t);
  const result = await runPreflight(input(), config, withCompatibleHost({
    readRateLimits: async () => { throw new Error('offline'); },
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
  }));
  assert.equal(result.agentType, 'spark-worker');
  assert.equal(result.bridgePrepared, false);
});

test('busy bridge safely falls back to Luna', async (t) => {
  const config = await fixture(t);
  const result = await runPreflight(input(), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => true,
  }));
  assert.equal(result.agentType, 'luna_worker');
  assert.equal(result.bridgePrepared, false);
});

test('bridge-compatible DeepSeek followup reuses its existing target', async (t) => {
  const config = await fixture(t);
  let bridgeRequest;
  const result = await runPreflight(input({
    operation: 'followup',
    existingAgentType: 'deepseek_worker',
    target: '/root/existing_task',
  }), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    hasArchivedImpl: async () => true,
    createBridgeImpl: async (request) => { bridgeRequest = request; },
  }));
  assert.equal(result.action, 'followup');
  assert.equal(result.target, '/root/existing_task');
  assert.equal(bridgeRequest.taskName, '/root/existing_task');
});

test('explicit Pro worker is allowed only after its configured profile is ready', async (t) => {
  const config = await fixture(t);
  await configureProProfile(config);
  let bridgeRequest;
  const result = await runPreflight(input({ requestedAgent: 'deepseek_pro_worker' }), config, withCompatibleHost({
    readRateLimits: async () => rateLimits({ sparkUsed: 0, generalUsed: 0 }),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
    createBridgeImpl: async (request) => { bridgeRequest = request; },
  }));
  assert.equal(result.agentType, 'deepseek_pro_worker');
  assert.equal(result.reason, 'explicit-provider-ready');
  assert.equal(result.bridgePrepared, true);
  assert.deepEqual(result.worker, {
    providerId: 'deepseek',
    providerRole: 'deepseek_pro_worker',
    model: 'deepseek-v4-pro',
    customAgentName: 'deepseek_pro_worker',
  });
  assert.equal(bridgeRequest.providerRole, 'deepseek_pro_worker');
  assert.equal(bridgeRequest.model, 'deepseek-v4-pro');
});

test('unconfigured Pro and unknown workers fail closed', async (t) => {
  const config = await fixture(t);
  await assert.rejects(
    runPreflight(input({ requestedAgent: 'deepseek_pro_worker' }), config),
    /unknown requested agent/,
  );
  await assert.rejects(
    runPreflight(input({ requestedAgent: 'not_a_worker' }), config),
    /unknown requested agent/,
  );
});

test('automatic low-quota fallback never selects Pro', async (t) => {
  const config = await fixture(t);
  await configureProProfile(config);
  const flash = config.profiles.find((profile) => profile.id === 'flash');
  await fs.unlink(flash.agentPath);
  const result = await runPreflight(input(), config, withCompatibleHost({
    readRateLimits: async () => rateLimits(),
    keychainReadyImpl: async () => true,
    bridgeBusyImpl: async () => false,
  }));
  assert.equal(result.agentType, 'luna_worker');
  assert.equal(result.bridgePrepared, false);
});

test('0.149 Host gate prevents provider bridge creation before routing', async (t) => {
  const config = await fixture(t);
  let bridgeCreated = false;
  let providerInspected = false;
  const result = await runPreflight(input(), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
    keychainReadyImpl: async () => { providerInspected = true; return true; },
    createBridgeImpl: async () => { bridgeCreated = true; },
  });
  assert.equal(result.agentType, 'spark-worker');
  assert.equal(result.bridgePrepared, false);
  assert.equal(providerInspected, false);
  assert.equal(bridgeCreated, false);
  assert.equal(result.hostCompatibility.level, 'LEVEL_C_HOST_BLOCKED');
  assert.match(result.reason, /host cross-provider subagent host_blocked/);
});

test('blocked Host denies an explicit provider request instead of falling back silently', async (t) => {
  const config = await fixture(t);
  let bridgeCreated = false;
  const result = await runPreflight(input({ requestedAgent: 'deepseek_worker' }), config, {
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
    createBridgeImpl: async () => { bridgeCreated = true; },
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.action, 'deny');
  assert.equal(result.agentType, undefined);
  assert.equal(result.bridgePrepared, undefined);
  assert.equal(bridgeCreated, false);
  assert.equal(result.hostCompatibility.level, 'LEVEL_C_HOST_BLOCKED');
  assert.match(result.reason, /host cross-provider subagent host_blocked/);
});
