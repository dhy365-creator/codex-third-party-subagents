import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

function signalProcessGroup(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function processGroupAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function superviseProcess({
  command,
  args = [],
  cwd,
  env,
  stdin = '',
  stdoutPath,
  stderrPath,
  timeoutMs = 180_000,
  graceMs = 3_000,
  signal,
} = {}) {
  if (!command || !cwd || !stdoutPath || !stderrPath) throw new Error('process supervision paths are required');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const [stdout, stderr] = await Promise.all([
    fs.open(stdoutPath, 'wx', 0o600),
    fs.open(stderrPath, 'wx', 0o600),
  ]);
  const startedAt = new Date();
  let child;
  let timedOut = false;
  let cancelled = false;
  let forcedKill = false;
  let terminateTimer;
  let timeoutTimer;
  let abortListener;
  let spawnError = null;

  const requestTermination = (reason) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'cancelled') cancelled = true;
    signalProcessGroup(child.pid, 'SIGTERM');
    terminateTimer = setTimeout(() => {
      if (signalProcessGroup(child.pid, 'SIGKILL')) forcedKill = true;
    }, graceMs);
  };

  try {
    child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', stdout.fd, stderr.fd],
    });
    timeoutTimer = setTimeout(() => requestTermination('timeout'), timeoutMs);
    if (signal) {
      abortListener = () => requestTermination('cancelled');
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    }
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
    const completion = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once('error', (error) => {
        spawnError = error;
        finish({ exitCode: null, exitSignal: null });
      });
      child.once('close', (exitCode, exitSignal) => finish({ exitCode, exitSignal }));
    });
    clearTimeout(timeoutTimer);
    clearTimeout(terminateTimer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const endedAt = new Date();
    return {
      pid: child.pid ?? null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      exitCode: completion.exitCode,
      exitSignal: completion.exitSignal,
      timedOut,
      cancelled,
      forcedKill,
      orphanDetected: processGroupAlive(child.pid),
      spawnError: spawnError?.message ?? null,
      stdoutPath,
      stderrPath,
    };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(terminateTimer);
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    await Promise.allSettled([stdout.close(), stderr.close()]);
  }
}
