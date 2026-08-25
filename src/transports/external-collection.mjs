import fs from 'node:fs/promises';
import path from 'node:path';
import { evidenceReference } from './external-archive.mjs';
import {
  parseExternalRuntimeEvidence,
  redactPortableData,
  scanTreeForSecrets,
} from './external-evidence.mjs';
import {
  assertPrivateTree,
  assertStableCwd,
  compareSnapshots,
  isPathInside,
  parentConfigurationUnchanged,
  snapshotParentConfiguration,
  snapshotTree,
  tightenPrivateTree,
  writePrivateFile,
} from './external-fs-safety.mjs';
import { parseExternalChildResult } from './external-result.mjs';

function processOutcome(processResult) {
  if (processResult.timedOut) return 'timed_out';
  if (processResult.cancelled) return 'cancelled';
  if (processResult.spawnError || processResult.logError || processResult.orphanDetected || processResult.forcedKill
    || processResult.exitCode !== 0 || processResult.stdoutTruncated || processResult.stderrTruncated) {
    return 'failed';
  }
  return 'completed';
}

async function readBounded(filePath, maxBytes = 64 * 1024) {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) {
    throw new Error('structured result file is unsafe or oversized');
  }
  return fs.readFile(filePath, 'utf8');
}

function filesChanged(diff) {
  return [...new Set([...diff.added, ...diff.deleted, ...diff.changed])].sort();
}

export async function collectExternalExecution(state) {
  const processResult = await state.process.completion;
  let outcome = processOutcome(processResult);
  const issues = [];
  await assertStableCwd(state.request.cwd).catch(() => issues.push('cwd stability check failed'));

  let diff = { added: [], deleted: [], changed: [] };
  let actualChangedFiles = [];
  let workspaceScopeValid = false;
  try {
    const workspaceAfter = await snapshotTree(state.scopeRoot);
    diff = compareSnapshots(state.workspaceBefore, workspaceAfter);
    const allChanges = filesChanged(diff);
    const externalChanges = allChanges.filter((file) => !isPathInside(
      state.request.cwd,
      path.join(state.scopeRoot, file),
    ));
    actualChangedFiles = allChanges
      .filter((file) => !externalChanges.includes(file))
      .map((file) => path.relative(state.request.cwd, path.join(state.scopeRoot, file)))
      .sort();
    workspaceScopeValid = externalChanges.length === 0
      && actualChangedFiles.every((file) => state.request.expectedScope.includes(file))
      && (state.request.permissionProfile !== 'read-only' || actualChangedFiles.length === 0);
    if (!workspaceScopeValid) issues.push('workspace scope validation failed');
  } catch {
    issues.push('workspace snapshot validation failed');
  }

  let childResult = null;
  if (outcome === 'completed') {
    try {
      childResult = parseExternalChildResult(
        await readBounded(path.join(state.paths.results, 'result.json')),
        state.request,
      );
      if (childResult.status !== 'completed') outcome = 'failed';
      if (JSON.stringify(childResult.changedFiles) !== JSON.stringify(actualChangedFiles)) {
        issues.push('result changedFiles do not match the workspace snapshot');
      }
    } catch {
      issues.push('structured result validation failed');
    }
  }
  if (!childResult || issues.length) outcome = outcome === 'completed' ? 'failed' : outcome;

  await tightenPrivateTree(state.paths.root, { allowedExecutable: state.codexExecutable });
  const [secretScan, permissions, parentAfter] = await Promise.all([
    scanTreeForSecrets(state.paths.root),
    assertPrivateTree(state.paths.root, { allowedExecutable: state.codexExecutable }),
    snapshotParentConfiguration(state.context.parentCodexHome),
  ]);
  const parentIsolationValid = parentConfigurationUnchanged(state.parentBefore, parentAfter);
  if (!secretScan.pass) issues.push('credential scan failed');
  if (!permissions.pass) issues.push('owner-only permission validation failed');
  if (!parentIsolationValid) issues.push('parent configuration changed');
  if (issues.length && outcome === 'completed') outcome = 'failed';

  const parsedEvidence = await parseExternalRuntimeEvidence({
    stdoutText: processResult.stdoutText,
    codexHome: state.paths.home,
    expected: {
      providerId: state.request.providerId,
      model: state.request.model,
      endpoint: state.pack.apiBase,
      taskSha256: state.taskSha256,
      configSha256: state.configured.configSha256,
    },
    stdinDelivered: processResult.stdinDelivered,
  });
  if (parsedEvidence.status !== 'ATTRIBUTED' && outcome === 'completed') {
    issues.push('runtime attribution is incomplete');
    outcome = 'failed';
  }

  const payloads = {
    runtime: parsedEvidence,
    workspace: { diff, changedFiles: actualChangedFiles, scopeValid: workspaceScopeValid },
    result: redactPortableData({ childResult, issues }, {
      cwd: state.request.cwd,
      message: state.request.message,
    }),
  };
  const evidenceRefs = [];
  for (const [kind, payload] of Object.entries(payloads)) {
    const filePath = path.join(state.paths.evidence, `${kind}.json`);
    await writePrivateFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      exclusive: true,
      maxBytes: 128 * 1024,
    });
    evidenceRefs.push(await evidenceReference({
      kind,
      filePath,
      executionRoot: state.paths.root,
    }));
  }

  return Object.freeze({
    processResult,
    outcome,
    collection: Object.freeze({
      outcome,
      childResult,
      changedFiles: Object.freeze(actualChangedFiles),
      issues: Object.freeze([...issues]),
      workspaceScopeValid,
      secretScan,
      permissions,
      parentIsolationValid,
      parsedEvidence,
      evidenceRefs: Object.freeze(evidenceRefs),
    }),
  });
}
