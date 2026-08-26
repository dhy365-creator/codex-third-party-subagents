import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../src/installer.mjs';
import { uninstall } from '../src/uninstaller.mjs';
import { verify } from '../src/verifier.mjs';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';
import { AGENTS_START, AGENTS_END } from '../src/templates.mjs';

const fixtureCatalog = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'catalog.json',
);
const minimaxFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'minimax-codex.md',
);
const qwenFixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'qwen-model-doc.html',
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dsw-home-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const codexDir = path.join(homeDir, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  const configToml = path.join(codexDir, 'config.toml');
  const sentinel = 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n';
  await fs.writeFile(configToml, sentinel);
  await fs.writeFile(path.join(codexDir, 'AGENTS.md'), '# Existing user rules\n');
  const env = {
    ...process.env,
    DEEPSEEK_WORKER_BRIDGE_ROOT: path.join(homeDir, 'fake-bridge'),
  };
  const options = {
    homeDir,
    uid: process.getuid?.(),
    username: 'fixture-user',
    nodePath: process.execPath,
    platform: 'darwin',
    env,
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
  return { homeDir, codexDir, configToml, sentinel, options };
}

test('dry-run writes nothing, apply is idempotent, verify is honest, and uninstall is safe', async (t) => {
  const fixture = await setup(t);
  const dry = await install(fixture.options);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.applied, false);
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  await assert.rejects(fs.stat(dry.manifestPath), /ENOENT/);

  const applied = await install({ ...fixture.options, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  assert.equal((await fs.stat(applied.manifestPath)).mode & 0o777, 0o600);
  const agent = await fs.readFile(applied.environment.agentPath, 'utf8');
  assert.match(agent, /model_provider = "deepseek"/);
  assert.match(agent, /fixture-user/);
  assert.doesNotMatch(agent, /gpt-5\.6-sol/);
  const catalog = JSON.parse(await fs.readFile(applied.environment.catalogPath, 'utf8'));
  assert.deepEqual(catalog.models.map((model) => model.slug), ['deepseek-v4-flash']);
  await assert.rejects(
    fs.stat(path.join(fixture.codexDir, 'agents', 'deepseek_pro_worker.toml')),
    /ENOENT/,
  );

  const checked = await verify({
    ...fixture.options,
    checkKeychain: true,
    keychainReadyImpl: async () => true,
  });
  assert.equal(checked.configured, true);
  assert.equal(checked.configurationReady, true);
  assert.equal(checked.ready, true);
  assert.equal(checked.discoverable, true);
  assert.equal(checked.providerResolved, null);
  assert.equal(checked.runtimeVerified, false);
  assert.deepEqual(checked.agentEvidence.map((evidence) => ({
    providerRole: evidence.providerRole,
    model: evidence.model,
    runtimeVerified: evidence.runtimeVerified,
  })), [{
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    runtimeVerified: false,
  }]);
  assert.equal(checked.runtimeEvidence.model, 'deepseek-v4-flash');
  assert.equal(checked.runtimeEvidence.hostRuntimeMetadata, null);
  assert.equal(checked.transport, 'native');
  assert.equal(checked.providerId, 'deepseek');
  assert.equal(checked.model, 'deepseek-v4-flash');
  assert.equal(checked.transports.native.ready, true);
  assert.equal(checked.transports.external.modulePresent, true);
  assert.equal(checked.transports.external.featureEnabled, false);
  assert.equal(checked.transports.external.localEvidenceAvailable, false);
  assert.equal(checked.transports.external.runtimeVerified, false);
  assert.match(checked.warnings.join('\n'), /runtime remains unverified/);

  await fs.appendFile(path.join(fixture.codexDir, 'AGENTS.md'), '# Later user rule\n');
  await install({ ...fixture.options, apply: true });
  const agents = await fs.readFile(path.join(fixture.codexDir, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split(AGENTS_START).length - 1, 1);

  const uninstallDry = await uninstall({ ...fixture.options });
  assert.equal(uninstallDry.dryRun, true);
  assert.equal(uninstallDry.applied, false);
  const removed = await uninstall({ ...fixture.options, apply: true });
  assert.equal(removed.applied, true);
  assert.equal(removed.keychainRemoved, false);
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  const finalAgents = await fs.readFile(path.join(fixture.codexDir, 'AGENTS.md'), 'utf8');
  assert.match(finalAgents, /# Existing user rules/);
  assert.match(finalAgents, /# Later user rule/);
  assert.doesNotMatch(finalAgents, new RegExp(AGENTS_START));
  assert.doesNotMatch(finalAgents, new RegExp(AGENTS_END));
  await assert.rejects(fs.stat(applied.environment.agentPath), /ENOENT/);
  await assert.rejects(fs.stat(applied.manifestPath), /ENOENT/);
  await assert.rejects(fs.stat(applied.environment.runtimeDir), /ENOENT/);
});

test('installer allows blocked-Host analysis but fails before an active installation', async (t) => {
  const fixture = await setup(t);
  const blocked = {
    ...fixture.options,
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
  };
  const dry = await install(blocked);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.customAgents.host.compatibility.level, 'LEVEL_C_HOST_BLOCKED');
  await assert.rejects(
    install({ ...blocked, apply: true }),
    /Host cross-provider subagent installation is blocked/,
  );
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  await assert.rejects(fs.stat(path.join(fixture.codexDir, 'agents')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(fixture.codexDir, 'codex-third-party-workers-install.json')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(fixture.homeDir, 'fake-bridge')), /ENOENT/);
});

test('verifier keeps local configuration separate from a blocked 0.149 provider resolution', async (t) => {
  const fixture = await setup(t);
  await install({ ...fixture.options, apply: true });
  const checked = await verify({
    ...fixture.options,
    inspectCustomAgentHostImpl: async () => customAgentHost('0.149.0'),
    checkKeychain: true,
    keychainReadyImpl: async () => true,
  });
  assert.equal(checked.configured, true);
  assert.equal(checked.discoverable, true);
  assert.equal(checked.providerResolved, false);
  assert.equal(checked.taskDelivered, false);
  assert.equal(checked.runtimeExecuted, false);
  assert.equal(checked.runtimeVerified, false);
  assert.equal(checked.configurationReady, false);
  assert.equal(checked.ready, false);
  assert.match(checked.issues.join('\n'), /Host cross-provider subagent host_blocked/);
});

test('verifier rejects result self-report as External runtime evidence', async (t) => {
  const fixture = await setup(t);
  await install({ ...fixture.options, apply: true });
  const checked = await verify({
    ...fixture.options,
    checkKeychain: true,
    keychainReadyImpl: async () => true,
    externalTransportEvidence: {
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      runtimeVerified: true,
    },
  });
  assert.equal(checked.configured, false);
  assert.equal(checked.transports.external.providerResolved, false);
  assert.equal(checked.transports.external.runtimeVerified, false);
  assert.match(checked.issues.join('\n'), /failed strict validation/);
});

test('explicit Pro install creates only the dedicated Pro worker and verifies it separately', async (t) => {
  const fixture = await setup(t);
  const options = { ...fixture.options, model: 'pro' };
  const dry = await install(options);
  assert.equal(dry.profile.providerRole, 'deepseek_pro_worker');
  assert.deepEqual(dry.profiles, [{
    id: 'pro', providerRole: 'deepseek_pro_worker', model: 'deepseek-v4-pro',
  }]);

  const applied = await install({ ...options, apply: true });
  const agent = await fs.readFile(applied.environment.agentPath, 'utf8');
  assert.match(agent, /name = "deepseek_pro_worker"/);
  assert.match(agent, /model = "deepseek-v4-pro"/);
  const catalog = JSON.parse(await fs.readFile(applied.environment.catalogPath, 'utf8'));
  assert.deepEqual(catalog.models.map((model) => model.slug), ['deepseek-v4-pro']);
  const config = JSON.parse(await fs.readFile(applied.environment.configPath, 'utf8'));
  assert.equal(config.defaultProviderRole, null);
  assert.deepEqual(config.profiles.map((profile) => profile.providerRole), ['deepseek_pro_worker']);

  const pro = await verify({ ...options, checkKeychain: true, keychainReadyImpl: async () => true });
  assert.equal(pro.configured, true);
  assert.deepEqual(pro.profile, {
    id: 'pro', providerRole: 'deepseek_pro_worker', model: 'deepseek-v4-pro',
  });
  const flash = await verify({ ...fixture.options, checkKeychain: true, keychainReadyImpl: async () => true });
  assert.equal(flash.configured, false);
  assert.match(flash.issues.join('\n'), /selected provider model profile is not installed/);

  const removed = await uninstall({ ...fixture.options, apply: true });
  assert.equal(removed.applied, true);
  await assert.rejects(fs.stat(applied.environment.agentPath), /ENOENT/);
});

test('adding explicit Pro preserves Flash as the default fallback and removes both on rollback', async (t) => {
  const fixture = await setup(t);
  await install({ ...fixture.options, apply: true });
  const proApplied = await install({ ...fixture.options, model: 'pro', apply: true });
  const agentsDir = path.join(fixture.codexDir, 'agents');
  const flashAgent = await fs.readFile(path.join(agentsDir, 'deepseek_worker.toml'), 'utf8');
  const proAgent = await fs.readFile(path.join(agentsDir, 'deepseek_pro_worker.toml'), 'utf8');
  assert.match(flashAgent, /model = "deepseek-v4-flash"/);
  assert.match(proAgent, /model = "deepseek-v4-pro"/);
  const config = JSON.parse(await fs.readFile(proApplied.environment.configPath, 'utf8'));
  assert.equal(config.defaultProviderRole, 'deepseek_worker');
  assert.deepEqual(config.profiles.map((profile) => profile.model), [
    'deepseek-v4-flash', 'deepseek-v4-pro',
  ]);

  const flash = await verify({ ...fixture.options, checkKeychain: true, keychainReadyImpl: async () => true });
  const pro = await verify({ ...fixture.options, model: 'pro', checkKeychain: true, keychainReadyImpl: async () => true });
  assert.equal(flash.configured, true);
  assert.equal(pro.configured, true);

  const removed = await uninstall({ ...fixture.options, apply: true });
  assert.equal(removed.applied, true);
  await assert.rejects(fs.stat(path.join(agentsDir, 'deepseek_worker.toml')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(agentsDir, 'deepseek_pro_worker.toml')), /ENOENT/);
  await assert.rejects(fs.stat(proApplied.environment.runtimeDir), /ENOENT/);
});

test('Pro installation preserves pre-existing parent directory modes through rollback', async (t) => {
  const fixture = await setup(t);
  const parents = [
    [fixture.codexDir, 0o750],
    [path.join(fixture.codexDir, 'agents'), 0o755],
    [path.join(fixture.codexDir, 'model-catalogs'), 0o750],
    [path.join(fixture.codexDir, 'bin'), 0o755],
    [path.join(fixture.codexDir, 'lib', 'codex-third-party-workers'), 0o750],
    [path.join(fixture.codexDir, 'codex-third-party-workers-backups'), 0o755],
  ];
  for (const [directory, mode] of parents) {
    await fs.mkdir(directory, { recursive: true });
    await fs.chmod(directory, mode);
  }
  await install({ ...fixture.options, model: 'pro', apply: true });
  for (const [directory, mode] of parents) {
    assert.equal((await fs.stat(directory)).mode & 0o777, mode);
  }
  await uninstall({ ...fixture.options, apply: true });
  for (const [directory, mode] of parents) {
    assert.equal((await fs.stat(directory)).mode & 0o777, mode);
  }
});

test('installer rejects invalid model selections and DeepSeek-only model aliases on other providers', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(install({ ...fixture.options, model: 'unknown' }), /unsupported model/);
  await assert.rejects(install({ ...fixture.options, provider: 'minimax', model: 'pro' }), /unsupported model/);
});

test('uninstall reports conflicts and performs no partial removal', async (t) => {
  const fixture = await setup(t);
  const applied = await install({ ...fixture.options, apply: true });
  await fs.appendFile(applied.environment.agentPath, '# user change\n');
  const result = await uninstall({ ...fixture.options, apply: true });
  assert.equal(result.applied, false);
  assert.match(result.conflicts.join('\n'), /managed file was modified/);
  assert.equal(JSON.stringify(result).includes(fixture.homeDir), false);
  await fs.stat(applied.environment.preflightPath);
  await fs.stat(applied.manifestPath);
});

test('a matching legacy Custom Agent needs explicit migration and restores from backup', async (t) => {
  const fixture = await setup(t);
  const agentsDir = path.join(fixture.codexDir, 'agents');
  const agentPath = path.join(agentsDir, 'deepseek_worker.toml');
  const legacy = [
    'name = "deepseek_worker"',
    'description = "legacy fixture"',
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    '',
    'developer_instructions = """',
    'legacy fixture',
    '"""',
    '',
  ].join('\n');
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(agentPath, legacy, { mode: 0o600 });

  await assert.rejects(
    install({ ...fixture.options, apply: true }),
    /--migrate-legacy/,
  );
  assert.equal(await fs.readFile(agentPath, 'utf8'), legacy);

  const applied = await install({ ...fixture.options, apply: true, migrateLegacy: true });
  assert.deepEqual(applied.migration.candidates, ['deepseek_worker']);
  assert.equal(applied.migration.applied, true);
  const agentRecord = applied.managedFiles.find((record) => record.kind === 'agent');
  assert.ok(agentRecord?.backup);

  const removed = await uninstall({ ...fixture.options, apply: true });
  assert.equal(removed.applied, true);
  assert.equal(await fs.readFile(agentPath, 'utf8'), legacy);
});

test('a mismatched Custom Agent filename fails closed instead of being adopted', async (t) => {
  const fixture = await setup(t);
  const agentsDir = path.join(fixture.codexDir, 'agents');
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, 'deepseek_worker.toml'), [
    'name = "different_worker"',
    'description = "fixture"',
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    '',
    'developer_instructions = """',
    'fixture',
    '"""',
    '',
  ].join('\n'));
  await assert.rejects(
    install({ ...fixture.options, apply: true, migrateLegacy: true }),
    /identity conflict/,
  );
});

test('missing Keychain credential fails before any configuration write', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(
    install({ ...fixture.options, apply: true, keychainReadyImpl: async () => false }),
    /not provisioned/,
  );
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  await assert.rejects(fs.stat(path.join(fixture.codexDir, 'agents')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(fixture.codexDir, 'codex-third-party-workers-install.json')), /ENOENT/);
});

test('installs and verifies the MiniMax worker without changing the main Codex config', async (t) => {
  const fixture = await setup(t);
  const options = {
    ...fixture.options,
    provider: 'minimax',
    catalogSource: minimaxFixture,
  };
  const applied = await install({ ...options, apply: true });
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  const agent = await fs.readFile(applied.environment.agentPath, 'utf8');
  assert.match(agent, /name = "minimax_worker"/);
  assert.match(agent, /model = "MiniMax-M3"/);
  assert.match(agent, /model_provider = "minimax"/);
  assert.match(agent, /model_context_window = 1000000/);
  assert.match(agent, /codex-minimax-api-key/);
  const catalog = JSON.parse(await fs.readFile(applied.environment.catalogPath, 'utf8'));
  assert.deepEqual(catalog.models.map((model) => model.slug), ['MiniMax-M3']);
  assert.deepEqual(catalog.models[0].input_modalities, ['text']);
  const checked = await verify({
    ...options,
    checkKeychain: true,
    keychainReadyImpl: async () => true,
  });
  assert.equal(checked.configured, true);
  assert.equal(checked.runtimeVerified, false);
});

test('installs and verifies the Qwen worker without changing the main Codex config', async (t) => {
  const fixture = await setup(t);
  const options = {
    ...fixture.options,
    provider: 'qwen',
    catalogSource: qwenFixture,
  };
  const applied = await install({ ...options, apply: true });
  assert.equal(await fs.readFile(fixture.configToml, 'utf8'), fixture.sentinel);
  const agent = await fs.readFile(applied.environment.agentPath, 'utf8');
  assert.match(agent, /name = "qwen_worker"/);
  assert.match(agent, /model = "qwen3\.7-max"/);
  assert.match(agent, /model_provider = "qwen"/);
  assert.match(agent, /model_context_window = 1000000/);
  assert.match(agent, /codex-qwen-api-key/);
  const catalog = JSON.parse(await fs.readFile(applied.environment.catalogPath, 'utf8'));
  assert.deepEqual(catalog.models.map((model) => model.slug), ['qwen3.7-max']);
  assert.deepEqual(catalog.models[0].input_modalities, ['text']);
  const checked = await verify({
    ...options,
    checkKeychain: true,
    keychainReadyImpl: async () => true,
  });
  assert.equal(checked.configured, true);
  assert.equal(checked.runtimeVerified, false);
});

test('uninstall restores a validated pre-existing managed file', async (t) => {
  const fixture = await setup(t);
  const agentsDir = path.join(fixture.codexDir, 'agents');
  await fs.mkdir(agentsDir, { recursive: true });
  const agentPath = path.join(agentsDir, 'deepseek_worker.toml');
  const original = [
    'name = "deepseek_worker"',
    'description = "user-owned fixture"',
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    '',
    'developer_instructions = """',
    'user-owned fixture',
    '"""',
    '',
  ].join('\n');
  await fs.writeFile(agentPath, original, { mode: 0o640 });
  await install({ ...fixture.options, apply: true, migrateLegacy: true });
  assert.notEqual(await fs.readFile(agentPath, 'utf8'), original);
  const result = await uninstall({ ...fixture.options, apply: true });
  assert.equal(result.applied, true);
  assert.equal(await fs.readFile(agentPath, 'utf8'), original);
  assert.equal((await fs.stat(agentPath)).mode & 0o777, 0o640);
});

test('uninstall plan output does not expose user rules or managed paths', async (t) => {
  const fixture = await setup(t);
  await install({ ...fixture.options, apply: true });
  const result = await uninstall(fixture.options);
  const output = JSON.stringify(result);
  assert.equal(output.includes(fixture.homeDir), false);
  assert.equal(output.includes('# Existing user rules'), false);
  assert.deepEqual(Object.keys(result.actions[0]).sort(), ['kind', 'preExisting', 'type']);
});
