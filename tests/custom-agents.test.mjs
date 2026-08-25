import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectCustomAgentDefinitions,
  inspectCustomAgentHost,
  validateCustomAgentToml,
} from '../src/custom-agents.mjs';
import { resolveProviderPack } from '../src/provider-packs.mjs';
import { agentToml } from '../src/templates.mjs';

function definition() {
  return agentToml({
    catalogPath: '/tmp/catalog.json',
    bridgePath: '/tmp/bridge',
    bridgeCliPath: '/tmp/bridge-cli.mjs',
    nodePath: process.execPath,
    keychainAccount: 'fixture-user',
    providerPack: resolveProviderPack('deepseek'),
  });
}

test('generated Custom Agent TOML has the official identity fields', () => {
  const result = validateCustomAgentToml(definition(), {
    name: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    modelProvider: 'deepseek',
  });
  assert.equal(result.configured, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.agent.name, 'deepseek_worker');
});

test('legacy router fields are rejected from Custom Agent TOML', () => {
  const result = validateCustomAgentToml(
    definition() + '\ncomplete = "legacy"\nfail = "legacy"\n',
    { name: 'deepseek_worker' },
  );
  assert.equal(result.configured, false);
  assert.match(result.issues.join('\n'), /unsupported legacy custom-agent field/);
});

test('host inspection reads current multi-agent capability without writes', async () => {
  const result = await inspectCustomAgentHost({
    commandRunner: async (_command, args) => (
      args[0] === '--version'
        ? 'codex-cli 0.147.0\n'
        : 'multi_agent stable true\nmulti_agent_v2 stable false\n'
    ),
  });
  assert.equal(result.supported, true);
  assert.equal(result.version, '0.147.0');
  assert.equal(result.multiAgent, true);
  assert.equal(result.multiAgentV2, false);
  assert.equal(result.compatibility.level, 'LEVEL_A_RUNTIME_VERIFIED');
  assert.equal(result.compatibility.status, 'HISTORICAL_RUNTIME_VERIFIED');
});

test('multi_agent alone does not pass the current 0.149 cross-provider contract', async () => {
  const result = await inspectCustomAgentHost({
    commandRunner: async (_command, args) => (
      args[0] === '--version'
        ? 'codex-cli 0.149.0\n'
        : 'multi_agent stable true\nmulti_agent_v2 stable false\n'
    ),
  });
  assert.equal(result.multiAgent, true);
  assert.equal(result.supported, false);
  assert.equal(result.compatibility.level, 'LEVEL_C_HOST_BLOCKED');
  assert.equal(result.compatibility.configurationInstallAllowed, false);
});

test('definition inspection flags a duplicate user and project identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-custom-agents-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home', '.codex', 'agents');
  const projectRoot = path.join(root, 'project');
  const projectDirectory = path.join(projectRoot, '.codex', 'agents');
  await fs.mkdir(homeDirectory, { recursive: true });
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(homeDirectory, 'deepseek_worker.toml'), definition());
  await fs.writeFile(path.join(projectDirectory, 'deepseek_worker.toml'), definition());

  const result = await inspectCustomAgentDefinitions({
    homeDir: path.join(root, 'home'),
    projectRoot,
    expected: [{
      name: 'deepseek_worker',
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
    }],
  });
  assert.deepEqual(result.duplicateNames, ['deepseek_worker']);
  assert.deepEqual(result.projectDuplicateNames, ['deepseek_worker']);
  assert.equal(result.expectedDefinitions[0].duplicate, true);
});

test('definition inspection treats the expected filename as part of migration safety', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-custom-agents-name-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home', '.codex', 'agents');
  await fs.mkdir(homeDirectory, { recursive: true });
  await fs.writeFile(path.join(homeDirectory, 'deepseek_worker.toml'), definition()
    .replace('name = "deepseek_worker"', 'name = "different_worker"'));

  const result = await inspectCustomAgentDefinitions({
    homeDir: path.join(root, 'home'),
    projectRoot: path.join(root, 'project'),
    expected: [{
      name: 'deepseek_worker',
      model: 'deepseek-v4-flash',
      modelProvider: 'deepseek',
      fileName: 'deepseek_worker.toml',
    }],
  });
  assert.equal(result.expectedDefinitions[0].present, true);
  assert.equal(result.expectedDefinitions[0].fileNameMatches, false);
});
