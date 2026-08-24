import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildExternalTransportEvidence,
  containsSensitiveText,
  parseExternalRuntimeEvidence,
  redactPortableData,
  scanTreeForSecrets,
} from '../src/transports/external-evidence.mjs';
import { sha256 } from '../src/transports/external-fs-safety.mjs';
import { parseExternalChildResult } from '../src/transports/external-result.mjs';
import { transportRequest } from './helpers/external-transport-fixture.mjs';

function childResult(overrides = {}) {
  return {
    taskName: 'fixture-task',
    status: 'completed',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: 'external-codex',
    changedFiles: [],
    tests: [{ name: 'node --test', status: 'passed', exitCode: 0 }],
    findings: [],
    summary: 'Fixture completed.',
    risks: [],
    ...overrides,
  };
}

async function evidenceHome(t, {
  provider = 'deepseek',
  model = 'deepseek-v4-flash',
  taskSha256 = sha256('prompt'),
  promptText = null,
  includeEndpoint = true,
  malformed = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-evidence-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = [
    { type: 'session_meta', payload: {
      id: 'thread-1',
      model_provider: provider,
      ...(includeEndpoint ? { base_url: 'https://api.deepseek.com/' } : {}),
      ...(taskSha256 ? { task_sha256: taskSha256 } : {}),
    } },
    { type: 'turn_context', payload: { model } },
    ...(promptText === null ? [] : [{
      type: 'response_item',
      payload: { role: 'user', content: [{ type: 'input_text', text: promptText }] },
    }]),
  ];
  await fs.writeFile(
    path.join(home, 'session.jsonl'),
    malformed ? '{broken' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return home;
}

const stdout = `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n${JSON.stringify({ type: 'turn.completed' })}\n`;
const expected = {
  providerId: 'deepseek',
  model: 'deepseek-v4-flash',
  endpoint: 'https://api.deepseek.com/',
  taskSha256: sha256('prompt'),
  configSha256: sha256('trusted isolated config'),
};

test('strict child result accepts exact structured data and rejects schema abuse', () => {
  const request = transportRequest('/private/tmp/fixture');
  assert.equal(parseExternalChildResult(JSON.stringify(childResult()), request).status, 'completed');
  assert.throws(() => parseExternalChildResult('{broken', request), /malformed/u);
  assert.throws(() => parseExternalChildResult(JSON.stringify({ ...childResult(), unknown: true }), request), /fields/u);
  assert.throws(() => parseExternalChildResult(JSON.stringify(childResult({ changedFiles: ['../outside'] })), request), /scope escape/u);
  assert.throws(() => parseExternalChildResult(JSON.stringify(childResult({ summary: 'x'.repeat(70 * 1024) })), request), /oversized/u);
  assert.throws(() => parseExternalChildResult(JSON.stringify(childResult({
    summary: `Authorization: Bearer ${'a'.repeat(32)}`,
  })), request), /secret-like/u);
});

test('runtime evidence attributes one exact provider/model/endpoint/task tuple', async (t) => {
  const home = await evidenceHome(t);
  const parsed = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: home,
    expected,
    stdinDelivered: true,
  });
  assert.equal(parsed.status, 'ATTRIBUTED');
  assert.equal(parsed.providerResolved, true);
  assert.equal(parsed.taskDelivered, true);
  assert.equal(parsed.runtimeExecuted, true);
  assert.deepEqual(parsed.attribution.providers, ['deepseek']);
});

test('real Codex session prompt plus isolated-config hash can prove delivery and endpoint configuration', async (t) => {
  const home = await evidenceHome(t, {
    taskSha256: null,
    promptText: 'prompt',
    includeEndpoint: false,
  });
  const parsed = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: home,
    expected,
    stdinDelivered: true,
  });
  assert.equal(parsed.status, 'ATTRIBUTED');
  assert.equal(parsed.providerResolved, true);
  assert.equal(parsed.taskDelivered, true);
  assert.match(parsed.attribution.endpointRef, /^runtime:config:/u);
});

test('result self-report cannot replace wrong or missing runtime attribution', async (t) => {
  const request = transportRequest('/private/tmp/fixture');
  assert.equal(parseExternalChildResult(JSON.stringify(childResult()), request).providerId, 'deepseek');
  const wrongProvider = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: await evidenceHome(t, { provider: 'openai' }),
    expected,
    stdinDelivered: true,
  });
  const wrongModel = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: await evidenceHome(t, { model: 'wrong-model' }),
    expected,
    stdinDelivered: true,
  });
  const wrongTask = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: await evidenceHome(t, { taskSha256: sha256('other') }),
    expected,
    stdinDelivered: true,
  });
  assert.equal(wrongProvider.providerResolved, false);
  assert.equal(wrongModel.providerResolved, false);
  assert.equal(wrongTask.taskDelivered, false);
});

test('unknown evidence versions and malformed metadata remain UNKNOWN', async (t) => {
  const home = await evidenceHome(t, { malformed: true });
  const malformed = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: home,
    expected,
    stdinDelivered: true,
  });
  const unsupported = await parseExternalRuntimeEvidence({
    format: 'future-schema',
    stdoutText: stdout,
    codexHome: home,
    expected,
    stdinDelivered: true,
  });
  assert.equal(malformed.status, 'UNKNOWN');
  assert.equal(unsupported.status, 'UNKNOWN');
});

test('Phase 1 evidence cannot promote fixture attribution to runtimeVerified', async (t) => {
  const parsed = await parseExternalRuntimeEvidence({
    stdoutText: stdout,
    codexHome: await evidenceHome(t),
    expected,
    stdinDelivered: true,
  });
  const evidence = buildExternalTransportEvidence({
    request: transportRequest('/private/tmp/fixture'),
    parsed,
    evidenceRefs: [{ kind: 'runtime', ref: 'runtime:fixture', sha256: 'a'.repeat(64) }],
    acceptance: {
      resultValid: true,
      workspaceScopeValid: true,
      lifecycleValid: true,
      credentialSafetyValid: true,
      parentIsolationValid: true,
    },
    codexBinary: '/private/tmp/fake-codex',
    credentialReady: null,
    allowRuntimeVerification: false,
  });
  assert.equal(evidence.providerResolved, true);
  assert.equal(evidence.runtimeVerified, false);
  assert.equal(evidence.ready, false);
});

test('central redaction removes credentials, task data, cwd, and personal paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateFile = path.join(root, 'private.log');
  await fs.writeFile(privateFile, `Bearer ${'b'.repeat(32)}\n`, { mode: 0o600 });
  assert.equal((await scanTreeForSecrets(root)).pass, false);
  const personalRoot = path.join('/', 'Users', 'example', 'private');
  const personalProject = path.join(personalRoot, 'project');
  const redacted = redactPortableData({
    cwd: personalProject,
    message: 'private task body',
    output: `Authorization: Bearer ${'c'.repeat(32)} ${path.join(personalRoot, 'file')}`,
  }, { cwd: personalProject, message: 'private task body' });
  const serialized = JSON.stringify(redacted);
  assert.equal(containsSensitiveText(serialized), false);
  assert.equal(serialized.includes(personalRoot), false);
  assert.doesNotMatch(serialized, /private task body|Bearer\s+c/u);
});
