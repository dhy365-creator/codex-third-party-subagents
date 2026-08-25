#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { keychainReady } from '../../src/keychain.mjs';
import { createScratch, assertPrivateTree, tightenPrivateTree, writePrivateFile } from './lib/fs-safety.mjs';
import { writeMinimalChildHome } from './lib/config.mjs';
import { writeTaskEnvelope, expectedScopeIsRespected } from './lib/envelope.mjs';
import { eventSummary, runtimeAttribution, scanCredentialLeaks } from './lib/evidence.mjs';
import { createFixture } from './lib/fixture.mjs';
import { isolatedChildEnvironment } from './lib/launcher.mjs';
import { liveProbeNames, runLiveProbe, runLocalFailureProbe } from './lib/probe.mjs';
import { writeResultSchema } from './lib/result.mjs';
import {
  compareSnapshots,
  parentConfigurationUnchanged,
  snapshotParentConfiguration,
  snapshotTree,
} from './lib/snapshots.mjs';
import { superviseProcess } from './lib/supervisor.mjs';

const execFile = promisify(execFileCallback);

function parseArgs(argv) {
  const options = {
    codexPath: '/opt/homebrew/bin/codex',
    catalogSource: path.join(os.homedir(), '.codex', 'model-catalogs', 'deepseek-v4-flash.json'),
    live: false,
    runtimeCompletion: false,
    timeoutMs: 180_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--runtime-completion') options.runtimeCompletion = true;
    else if (arg === '--codex') options.codexPath = path.resolve(argv[++index] ?? '');
    else if (arg === '--catalog') options.catalogSource = path.resolve(argv[++index] ?? '');
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 300_000) {
    throw new Error('timeout must be between 10000 and 300000 ms');
  }
  return options;
}

function task({ taskName, cwd, mode, message, expectedScope, acceptanceCriteria }) {
  return {
    taskName,
    cwd,
    mode,
    message,
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    expectedScope,
    acceptanceCriteria,
  };
}

async function fixtureTests(fixtureRoot, logPath) {
  try {
    const result = await execFile(process.execPath, ['--test'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    await writePrivateFile(logPath, `${result.stdout}${result.stderr}`);
    return { pass: true, exitCode: 0 };
  } catch (error) {
    await writePrivateFile(logPath, `${error.stdout ?? ''}${error.stderr ?? ''}`);
    return { pass: false, exitCode: error.code ?? 1 };
  }
}

async function validateConfig(options, scratch, fixtureRoot) {
  const stdoutPath = path.join(scratch.logs, 'config-validation.stdout.log');
  const lifecycle = await superviseProcess({
    command: options.codexPath,
    args: ['debug', 'models', '--bundled'],
    cwd: fixtureRoot,
    env: isolatedChildEnvironment({ codexHome: scratch.home, tmpDir: scratch.tmp }),
    stdoutPath,
    stderrPath: path.join(scratch.logs, 'config-validation.stderr.log'),
    timeoutMs: 20_000,
  });
  if (lifecycle.exitCode === 0) {
    await writePrivateFile(stdoutPath, 'Bundled model catalog CLI check completed; raw public catalog omitted.\n');
  }
  return lifecycle;
}

async function childCredentialReady(account, scratch) {
  const environment = isolatedChildEnvironment({ codexHome: scratch.home, tmpDir: scratch.tmp });
  return execFile('/usr/bin/security', [
    'find-generic-password',
    '-a', account,
    '-s', 'codex-deepseek-api-key',
  ], {
    env: environment,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  }).then(() => true, () => false);
}

async function probeEvidence(probe, scratch) {
  const events = await eventSummary(probe.launched.lifecycle.stdoutPath);
  if (events.threadIds.length !== 1) throw new Error('probe did not produce exactly one attributable thread');
  const attribution = await runtimeAttribution(scratch.home, events.threadIds[0]);
  return { events, attribution };
}

async function optionalProbeEvidence(probe, scratch) {
  if (!probe.launched?.lifecycle?.stdoutPath) return null;
  try {
    return await probeEvidence(probe, scratch);
  } catch {
    return null;
  }
}

function publicProbe(probe, evidence) {
  return {
    taskName: probe.taskName,
    lifecycle: probe.launched?.lifecycle ?? null,
    result: probe.result,
    error: probe.error,
    archiveStatus: probe.archiveStatus,
    archiveName: probe.archiveName,
    events: evidence?.events ?? null,
    attribution: evidence?.attribution ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== 'darwin') throw new Error('external child spike is macOS-only');
  const account = os.userInfo().username;
  const credentialReady = await keychainReady({
    account,
    service: 'codex-deepseek-api-key',
  }).then(() => true, () => false);
  if (!credentialReady) {
    process.stdout.write('CREDENTIAL NOT READY\n');
    process.exitCode = 2;
    return;
  }

  const parentBefore = await snapshotParentConfiguration();
  const scratch = await createScratch();
  const normalProbes = liveProbeNames(options);
  const summary = {
    scratchName: path.basename(scratch.root),
    liveRequested: options.live,
    normalProbes,
    credentialReady,
    probes: {},
  };
  let failure = null;
  try {
    summary.childCredentialReady = await childCredentialReady(account, scratch);
    if (!summary.childCredentialReady) throw new Error('CREDENTIAL NOT READY');
    const childHome = await writeMinimalChildHome({
      homeDir: scratch.home,
      catalogSource: options.catalogSource,
      keychainAccount: account,
    });
    const fixtureRoot = await createFixture(scratch.workspace);
    const schemaPath = await writeResultSchema(scratch.evidence);
    const initialTests = await fixtureTests(fixtureRoot, path.join(scratch.logs, 'fixture-before.log'));
    if (initialTests.pass) throw new Error('fixture bug is not reproducible');
    summary.initialTests = initialTests;
    summary.config = {
      providerId: childHome.pack.id,
      providerRole: childHome.pack.role,
      model: childHome.pack.model,
      wireApi: childHome.pack.wireApi,
      credentialSource: 'command-backed macOS Keychain',
    };
    const configValidation = await validateConfig(options, scratch, fixtureRoot);
    summary.configValidation = configValidation;
    if (configValidation.exitCode !== 0 || configValidation.orphanDetected) {
      throw new Error('minimal child config failed strict local validation');
    }
    const failureProbe = await runLocalFailureProbe({ scratch });
    summary.failureProbe = failureProbe;
    if (failureProbe.lifecycle.exitCode !== 7
      || failureProbe.lifecycle.orphanDetected
      || failureProbe.archiveStatus !== 'failed'
      || !failureProbe.activeReleased) {
      throw new Error('controlled failure lifecycle probe failed');
    }
    if (!options.live) throw new Error('live execution was not explicitly enabled');

    if (normalProbes.includes('identity')) {
      const identityTask = task({
        taskName: 'identity-probe',
        cwd: fixtureRoot,
        mode: 'identity',
        message: 'Complete a no-file-change identity handshake. Do not inspect files or run tools.',
        expectedScope: [],
        acceptanceCriteria: ['Return a completed structured result', 'Report no changed files'],
      });
      await writeTaskEnvelope(scratch.tasks, identityTask, { fixtureRoot });
      const identityProbe = await runLiveProbe({ scratch, codexPath: options.codexPath, schemaPath, task: identityTask, timeoutMs: options.timeoutMs });
      const identityEvidence = await optionalProbeEvidence(identityProbe, scratch);
      summary.probes.identity = publicProbe(identityProbe, identityEvidence);
      if (identityProbe.error) throw new Error(`identity probe failed: ${identityProbe.error}`);
      if (!identityEvidence?.attribution.verified) throw new Error('PROVIDER ATTRIBUTION = FAIL');
    }

    const beforeRead = await snapshotTree(fixtureRoot);
    const readTask = task({
      taskName: 'bounded-read',
      cwd: fixtureRoot,
      mode: 'read',
      message: 'Inspect src/math.js and test/math.test.js. Identify the empty-list bug and propose the minimal fix without modifying files.',
      expectedScope: [],
      acceptanceCriteria: ['Identify src/math.js', 'Explain the empty-list failure', 'Propose a minimal fix', 'Modify no files'],
    });
    await writeTaskEnvelope(scratch.tasks, readTask, { fixtureRoot });
    const readProbe = await runLiveProbe({ scratch, codexPath: options.codexPath, schemaPath, task: readTask, timeoutMs: options.timeoutMs });
    const readEvidence = await optionalProbeEvidence(readProbe, scratch);
    const readDiff = compareSnapshots(beforeRead, await snapshotTree(fixtureRoot));
    summary.probes.read = { ...publicProbe(readProbe, readEvidence), diff: readDiff };
    if (readProbe.error) throw new Error(`read probe failed: ${readProbe.error}`);
    const readText = JSON.stringify(readProbe.result).toLowerCase();
    if (!readEvidence?.attribution.verified
      || readDiff.added.length || readDiff.deleted.length || readDiff.changed.length
      || !readText.includes('src/math.js') || !/(empty|zero|length)/u.test(readText)) {
      throw new Error('bounded read acceptance failed');
    }

    const beforeCoding = await snapshotTree(fixtureRoot);
    const codingTask = task({
      taskName: 'bounded-coding',
      cwd: fixtureRoot,
      mode: 'coding',
      message: 'Fix average([]) so it returns 0. Modify only src/math.js, then run node --test.',
      expectedScope: ['src/math.js'],
      acceptanceCriteria: ['Only src/math.js changes', 'node --test passes', 'Return a completed structured result'],
    });
    await writeTaskEnvelope(scratch.tasks, codingTask, { fixtureRoot });
    const codingProbe = await runLiveProbe({ scratch, codexPath: options.codexPath, schemaPath, task: codingTask, timeoutMs: options.timeoutMs });
    const codingEvidence = await optionalProbeEvidence(codingProbe, scratch);
    const codingDiff = compareSnapshots(beforeCoding, await snapshotTree(fixtureRoot));
    summary.probes.coding = { ...publicProbe(codingProbe, codingEvidence), diff: codingDiff };
    if (codingProbe.error) throw new Error(`coding probe failed: ${codingProbe.error}`);
    const finalTests = await fixtureTests(fixtureRoot, path.join(scratch.logs, 'fixture-after.log'));
    summary.finalTests = finalTests;
    if (!codingEvidence?.attribution.verified
      || !expectedScopeIsRespected(codingDiff, codingTask.expectedScope)
      || JSON.stringify(codingDiff.changed) !== JSON.stringify(['src/math.js'])
      || codingDiff.added.length || codingDiff.deleted.length
      || !finalTests.pass) {
      throw new Error('bounded coding acceptance failed');
    }
  } catch (error) {
    failure = error?.message ?? 'spike failed';
  } finally {
    const parentAfter = await snapshotParentConfiguration();
    summary.parentConfigurationUnchanged = parentConfigurationUnchanged(parentBefore, parentAfter);
    summary.failure = failure;
    let permissions;
    try {
      await tightenPrivateTree(scratch.root);
      permissions = await assertPrivateTree(scratch.root);
    } catch (error) {
      permissions = { pass: false, problems: [error.message], allowedSymlinks: [] };
    }
    const initialLeakScan = await scanCredentialLeaks(scratch.root);
    summary.privatePermissions = permissions;
    summary.credentialLeakScan = initialLeakScan;
    const evidencePath = path.join(scratch.evidence, 'summary.json');
    await writePrivateFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
    try {
      await tightenPrivateTree(scratch.root);
    } catch (error) {
      permissions.pass = false;
      permissions.problems.push(error.message);
    }
    const finalLeakScan = await scanCredentialLeaks(scratch.root);
    if (!summary.parentConfigurationUnchanged || !permissions.pass || !finalLeakScan.pass) {
      failure = failure ?? 'safety acceptance failed';
    }
    summary.credentialLeakScan = finalLeakScan;
    summary.failure = failure;
    await writePrivateFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...summary, evidenceFile: path.relative(scratch.root, evidencePath) }, null, 2)}\n`);
  }
  if (failure) process.exitCode = 1;
}

await main();
