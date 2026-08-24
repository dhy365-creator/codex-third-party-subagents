import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExternalCodexTransport } from '../../src/transports/external-codex.mjs';

const FAKE_CODEX = `#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.149.0\\n');
  process.exit(0);
}
const valueAfter = (name) => args[args.indexOf(name) + 1];
const mode = (await fs.readFile(path.join(process.cwd(), '.fake-mode'), 'utf8')).trim();
if (mode === 'forced-kill') process.on('SIGTERM', () => {});
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const stdin = Buffer.concat(chunks).toString('utf8');
const capturePath = path.join(process.env.CODEX_HOME, 'capture.json');
await fs.writeFile(capturePath, JSON.stringify({
  args,
  stdin,
  envKeys: Object.keys(process.env).sort(),
  home: process.env.HOME,
  codexHome: process.env.CODEX_HOME,
  tmpDir: process.env.TMPDIR,
}), { mode: 0o600 });

if (['timeout', 'cancel', 'forced-kill'].includes(mode)) {
  setInterval(() => {}, 1000);
} else {
  const start = stdin.indexOf('{');
  const end = stdin.lastIndexOf('}') + 1;
  const request = JSON.parse(stdin.slice(start, end));
  const threadId = 'fixture-' + request.taskName;
  const taskSha256 = crypto.createHash('sha256').update(stdin).digest('hex');
  const sessionDir = path.join(process.env.CODEX_HOME, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const provider = mode === 'wrong-provider' ? 'openai' : request.providerId;
  const model = mode === 'wrong-model' ? 'wrong-model' : request.model;
  const records = [
    { type: 'session_meta', payload: { id: threadId, model_provider: provider, base_url: 'https://api.deepseek.com/', task_sha256: taskSha256 } },
    { type: 'turn_context', payload: { model } },
  ];
  if (mode === 'malformed-evidence') {
    await fs.writeFile(path.join(sessionDir, 'session.jsonl'), '{broken', { mode: 0o600 });
  } else if (mode !== 'missing-evidence') {
    await fs.writeFile(path.join(sessionDir, 'session.jsonl'), records.map((item) => JSON.stringify(item)).join('\\n') + '\\n', { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');

  let changedFiles = [];
  if (mode === 'success-write') {
    await fs.writeFile(path.join(process.cwd(), 'output.txt'), 'fixture output\\n');
    changedFiles = ['output.txt'];
  }
  if (mode === 'external-write') {
    await fs.writeFile(path.join(process.cwd(), '..', 'outside.txt'), 'out of scope\\n');
  }
  if (mode === 'orphan') {
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    orphan.unref();
  }
  const result = {
    taskName: request.taskName,
    status: mode === 'reported-failure' ? 'failed' : 'completed',
    providerId: request.providerId,
    model: request.model,
    transport: 'external-codex',
    changedFiles,
    tests: mode === 'phase3-challenge' ? [] : [{ name: 'fixture-test', status: 'passed', exitCode: 0 }],
    findings: [],
    summary: mode === 'secret-result'
      ? 'Bearer ' + 'a'.repeat(32)
      : mode === 'phase3-challenge'
        ? 'CHALLENGE ' + request.message.match(/challenge-[a-f0-9]{8}-[a-f0-9]{8}/)[0]
        : 'Fixture child completed.',
    risks: [],
  };
  if (mode === 'scope-claim') result.changedFiles = ['../outside.txt'];
  const resultPath = valueAfter('--output-last-message');
  if (mode === 'malformed-result') await fs.writeFile(resultPath, '{broken', { mode: 0o600 });
  else if (mode === 'oversized-result') {
    result.summary = 'x'.repeat(70 * 1024);
    await fs.writeFile(resultPath, JSON.stringify(result), { mode: 0o600 });
  } else await fs.writeFile(resultPath, JSON.stringify(result), { mode: 0o600 });
  if (mode === 'stdout-overflow') process.stdout.write('x'.repeat(2 * 1024 * 1024));
  if (mode === 'stderr-overflow') process.stderr.write('x'.repeat(2 * 1024 * 1024));
  if (mode === 'secret-stdout') process.stdout.write('Bearer ' + 'b'.repeat(32) + '\\n');
  if (mode === 'exit-failure') process.exitCode = 7;
}
`;

const FAKE_CREDENTIAL = `#!/usr/bin/env node
process.stdout.write('fixture-command-output');
`;

export function transportRequest(cwd, overrides = {}) {
  return {
    taskName: 'fixture-task',
    cwd,
    message: 'Inspect the bounded local fixture.',
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    expectedScope: [],
    acceptanceCriteria: ['Return a structured result'],
    permissionProfile: 'read-only',
    timeoutMs: 10_000,
    explicitOnly: false,
    metadata: { requestId: 'fixture-request' },
    transportPreference: 'external-codex',
    ...overrides,
  };
}

export async function createExternalTransportFixture(t, {
  mode = 'success-read',
  testTimeoutMs = null,
  graceMs = 50,
  outputLimits,
  credentialPreflightExecFileImpl,
} = {}) {
  const createdBase = await fs.mkdtemp(path.join(os.tmpdir(), 'external-transport-phase1-'));
  const base = await fs.realpath(createdBase);
  const approvedRoot = path.join(base, 'approved');
  const cwd = path.join(approvedRoot, 'workspace');
  const parentCodexHome = path.join(base, 'parent-codex');
  const bin = path.join(base, 'bin');
  await Promise.all([
    fs.mkdir(cwd, { recursive: true, mode: 0o700 }),
    fs.mkdir(parentCodexHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(bin, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(cwd, '.fake-mode'), `${mode}\n`, { mode: 0o600 }),
    fs.writeFile(path.join(cwd, 'input.txt'), 'fixture input\n', { mode: 0o600 }),
    fs.writeFile(path.join(parentCodexHome, 'config.toml'), 'model = "parent"\n', { mode: 0o600 }),
  ]);
  const codexPath = path.join(bin, 'fake-codex');
  const credentialPath = path.join(bin, 'fake-credential');
  await fs.writeFile(codexPath, FAKE_CODEX, { mode: 0o700 });
  await fs.writeFile(credentialPath, FAKE_CREDENTIAL, { mode: 0o700 });
  await Promise.all([fs.chmod(codexPath, 0o700), fs.chmod(credentialPath, 0o700)]);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const stateRoot = path.join(base, 'runtime');
  const adapter = createExternalCodexTransport({
    stateRoot,
    codexPath,
    catalogSource: path.resolve('tests/fixtures/catalog.json'),
    credentialCommand: { kind: 'fixture', command: credentialPath, args: [] },
    userHome: base,
    testMode: true,
    testTimeoutMs,
    graceMs,
    outputLimits,
    credentialPreflightExecFileImpl,
    sourceEnv: {
      PATH: '/unsafe',
      DEEPSEEK_API_KEY: 'must-not-be-inherited',
      LANG: 'en_US.UTF-8',
      USER: 'fixture-user',
    },
  });
  return Object.freeze({
    base,
    approvedRoot,
    cwd,
    parentCodexHome,
    stateRoot,
    codexPath,
    credentialPath,
    adapter,
    context: Object.freeze({ approvedRoot, parentCodexHome }),
    request: (overrides = {}) => transportRequest(cwd, overrides),
    executionRoot: (executionId) => path.join(stateRoot, 'executions', executionId),
  });
}
