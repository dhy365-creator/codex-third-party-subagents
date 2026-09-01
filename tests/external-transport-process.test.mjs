import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertExternalProcessGroupClosed,
  isolatedChildEnvironment,
} from '../src/transports/external-process.mjs';
import { preflightExternalCredential } from '../src/transports/external-credential-preflight.mjs';
import { validateExternalUserHome } from '../src/transports/external-user-home.mjs';
import { createExternalTransportFixture } from './helpers/external-transport-fixture.mjs';

async function runFixture(fixture, request = fixture.request()) {
  const prepared = await fixture.adapter.prepare(request, fixture.context);
  const execution = await fixture.adapter.execute(prepared);
  const collection = await fixture.adapter.collect(execution);
  const final = await fixture.adapter.cleanup(execution);
  return { prepared, execution, collection, final };
}

test('launcher implementation uses spawn without shell-string execution', async () => {
  const source = await fs.readFile(path.resolve('src/transports/external-process.mjs'), 'utf8');
  assert.match(source, /\bspawn\(/u);
  assert.doesNotMatch(source, /\bexec(?:File)?\s*\(|shell\s*:\s*true/u);
});

test('an unresolved orphan is archived but blocks active-slot release', async () => {
  assert.throws(
    () => assertExternalProcessGroupClosed({ orphanDetected: true }),
    (error) => error.code === 'EXTERNAL_ORPHAN_ACTIVE',
  );
  assert.equal(assertExternalProcessGroupClosed({ orphanDetected: false }), true);
  const source = await fs.readFile(path.resolve('src/transports/external-codex.mjs'), 'utf8');
  const archive = source.indexOf('const archived = await finalizeExternalArchive');
  const guard = source.indexOf('assertExternalProcessGroupClosed(state.processResult)', archive);
  const release = source.indexOf('await releaseExternalSlot(state.slot, archived.archivePath, { fsOptions })', guard);
  assert.equal(archive >= 0 && archive < guard && guard < release, true);
});

test('launcher keeps malicious task text in stdin and uses fixed argv plus an allowlisted env', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const malicious = 'quotes "\'; semicolon; newline\n$() and `backticks` remain task data';
  const run = await runFixture(fixture, fixture.request({ message: malicious }));
  assert.equal(run.final.result.status, 'completed');
  assert.equal(Number.isInteger(run.execution.pid) && run.execution.pid > 0, true);
  const capture = JSON.parse(await fs.readFile(
    path.join(fixture.executionRoot(run.prepared.executionId), 'home', 'capture.json'),
    'utf8',
  ));
  const envelope = JSON.parse(capture.stdin.slice(capture.stdin.indexOf('{'), capture.stdin.lastIndexOf('}') + 1));
  assert.equal(envelope.message, malicious);
  assert.equal(capture.args.some((arg) => arg.includes('semicolon') || arg.includes('$()')), false);
  assert.equal(capture.args.at(-1), '-');
  assert.equal(capture.args.includes('--sandbox'), true);
  assert.equal(capture.args.includes('danger-full-access'), false);
  assert.equal(capture.envKeys.includes('DEEPSEEK_API_KEY'), false);
  assert.equal(capture.home, fixture.base);
  assert.notEqual(capture.home, capture.codexHome);
  assert.equal(capture.tmpDir.startsWith(capture.codexHome), true);
});

test('credential preflight returns only safe metadata and handles whitespace', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const result = await preflightExternalCredential({
    credentialCommand: { command: fixture.credentialPath, args: [] },
    codexPath: fixture.codexPath,
    codexHome: path.join(fixture.base, 'prospective-codex-home'),
    tmpDir: path.join(fixture.base, 'prospective-tmp'),
    userHome: fixture.base,
    execFileImpl: async (_command, _args, options) => {
      assert.equal(options.env.HOME, fixture.base);
      assert.notEqual(options.env.HOME, options.env.CODEX_HOME);
      assert.equal(Object.keys(options.env).some((name) => /API_KEY|TOKEN|SECRET|PASSWORD/u.test(name)), false);
      return { stdout: Buffer.from('  controlled-value\n') };
    },
  });
  assert.deepEqual(result, {
    exitCode: 0,
    credentialPresent: true,
    credentialNonEmpty: true,
    normalizationApplied: true,
  });
  assert.equal(JSON.stringify(result).includes('controlled-value'), false);
});

test('credential preflight fails closed for exit 44, other exits, and empty output', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  const input = {
    credentialCommand: { command: fixture.credentialPath, args: [] },
    codexPath: fixture.codexPath,
    codexHome: path.join(fixture.base, 'prospective-codex-home'),
    tmpDir: path.join(fixture.base, 'prospective-tmp'),
    userHome: fixture.base,
  };
  for (const code of [44, 7]) {
    await assert.rejects(
      preflightExternalCredential({
        ...input,
        execFileImpl: async () => { const error = new Error('hidden'); error.code = code; throw error; },
      }),
      (error) => error.code === 'EXTERNAL_CREDENTIAL_PREFLIGHT_FAILED' && error.exitCode === code,
    );
  }
  await assert.rejects(
    preflightExternalCredential({ ...input, execFileImpl: async () => ({ stdout: Buffer.from(' \n\t') }) }),
    (error) => error.code === 'EXTERNAL_CREDENTIAL_PREFLIGHT_FAILED'
      && error.exitCode === 0 && error.credentialNonEmpty === false,
  );
});

test('user HOME validation rejects malformed, missing, and symlink paths', async (t) => {
  const fixture = await createExternalTransportFixture(t);
  assert.equal(await validateExternalUserHome(fixture.base), fixture.base);
  await assert.rejects(validateExternalUserHome('relative-home'), /normalized absolute/u);
  await assert.rejects(validateExternalUserHome(path.join(fixture.base, 'missing')), /ENOENT/u);
  const linked = path.join(fixture.base, 'linked-home');
  await fs.symlink(fixture.base, linked);
  await assert.rejects(validateExternalUserHome(linked), /real directory/u);
  assert.throws(() => isolatedChildEnvironment({
    codexHome: path.join(fixture.base, 'codex-home'),
    tmpDir: path.join(fixture.base, 'tmp'),
    userHome: 'relative-home',
  }), /must be absolute/u);
});

test('bounded stdout is truncated safely and incomplete structured evidence fails closed', async (t) => {
  const fixture = await createExternalTransportFixture(t, {
    mode: 'stdout-overflow',
    outputLimits: { stdoutBytes: 512, stderrBytes: 256 },
  });
  const run = await runFixture(fixture);
  assert.equal(run.final.result.status, 'failed');
  const log = await fs.readFile(
    path.join(fixture.executionRoot(run.prepared.executionId), 'logs', 'stdout.jsonl'),
  );
  assert.equal(log.byteLength <= 512, true);
  assert.equal(run.final.evidence.runtimeVerified, false);
});

test('bounded stderr is content-redacted and overflow fails closed', async (t) => {
  const fixture = await createExternalTransportFixture(t, {
    mode: 'stderr-overflow',
    outputLimits: { stdoutBytes: 1024, stderrBytes: 256 },
  });
  const run = await runFixture(fixture);
  assert.equal(run.final.result.status, 'failed');
  const log = await fs.readFile(
    path.join(fixture.executionRoot(run.prepared.executionId), 'logs', 'stderr.log'),
    'utf8',
  );
  assert.equal(log, '[REDACTED STDERR DIAGNOSTIC]\n');
});

test('timeout terminates the process group and produces a timed_out archive', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'timeout', testTimeoutMs: 80, graceMs: 30 });
  const run = await runFixture(fixture);
  assert.equal(run.final.result.status, 'timed_out');
  assert.equal(run.final.result.lifecycle.timedOut, true);
  assert.equal(run.final.result.lifecycle.cancelled, false);
  assert.equal(run.final.result.lifecycle.orphanDetected, false);
  assert.match(run.final.archiveRef.ref, /^archive:timed_out-/u);
});

test('cancellation is idempotent and never selects a replacement provider', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'cancel' });
  const prepared = await fixture.adapter.prepare(fixture.request(), fixture.context);
  const execution = await fixture.adapter.execute(prepared);
  assert.equal(await fixture.adapter.cancel(execution), true);
  assert.equal(await fixture.adapter.cancel(execution), false);
  await fixture.adapter.collect(execution);
  const final = await fixture.adapter.cleanup(execution);
  assert.equal(final.result.status, 'cancelled');
  assert.equal(final.result.providerId, 'deepseek');
  assert.equal(final.result.model, 'deepseek-v4-flash');
  assert.equal(final.result.lifecycle.cancelled, true);
  assert.equal(final.result.lifecycle.orphanDetected, false);
});

test('forced kill fallback closes an uncooperative local process without an orphan', async (t) => {
  const fixture = await createExternalTransportFixture(t, {
    mode: 'forced-kill',
    testTimeoutMs: 1000,
    graceMs: 30,
  });
  const run = await runFixture(fixture);
  assert.equal(run.final.result.status, 'timed_out');
  assert.equal(run.final.result.lifecycle.forcedKill, true);
  assert.equal(run.final.result.lifecycle.orphanDetected, false);
});

test('an orphaned subprocess is killed and the otherwise successful result is rejected', async (t) => {
  const fixture = await createExternalTransportFixture(t, { mode: 'orphan' });
  const run = await runFixture(fixture);
  assert.equal(run.final.result.status, 'failed');
  assert.equal(run.final.result.lifecycle.forcedKill, true);
  assert.equal(run.final.result.lifecycle.orphanDetected, false);
  assert.equal(run.final.evidence.runtimeVerified, false);
});
