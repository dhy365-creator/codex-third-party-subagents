import fs from 'node:fs/promises';
import path from 'node:path';
import {
  completeBridgeTask,
  createBridgeTask,
  failBridgeTask,
} from '../../../src/bridge.mjs';
import { promptForEnvelope } from './envelope.mjs';
import { runExternalChild } from './launcher.mjs';
import { parseResultEnvelope } from './result.mjs';
import { superviseProcess } from './supervisor.mjs';

export function liveProbeNames({ runtimeCompletion = false } = {}) {
  return runtimeCompletion ? ['read', 'coding'] : ['identity', 'read', 'coding'];
}

export async function runLiveProbe({ scratch, codexPath, schemaPath, task, timeoutMs = 180_000 } = {}) {
  const base = path.join(scratch.logs, task.taskName);
  await createBridgeTask({
    root: scratch.bridge,
    taskName: task.taskName,
    cwd: task.cwd,
    message: task.message,
    providerId: task.providerId,
    providerRole: task.providerRole,
    model: task.model,
  });
  let launched;
  let result = null;
  let error = null;
  let archive;
  try {
    launched = await runExternalChild({
      codexPath,
      codexHome: scratch.home,
      tmpDir: scratch.tmp,
      cwd: task.cwd,
      schemaPath,
      resultPath: path.join(scratch.results, `${task.taskName}.json`),
      stdoutPath: `${base}.events.jsonl`,
      stderrPath: `${base}.stderr.log`,
      prompt: promptForEnvelope(task),
      sandbox: task.mode === 'coding' ? 'workspace-write' : 'read-only',
      timeoutMs,
    });
    if (launched.lifecycle.timedOut) throw new Error('external child timed out');
    if (launched.lifecycle.orphanDetected) throw new Error('external child left an orphan process');
    if (launched.lifecycle.exitCode !== 0) {
      throw new Error(`external child exited with code ${launched.lifecycle.exitCode ?? 'unknown'}`);
    }
    result = parseResultEnvelope(launched.resultText, task);
    if (result.status !== 'completed') throw new Error('external child reported failure');
    archive = await completeBridgeTask(task.taskName, { root: scratch.bridge });
  } catch (caught) {
    error = caught;
    try {
      archive = await failBridgeTask(task.taskName, { root: scratch.bridge });
    } catch {
      // Preserve the probe failure; archive validation is reported separately.
    }
  }
  return {
    taskName: task.taskName,
    launched,
    result,
    error: error?.message ?? null,
    archiveStatus: archive?.status ?? null,
    archiveName: archive?.archivePath ? path.basename(archive.archivePath) : null,
  };
}

export async function runLocalFailureProbe({ scratch } = {}) {
  const taskName = 'controlled-failure';
  await createBridgeTask({
    root: scratch.bridge,
    taskName,
    cwd: scratch.workspace,
    message: 'controlled local lifecycle failure; no provider request',
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
  });
  const lifecycle = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(7)'],
    cwd: scratch.workspace,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdoutPath: path.join(scratch.logs, 'controlled-failure.stdout.log'),
    stderrPath: path.join(scratch.logs, 'controlled-failure.stderr.log'),
    timeoutMs: 5_000,
  });
  const archive = await failBridgeTask(taskName, { root: scratch.bridge });
  const activeExists = await fs.access(path.join(scratch.bridge, 'active')).then(() => true, () => false);
  return {
    lifecycle,
    archiveStatus: archive.status,
    archiveName: path.basename(archive.archivePath),
    activeReleased: !activeExists,
  };
}
