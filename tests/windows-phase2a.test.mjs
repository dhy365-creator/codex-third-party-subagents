import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProviderPack } from '../src/provider-packs.mjs';
import { CredentialBackendError } from '../src/credentials/windows-credential-manager.mjs';
import { validateCredentialCommand } from '../src/transports/external-config.mjs';
import {
  createExecutionTree,
  assertPrivateTree,
} from '../src/transports/external-fs-safety.mjs';
import {
  createProcessTreeSupervisor,
  isolatedChildEnvironment,
  resolveExecutable,
} from '../src/transports/external-process.mjs';
import {
  runWindowsCredentialCommand,
  WINDOWS_CREDENTIAL_COMMAND_PATH,
  windowsCredentialCommandArgs,
} from '../src/windows-credential-command.mjs';
import {
  buildWindowsRuntimeCandidate,
  WINDOWS_PHASE2B_INTENT,
} from '../src/windows-runtime-candidate.mjs';
import { agentToml } from '../src/templates.mjs';
import { inspectExternalTransportReadiness } from '../src/transport-readiness.mjs';

test('Windows credential command is provider-bound and clears the retrieved secret', async () => {
  const pack = resolveProviderPack('deepseek');
  const args = windowsCredentialCommandArgs({ providerPack: pack, account: 'fixture-user' });
  const secret = Buffer.from('synthetic-phase2a-value');
  const output = [];
  const errors = [];
  const stderr = { write: (value) => { errors.push(String(value)); return true; } };
  const code = await runWindowsCredentialCommand(args, {
    platform: 'win32', stderr,
    writeSecretImpl: (value) => output.push(Buffer.from(value)),
    retrieveImpl: async ({ service, account }) => {
      assert.equal(service, pack.keychainService);
      assert.equal(account, 'fixture-user');
      return secret;
    },
  });
  assert.equal(code, 0);
  assert.equal(Buffer.concat(output).toString('utf8'), 'synthetic-phase2a-value');
  assert.equal(errors.join(''), '');
  assert.equal(secret.every((byte) => byte === 0), true);
});

test('Windows credential contract is exact and rejects provider drift', () => {
  const pack = resolveProviderPack('deepseek');
  const command = {
    kind: 'windows-credential-manager',
    command: '/controlled/node.exe',
    args: [WINDOWS_CREDENTIAL_COMMAND_PATH,
      ...windowsCredentialCommandArgs({ providerPack: pack, account: 'fixture-user' })],
  };
  assert.deepEqual(validateCredentialCommand(command, pack), command);
  assert.throws(() => validateCredentialCommand({
    ...command,
    args: command.args.map((value) => value === pack.model ? 'deepseek-v4-pro' : value),
  }, pack), /reviewed Windows Credential Manager/u);
});

test('Windows credential command failures disclose only a classified status', async () => {
  const pack = resolveProviderPack('deepseek');
  const errors = [];
  const code = await runWindowsCredentialCommand(
    windowsCredentialCommandArgs({ providerPack: pack, account: 'fixture-user' }),
    {
      platform: 'win32', stderr: { write: (value) => errors.push(String(value)) },
      retrieveImpl: async () => { throw new CredentialBackendError('NOT_FOUND'); },
      writeSecretImpl: () => assert.fail('secret output must not run on failure'),
    },
  );
  assert.equal(code, 44);
  assert.equal(errors.join(''), 'WINDOWS_CREDENTIAL_COMMAND_NOT_FOUND\n');
  assert.doesNotMatch(errors.join(''), /sensitive provider detail/u);
});

test('Windows private tree uses injected ACL and reparse primitives, never POSIX modes as proof', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-phase2a-tree-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const securityImpl = {
    secureManagedPath: async (target, options) => calls.push(['secure', target, options.kind]),
    privatePathReady: async (target, options) => {
      calls.push(['ready', target, options.kind]);
      return true;
    },
    assertNoReparsePath: async (target, approvedRoot) => calls.push(['reparse', target, approvedRoot]),
  };
  const tree = await createExecutionTree(root, '20260901T000000000Z-aabbccddeeff0011', {
    platform: 'win32', securityImpl,
  });
  await fs.writeFile(path.join(tree.logs, 'proof.txt'), 'safe');
  assert.equal((await assertPrivateTree(tree.root, { platform: 'win32', securityImpl })).pass, true);
  assert.equal(calls.some(([kind]) => kind === 'secure'), true);
  assert.equal(calls.some(([kind]) => kind === 'reparse'), true);
});

test('Windows executable and minimal environment avoid POSIX execution and credential inheritance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-phase2a-exec-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex.exe');
  await fs.writeFile(executable, 'fixture', { mode: 0o600 });
  assert.equal(await resolveExecutable(executable, { platform: 'win32' }), await fs.realpath(executable));
  const env = isolatedChildEnvironment({
    codexHome: path.join(root, 'codex-home'), tmpDir: path.join(root, 'tmp'), userHome: root,
    executablePaths: [executable], platform: 'win32',
    sourceEnv: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', DEEPSEEK_API_KEY: 'forbidden' },
  });
  assert.equal(env.PATH.includes(';'), true);
  assert.equal(env.TEMP, path.join(root, 'tmp'));
  assert.equal('DEEPSEEK_API_KEY' in env, false);
  assert.equal(env.USERPROFILE, root);
});

test('Windows process-tree supervisor uses bounded taskkill tree commands without a shell', async () => {
  const calls = [];
  const supervisor = createProcessTreeSupervisor(4321, {
    platform: 'win32', env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: command.endsWith('tasklist.exe') ? '"codex.exe","4321","Console","1","1 K"' : '' };
    },
  });
  assert.equal(await supervisor.isAlive(), true);
  assert.equal(await supervisor.terminate(false), true);
  assert.equal(await supervisor.terminate(true), true);
  assert.deepEqual(calls[1].args, ['/PID', '4321', '/T']);
  assert.deepEqual(calls[2].args, ['/PID', '4321', '/T', '/F']);
  assert.equal(calls.every((call) => call.options.shell !== true), true);
  assert.equal(calls.every((call) => call.options.timeout === 5000), true);
});

test('Phase 2A candidate is internal-only while normal Windows agent remains fail-closed', () => {
  const pack = resolveProviderPack('deepseek');
  const candidate = buildWindowsRuntimeCandidate({
    internalValidationIntent: WINDOWS_PHASE2B_INTENT,
    nodePath: '/controlled/node.exe',
    providerId: pack.id, model: pack.model, account: 'fixture-user',
    prerequisites: {
      credentialCommandReady: true, privateTreeReady: true,
      executableReady: true, processTreeReady: true,
    },
  });
  assert.equal(candidate.foundationReady, true);
  assert.equal(candidate.configurationReady, false);
  assert.equal(candidate.providerRuntimeStatus, 'BLOCKED_PENDING_PHASE_2');
  assert.equal(candidate.runtimeVerified, false);
  assert.equal(candidate.ready, false);
  assert.equal(candidate.thirdPartyLiveRequests, 0);
  const normal = agentToml({
    nodePath: '/controlled/node.exe', runtimeBlockerPath: '/runtime/credential-runtime-blocker.mjs',
    keychainAccount: 'fixture-user', providerPack: pack, platform: 'win32',
  });
  assert.match(normal, /credential-runtime-blocker\.mjs/u);
  assert.doesNotMatch(normal, /windows-credential-command\.mjs/u);
  assert.throws(() => buildWindowsRuntimeCandidate({}), /explicit Phase 2B offline intent/u);
});

test('Windows readiness can prove ACL prerequisites without promoting runtime eligibility', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-phase2a-readiness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const readiness = await inspectExternalTransportReadiness({
    providerPack: resolveProviderPack('deepseek'),
    customAgentHost: { version: '0.149.0' }, codexDetected: true,
    runtimeRoot: root, credentialReady: true, platform: 'win32',
    privatePathReadyImpl: async () => true,
  });
  assert.equal(readiness.runtimeRoot.ready, true);
  assert.equal(readiness.prerequisitesReady, true);
  assert.equal(readiness.featureGate.enabled, false);
  assert.equal(readiness.featureGate.runtimeRouteEnabled, false);
  assert.equal(readiness.eligibility.eligible, false);
  assert.equal(readiness.eligibility.runtimeVerified, false);
});

test('installer, verifier, uninstaller, and package source include Phase 2A runtime modules', async () => {
  for (const file of ['src/installer.mjs', 'src/verifier.mjs', 'src/uninstaller.mjs']) {
    const source = await fs.readFile(file, 'utf8');
    assert.match(source, /windows-credential-command\.mjs/u);
    assert.match(source, /windows-runtime-candidate\.mjs/u);
  }
});
