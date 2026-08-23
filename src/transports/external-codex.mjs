import path from 'node:path';
import { transitionLifecycle, validateTransportAdapter, validateTransportRequest } from '../transport-contract.mjs';
import { acquireExternalSlot, assertExternalSlot, finalizeExternalArchive, releaseExternalSlot } from './external-archive.mjs';
import { resolveExternalProviderTuple, validateCredentialCommand, writeMinimalExternalHome } from './external-config.mjs';
import { collectExternalExecution } from './external-collection.mjs';
import { buildExternalEvidenceDetails, buildExternalTransportEvidence, containsCredentialText } from './external-evidence.mjs';
import {
  assertPrivateTree,
  assertStableCwd,
  canonicalizeExpectedScope,
  createExecutionId,
  createExecutionTree,
  ensurePrivateDirectory,
  resolveApprovedCwd,
  sha256,
  snapshotParentConfiguration,
  snapshotTree,
  validateExternalContext,
  writePrivateFile,
} from './external-fs-safety.mjs';
import {
  assertExternalProcessGroupClosed,
  launchExternalProcess,
  resolveExecutable,
} from './external-process.mjs';
import { buildExternalPrompt, buildFinalTransportResult, writeExternalResultSchema } from './external-result.mjs';

export const EXTERNAL_CODEX_TRANSPORT_ENABLED = false;

export const EXTERNAL_ERROR_CODES = Object.freeze({
  DISABLED: 'EXTERNAL_TRANSPORT_DISABLED',
  BUSY: 'EXTERNAL_CHILD_BUSY',
  PREPARE: 'EXTERNAL_PREPARE_FAILED',
  EXECUTE: 'EXTERNAL_EXECUTE_FAILED',
  CANCEL: 'EXTERNAL_CANCEL_FAILED',
  COLLECT: 'EXTERNAL_COLLECT_FAILED',
  CLEANUP: 'EXTERNAL_CLEANUP_FAILED',
});

function externalError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function provisionalLifecycle(runtimeState, outcome, activeSlotReleased) {
  const processResult = runtimeState.processResult;
  return {
    state: runtimeState.phase,
    outcome,
    pid: processResult.pid,
    startedAt: processResult.startedAt,
    endedAt: processResult.endedAt,
    durationMs: processResult.durationMs,
    exitCode: processResult.exitCode,
    exitSignal: processResult.exitSignal,
    timedOut: processResult.timedOut,
    cancelled: processResult.cancelled,
    forcedKill: processResult.forcedKill,
    orphanDetected: processResult.orphanDetected,
    activeSlotReleased,
  };
}

export function createExternalCodexTransport(options = {}) {
  const {
    stateRoot,
    codexPath,
    catalogSource,
    credentialCommand,
    testMode = false,
    testTimeoutMs = null,
    graceMs = 3000,
    sourceEnv,
    outputLimits,
    now = () => new Date(),
  } = options;
  for (const value of [stateRoot, codexPath, catalogSource]) {
    if (!path.isAbsolute(value ?? '')) throw new Error('external transport paths must be absolute');
  }
  if (testTimeoutMs !== null && (!testMode || !Number.isInteger(testTimeoutMs) || testTimeoutMs <= 0)) {
    throw new Error('test timeout override is invalid');
  }
  const preparedStates = new WeakMap();
  const executionStates = new WeakMap();

  async function prepare(input, rawContext) {
    let slot;
    let paths;
    let request;
    const executionId = createExecutionId(now());
    try {
      const checked = validateTransportRequest(input);
      const context = validateExternalContext(rawContext);
      if (checked.transportPreference === 'native') throw new Error('native request cannot use External adapter');
      const serialized = JSON.stringify(checked);
      if (containsCredentialText(serialized)) throw new Error('task envelope contains credential-like material');
      if (Buffer.byteLength(serialized) > 32 * 1024) throw new Error('task envelope is oversized');
      const resolved = await resolveApprovedCwd(checked.cwd, context.approvedRoot);
      const scope = await canonicalizeExpectedScope(resolved.cwd, checked.expectedScope);
      request = Object.freeze({ ...checked, cwd: resolved.cwd, expectedScope: scope });
      const pack = resolveExternalProviderTuple(request);
      const checkedCredential = validateCredentialCommand(
        credentialCommand,
        pack,
        { allowFixture: testMode },
      );
      await Promise.all([resolveExecutable(codexPath), resolveExecutable(checkedCredential.command)]);
      const [workspaceBefore, parentBefore] = await Promise.all([
        snapshotTree(resolved.approvedRoot),
        snapshotParentConfiguration(context.parentCodexHome),
      ]);
      slot = await acquireExternalSlot({ stateRoot, executionId, taskName: request.taskName, now: now() });
      paths = await createExecutionTree(stateRoot, executionId);
      const configured = await writeMinimalExternalHome({
        homeDir: paths.home,
        catalogSource,
        request,
        credentialCommand: checkedCredential,
        allowFixtureCredential: testMode,
      });
      const schemaPath = await writeExternalResultSchema(paths.evidence, request);
      const resultPath = path.join(paths.results, 'result.json');
      await writePrivateFile(resultPath, '', { exclusive: true });
      const prompt = buildExternalPrompt(request);
      await writePrivateFile(
        path.join(paths.evidence, 'task.private.json'),
        `${JSON.stringify(request, null, 2)}\n`,
        { exclusive: true, maxBytes: 32 * 1024 },
      );
      const privateTree = await assertPrivateTree(paths.root);
      if (!privateTree.pass) throw new Error('prepared execution tree is not owner-only');
      const prepared = Object.freeze({ executionId, taskName: request.taskName, providerId: request.providerId, model: request.model });
      preparedStates.set(prepared, {
        phase: 'prepared', request, context, pack, configured, paths, slot, prompt,
        taskSha256: sha256(prompt),
        workspaceBefore, scopeRoot: resolved.approvedRoot, parentBefore,
      });
      return prepared;
    } catch (error) {
      if (slot) {
        try {
          const archiveDir = paths?.archive ?? path.join(stateRoot, 'preparation-archive');
          await ensurePrivateDirectory(archiveDir);
          const archive = await finalizeExternalArchive({
            archiveDir, executionId, request: request ?? input, status: 'failed',
            lifecycle: { state: 'cleanup_pending', outcome: 'failed', activeSlotReleased: false },
            collection: { changedFiles: [], childResult: null, issues: ['preparation failed'] },
            evidenceRefs: [], now: now(),
          });
          await releaseExternalSlot(slot, archive.archivePath);
        } catch {
          // Retain the exact active marker when safe finalization cannot be proven.
        }
      }
      if (error?.code === EXTERNAL_ERROR_CODES.BUSY) throw error;
      throw externalError(EXTERNAL_ERROR_CODES.PREPARE, 'External transport preparation failed', error);
    }
  }

  async function execute(prepared) {
    if (!EXTERNAL_CODEX_TRANSPORT_ENABLED && !testMode) {
      throw externalError(EXTERNAL_ERROR_CODES.DISABLED, 'External Codex transport is disabled');
    }
    const state = preparedStates.get(prepared);
    if (!state || state.phase !== 'prepared') throw externalError(EXTERNAL_ERROR_CODES.EXECUTE, 'prepared handle is invalid');
    try {
      await Promise.all([assertExternalSlot(state.slot), assertStableCwd(state.request.cwd)]);
      state.phase = transitionLifecycle(state.phase, 'running');
      state.process = await launchExternalProcess({
        codexPath,
        credentialCommandPath: state.configured.credentialCommand.command,
        codexHome: state.paths.home,
        tmpDir: state.paths.tmp,
        cwd: state.request.cwd,
        schemaPath: path.join(state.paths.evidence, 'result.schema.json'),
        resultPath: path.join(state.paths.results, 'result.json'),
        stdoutPath: path.join(state.paths.logs, 'stdout.jsonl'),
        stderrPath: path.join(state.paths.logs, 'stderr.log'),
        permissionProfile: state.request.permissionProfile,
        stdin: state.prompt,
        timeoutMs: testTimeoutMs ?? state.request.timeoutMs,
        graceMs,
        outputLimits,
        sourceEnv,
      });
      const execution = Object.freeze({ executionId: prepared.executionId, taskName: prepared.taskName, pid: state.process.pid });
      executionStates.set(execution, state);
      return execution;
    } catch (error) {
      throw externalError(EXTERNAL_ERROR_CODES.EXECUTE, 'External transport execution failed', error);
    }
  }

  async function cancel(execution) {
    const state = executionStates.get(execution);
    if (!state?.process) throw externalError(EXTERNAL_ERROR_CODES.CANCEL, 'execution handle is invalid');
    if (state.final) return false;
    return state.process.cancel();
  }

  async function collect(execution) {
    const state = executionStates.get(execution);
    if (!state?.process) throw externalError(EXTERNAL_ERROR_CODES.COLLECT, 'execution handle is invalid');
    if (state.collection) return state.collection;
    try {
      const collected = await collectExternalExecution(state);
      state.processResult = collected.processResult;
      state.outcome = collected.outcome;
      state.phase = transitionLifecycle(state.phase, state.outcome);
      state.collection = collected.collection;
      return state.collection;
    } catch (error) {
      throw externalError(EXTERNAL_ERROR_CODES.COLLECT, 'External transport collection failed', error);
    }
  }

  async function cleanup(execution) {
    const state = executionStates.get(execution);
    if (!state?.collection) throw externalError(EXTERNAL_ERROR_CODES.CLEANUP, 'execution must be collected before cleanup');
    if (state.final) return state.final;
    try {
      state.phase = transitionLifecycle(state.outcome, 'cleanup_pending');
      const pendingLifecycle = provisionalLifecycle(state, state.outcome, false);
      const archived = await finalizeExternalArchive({
        archiveDir: state.paths.archive,
        executionId: execution.executionId,
        request: state.request,
        status: state.outcome,
        lifecycle: pendingLifecycle,
        collection: state.collection,
        evidenceRefs: state.collection.evidenceRefs,
        now: now(),
      });
      assertExternalProcessGroupClosed(state.processResult);
      await releaseExternalSlot(state.slot, archived.archivePath);
      state.phase = transitionLifecycle(state.phase, 'closed');
      const lifecycle = provisionalLifecycle(state, state.outcome, true);
      const evidenceRefs = Object.freeze([...state.collection.evidenceRefs, archived.archiveRef]);
      const result = buildFinalTransportResult({
        request: state.request,
        outcome: state.outcome,
        childResult: state.collection.childResult,
        changedFiles: state.collection.changedFiles,
        lifecycle,
        evidenceRefs,
        issues: state.collection.issues,
      });
      const evidence = buildExternalTransportEvidence({
        request: state.request,
        parsed: state.collection.parsedEvidence,
        evidenceRefs,
        acceptance: {
          resultValid: state.outcome === 'completed' && Boolean(state.collection.childResult),
          workspaceScopeValid: state.collection.workspaceScopeValid,
          lifecycleValid: !lifecycle.orphanDetected,
          credentialSafetyValid: state.collection.secretScan.pass,
          parentIsolationValid: state.collection.parentIsolationValid,
        },
        codexBinary: codexPath,
        credentialReady: null,
        allowRuntimeVerification: false,
      });
      const evidenceDetails = buildExternalEvidenceDetails({
        parsed: state.collection.parsedEvidence,
        collection: state.collection,
        lifecycle,
        evidenceRefs,
        boundary: testMode ? 'test-fixture' : 'runtime',
      });
      state.final = Object.freeze({ result, evidence, evidenceDetails, archiveRef: archived.archiveRef });
      return state.final;
    } catch (error) {
      throw externalError(EXTERNAL_ERROR_CODES.CLEANUP, 'External transport cleanup failed', error);
    }
  }

  const adapter = {
    name: 'external-codex',
    describe: () => Object.freeze({
      name: 'external-codex', enabled: EXTERNAL_CODEX_TRANSPORT_ENABLED,
      billable: true, maxConcurrency: 1, automaticRetries: 0,
      permissionProfiles: Object.freeze(['read-only', 'workspace-write']),
    }),
    prepare,
    execute,
    cancel,
    collect,
    cleanup,
  };
  return validateTransportAdapter(adapter);
}
