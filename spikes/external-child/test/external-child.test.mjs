import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createBridgeTask,
  failBridgeTask,
  readBridgeTask,
} from '../../../src/bridge.mjs';
import { createScratch, assertPrivateTree, tightenPrivateTree } from '../lib/fs-safety.mjs';
import { minimalChildConfig, writeMinimalChildHome } from '../lib/config.mjs';
import { expectedScopeIsRespected, promptForEnvelope, validateTaskEnvelope } from '../lib/envelope.mjs';
import { scanCredentialLeaks } from '../lib/evidence.mjs';
import { createFixture } from '../lib/fixture.mjs';
import { externalChildArgs, isolatedChildEnvironment } from '../lib/launcher.mjs';
import { liveProbeNames } from '../lib/probe.mjs';
import { parseResultEnvelope } from '../lib/result.mjs';
import { compareSnapshots } from '../lib/snapshots.mjs';
import { superviseProcess } from '../lib/supervisor.mjs';

const catalogSource = path.resolve('tests/fixtures/catalog.json');

async function scratchFor(t) {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'external-child-test-'));
  const scratch = await createScratch({ baseDir, now: new Date('2026-08-23T00:00:00Z') });
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  return scratch;
}

function envelope(cwd, overrides = {}) {
  return {
    taskName: 'fixture-task',
    cwd,
    mode: 'read',
    message: 'Inspect the bounded fixture.',
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    expectedScope: [],
    acceptanceCriteria: ['Return a structured result'],
    ...overrides,
  };
}

test('isolated CODEX_HOME tree is owner-only', async (t) => {
  const scratch = await scratchFor(t);
  await writeMinimalChildHome({
    homeDir: scratch.home,
    catalogSource,
    keychainAccount: 'fixture-user',
  });
  await tightenPrivateTree(scratch.root);
  const checked = await assertPrivateTree(scratch.root);
  assert.equal(checked.pass, true);
  assert.match(scratch.root, /codex-third-party-external-child-/u);
});

test('minimal config is Flash-only and command-backed without credential material', async () => {
  const config = minimalChildConfig({
    catalogPath: '/private/tmp/fixture/catalog.json',
    keychainAccount: 'fixture-user',
  });
  assert.match(config, /model = "deepseek-v4-flash"/u);
  assert.match(config, /model_provider = "deepseek"/u);
  assert.match(config, /command = "\/usr\/bin\/security"/u);
  assert.match(config, /request_max_retries = 0/u);
  assert.match(config, /stream_max_retries = 0/u);
  assert.doesNotMatch(config, /deepseek-v4-pro|sk-[A-Za-z0-9_-]{12,}|API_KEY/u);
});

test('runtime completion uses only read and coding live probes', () => {
  assert.deepEqual(liveProbeNames(), ['identity', 'read', 'coding']);
  assert.deepEqual(liveProbeNames({ runtimeCompletion: true }), ['read', 'coding']);
});

test('credential scanner reports no leak in generated scratch files', async (t) => {
  const scratch = await scratchFor(t);
  await writeMinimalChildHome({
    homeDir: scratch.home,
    catalogSource,
    keychainAccount: 'fixture-user',
  });
  assert.deepEqual(await scanCredentialLeaks(scratch.root), { pass: true, matchedFiles: [] });
});

test('task envelope enforces provider tuple, cwd, and relative scope', async (t) => {
  const scratch = await scratchFor(t);
  const fixtureRoot = await createFixture(scratch.workspace);
  const valid = envelope(fixtureRoot, { expectedScope: ['src/math.js'] });
  assert.equal(validateTaskEnvelope(valid, { fixtureRoot }), valid);
  assert.match(promptForEnvelope(valid), /complete task/u);
  assert.throws(() => validateTaskEnvelope({ ...valid, cwd: path.dirname(fixtureRoot) }, { fixtureRoot }), /escapes/u);
  assert.throws(() => validateTaskEnvelope({ ...valid, model: 'deepseek-v4-pro' }, { fixtureRoot }), /Flash/u);
  assert.throws(() => validateTaskEnvelope({ ...valid, expectedScope: ['../outside'] }, { fixtureRoot }), /safe relative/u);
});

test('scope comparison rejects files outside the bounded target', () => {
  assert.equal(expectedScopeIsRespected({ added: [], deleted: [], changed: ['src/math.js'] }, ['src/math.js']), true);
  assert.equal(expectedScopeIsRespected({ added: ['README.md'], deleted: [], changed: [] }, ['src/math.js']), false);
  assert.deepEqual(compareSnapshots({ 'src/math.js': 'a' }, { 'src/math.js': 'b' }), {
    added: [], deleted: [], changed: ['src/math.js'],
  });
});

test('structured result parser accepts exact results and rejects invalid output', async (t) => {
  const scratch = await scratchFor(t);
  const fixtureRoot = await createFixture(scratch.workspace);
  const task = envelope(fixtureRoot);
  const result = {
    taskName: task.taskName,
    status: 'completed',
    providerId: task.providerId,
    model: task.model,
    changedFiles: [],
    tests: [],
    findings: ['src/math.js divides by zero length'],
    summary: 'Minimal fix proposed.',
    risks: [],
  };
  assert.deepEqual(parseResultEnvelope(JSON.stringify(result), task), result);
  assert.throws(() => parseResultEnvelope('{broken', task), /valid JSON/u);
  assert.throws(() => parseResultEnvelope(JSON.stringify({ ...result, providerId: 'openai' }), task), /provider tuple/u);
  assert.throws(() => parseResultEnvelope(JSON.stringify({ ...result, extra: true }), task), /fields/u);
});

test('process timeout terminates the process group without an orphan', async (t) => {
  const scratch = await scratchFor(t);
  const lifecycle = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: scratch.workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdoutPath: path.join(scratch.logs, 'timeout.stdout.log'),
    stderrPath: path.join(scratch.logs, 'timeout.stderr.log'),
    timeoutMs: 100,
    graceMs: 100,
  });
  assert.equal(lifecycle.timedOut, true);
  assert.equal(lifecycle.orphanDetected, false);
  assert.equal(lifecycle.exitSignal !== null, true);
});

test('parent cancellation terminates a local child without an orphan', async (t) => {
  const scratch = await scratchFor(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const lifecycle = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: scratch.workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdoutPath: path.join(scratch.logs, 'cancel.stdout.log'),
    stderrPath: path.join(scratch.logs, 'cancel.stderr.log'),
    timeoutMs: 2_000,
    graceMs: 100,
    signal: controller.signal,
  });
  assert.equal(lifecycle.cancelled, true);
  assert.equal(lifecycle.timedOut, false);
  assert.equal(lifecycle.orphanDetected, false);
});

test('failed bridge archive is redacted and releases the active slot', async (t) => {
  const scratch = await scratchFor(t);
  await createBridgeTask({
    root: scratch.bridge,
    taskName: 'failed-fixture',
    cwd: scratch.workspace,
    message: 'bounded failure payload',
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
  });
  assert.equal((await readBridgeTask({ root: scratch.bridge })).status, 'pending');
  const archived = await failBridgeTask('failed-fixture', { root: scratch.bridge });
  assert.equal(archived.status, 'failed');
  assert.equal(archived.task.cwd, '[REDACTED]');
  assert.equal(archived.task.message, '[REDACTED]');
  await assert.rejects(fs.access(path.join(scratch.bridge, 'active')));
});

test('launcher uses stdin and an allowlisted environment', () => {
  const args = externalChildArgs({
    cwd: '/private/tmp/fixture',
    schemaPath: '/private/tmp/schema.json',
    resultPath: '/private/tmp/result.json',
    sandbox: 'workspace-write',
  });
  assert.equal(args.at(-1), '-');
  assert.equal(args.includes('bounded secret task'), false);
  assert.equal(args.includes('danger-full-access'), false);
  const env = isolatedChildEnvironment({
    codexHome: '/private/tmp/isolated-home',
    tmpDir: '/private/tmp/isolated-tmp',
    sourceEnv: { HOME: '/tmp/os-home', PATH: '/unsafe', DEEPSEEK_API_KEY: 'never-inherit', USER: 'fixture' },
  });
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.HOME, '/tmp/os-home');
  assert.equal(env.CODEX_HOME, '/private/tmp/isolated-home');
  assert.equal(args.includes('plugins'), true);
  assert.equal(args.includes('multi_agent'), true);
});
