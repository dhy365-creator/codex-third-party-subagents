import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EXTERNAL_DISABLED_FEATURES } from './external-config.mjs';
import { sanitizeStderrLog, sanitizeStdoutLog } from './external-evidence.mjs';
import { sha256, writePrivateFile } from './external-fs-safety.mjs';
import { validateExternalUserHome } from './external-user-home.mjs';

export const DEFAULT_OUTPUT_LIMITS = Object.freeze({
  stdoutBytes: 1024 * 1024,
  stderrBytes: 256 * 1024,
});

const execFile = promisify(execFileCallback);

function signalProcessGroup(pid, signal, killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function processGroupAlive(pid, killImpl = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function windowsSystemExecutable(name, env) {
  const root = path.resolve(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows');
  return path.join(root, 'System32', name);
}

export function createProcessTreeSupervisor(pid, {
  platform = process.platform,
  env = process.env,
  execFileImpl = execFile,
  killImpl = process.kill,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('process tree pid is invalid');
  if (platform !== 'win32') {
    return Object.freeze({
      terminate: async (force = false) => signalProcessGroup(pid, force ? 'SIGKILL' : 'SIGTERM', killImpl),
      isAlive: async () => processGroupAlive(pid, killImpl),
    });
  }
  const taskkill = windowsSystemExecutable('taskkill.exe', env);
  const tasklist = windowsSystemExecutable('tasklist.exe', env);
  const childEnv = { SystemRoot: env.SystemRoot ?? env.WINDIR, WINDIR: env.WINDIR ?? env.SystemRoot };
  return Object.freeze({
    terminate: async (force = false) => {
      try {
        await execFileImpl(taskkill, ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
          env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
        });
        return true;
      } catch (error) {
        if ([128, 255].includes(Number(error?.code))) return false;
        throw error;
      }
    },
    isAlive: async () => {
      const { stdout } = await execFileImpl(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
      });
      return new RegExp(`,"${pid}",`, 'u').test(String(stdout));
    },
  });
}

export function assertExternalProcessGroupClosed(processResult) {
  if (!processResult || processResult.orphanDetected !== false) {
    const error = new Error('external process group remains active; slot retained');
    error.code = 'EXTERNAL_ORPHAN_ACTIVE';
    throw error;
  }
  return true;
}

function capture(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream.on('data', (chunk) => {
    const data = Buffer.from(chunk);
    const remaining = Math.max(0, maxBytes - bytes);
    if (remaining) chunks.push(data.subarray(0, remaining));
    bytes += Math.min(data.byteLength, remaining);
    if (data.byteLength > remaining) truncated = true;
  });
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated });
}

export async function resolveExecutable(executable, { platform = process.platform } = {}) {
  if (!path.isAbsolute(executable ?? '')) throw new Error('codex binary path must be absolute');
  const input = await fs.lstat(executable);
  if ((platform === 'win32' && input.isSymbolicLink())
    || (!input.isFile() && !input.isSymbolicLink())) {
    throw new Error('codex binary is not a safe executable');
  }
  const resolved = await fs.realpath(executable);
  const info = await fs.stat(resolved);
  const canonical = platform === 'win32' && process.platform === 'win32'
    ? resolved.toLowerCase() === path.resolve(executable).toLowerCase()
    : platform === 'win32' || resolved === path.resolve(executable);
  const executableReady = platform === 'win32'
    ? path.extname(resolved).toLowerCase() === '.exe'
    : (info.mode & 0o111) !== 0 && (info.mode & 0o022) === 0;
  if (!canonical || !info.isFile() || !executableReady) {
    throw new Error('codex binary is not a safe executable');
  }
  return resolved;
}

export function isolatedChildEnvironment({
  codexHome, tmpDir, userHome, executablePaths = [], sourceEnv = process.env,
  platform = process.platform,
} = {}) {
  if (!path.isAbsolute(codexHome ?? '') || !path.isAbsolute(tmpDir ?? '')
    || !path.isAbsolute(userHome ?? '')) {
    throw new Error('isolated CODEX_HOME, TMPDIR, and real user HOME must be absolute');
  }
  const platformPaths = platform === 'win32'
    ? [path.join(sourceEnv.SystemRoot ?? sourceEnv.WINDIR ?? 'C:\\Windows', 'System32')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const safePath = [...new Set([
    path.dirname(process.execPath),
    ...executablePaths.map((value) => path.dirname(value)),
    ...platformPaths,
  ])].join(platform === 'win32' ? ';' : ':');
  const env = platform === 'win32' ? {
    CODEX_HOME: codexHome,
    HOME: userHome,
    USERPROFILE: userHome,
    TEMP: tmpDir,
    TMP: tmpDir,
    PATH: safePath,
    SystemRoot: sourceEnv.SystemRoot ?? sourceEnv.WINDIR,
    WINDIR: sourceEnv.WINDIR ?? sourceEnv.SystemRoot,
    NO_COLOR: '1',
  } : {
    CODEX_HOME: codexHome,
    HOME: userHome,
    TMPDIR: tmpDir,
    PATH: safePath,
    LANG: sourceEnv.LANG ?? 'en_US.UTF-8',
    LC_ALL: sourceEnv.LC_ALL ?? 'en_US.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  for (const name of ['USER', 'LOGNAME']) {
    if (typeof sourceEnv[name] === 'string' && sourceEnv[name]) env[name] = sourceEnv[name];
  }
  if (Object.keys(env).some((name) => /API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/iu.test(name))) {
    throw new Error('child environment contains a credential variable');
  }
  return Object.freeze(env);
}

export function externalCodexArgs({ cwd, schemaPath, resultPath, permissionProfile } = {}) {
  for (const value of [cwd, schemaPath, resultPath]) {
    if (!path.isAbsolute(value ?? '')) throw new Error('Codex execution paths must be absolute');
  }
  if (!['read-only', 'workspace-write'].includes(permissionProfile)) {
    throw new Error('unsupported Codex sandbox');
  }
  return Object.freeze([
    'exec',
    '--strict-config',
    '--ignore-rules',
    '--json',
    '--output-schema', schemaPath,
    '--output-last-message', resultPath,
    '--sandbox', permissionProfile,
    '--cd', cwd,
    '--skip-git-repo-check',
    ...EXTERNAL_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-',
  ]);
}

export async function launchExternalProcess({
  codexPath,
  credentialCommandPath,
  codexHome,
  tmpDir,
  userHome,
  cwd,
  schemaPath,
  resultPath,
  stdoutPath,
  stderrPath,
  permissionProfile,
  stdin,
  timeoutMs,
  graceMs = 3000,
  outputLimits = DEFAULT_OUTPUT_LIMITS,
  sourceEnv,
  platform = process.platform,
  spawnImpl = spawn,
  processTreeSupervisorFactory = createProcessTreeSupervisor,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(graceMs) || graceMs < 0) {
    throw new Error('process timeout configuration is invalid');
  }
  for (const [name, value] of Object.entries(outputLimits)) {
    if (!['stdoutBytes', 'stderrBytes'].includes(name)
      || !Number.isInteger(value) || value <= 0 || value > 4 * 1024 * 1024) {
      throw new Error('process output limits are invalid');
    }
  }
  if (!Number.isInteger(outputLimits.stdoutBytes) || !Number.isInteger(outputLimits.stderrBytes)) {
    throw new Error('process output limits are incomplete');
  }
  const [executable, credentialExecutable] = await Promise.all([
    resolveExecutable(codexPath, { platform }),
    resolveExecutable(credentialCommandPath, { platform }),
    validateExternalUserHome(userHome, { platform }),
  ]);
  const args = externalCodexArgs({ cwd, schemaPath, resultPath, permissionProfile });
  const env = isolatedChildEnvironment({
    codexHome,
    tmpDir,
    userHome,
    executablePaths: [executable, credentialExecutable],
    sourceEnv,
    platform,
  });
  const startedAt = new Date();
  const spawnOptions = {
    cwd,
    env,
    detached: platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
  const child = spawnImpl === spawn
    ? spawn(executable, args, spawnOptions)
    : spawnImpl(executable, args, spawnOptions);
  const supervisor = processTreeSupervisorFactory(child.pid, { platform, env: sourceEnv });
  const readStdout = capture(child.stdout, outputLimits.stdoutBytes);
  const readStderr = capture(child.stderr, outputLimits.stderrBytes);
  let timedOut = false;
  let cancelled = false;
  let forcedKill = false;
  let terminationRequested = false;
  let graceTimer;
  let timeoutTimer;
  let spawnError = null;
  let stdinDelivered = false;

  const requestTermination = (reason) => {
    if (terminationRequested || child.exitCode !== null || child.signalCode !== null) return false;
    terminationRequested = true;
    timedOut = reason === 'timeout';
    cancelled = reason === 'cancelled';
    void supervisor.terminate(false).catch(() => {});
    graceTimer = setTimeout(() => {
      void supervisor.terminate(true).then((killed) => { if (killed) forcedKill = true; }).catch(() => {});
    }, graceMs);
    return true;
  };

  timeoutTimer = setTimeout(() => requestTermination('timeout'), timeoutMs);
  child.stdin.on('error', () => {});
  child.stdin.end(String(stdin ?? ''), () => { stdinDelivered = true; });

  const completion = new Promise((resolve) => {
    let settled = false;
    const finish = async (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      await new Promise((done) => setTimeout(done, 30));
      let orphanDetected = true;
      try {
        if (await supervisor.isAlive()) {
          forcedKill = await supervisor.terminate(true) || forcedKill;
          await new Promise((done) => setTimeout(done, 30));
        }
        orphanDetected = await supervisor.isAlive();
      } catch {
        orphanDetected = true;
      }
      const endedAt = new Date();
      const stdout = readStdout();
      const stderr = readStderr();
      let logError = null;
      try {
        await Promise.all([
          writePrivateFile(stdoutPath, sanitizeStdoutLog(stdout.text), { exclusive: true }),
          writePrivateFile(stderrPath, sanitizeStderrLog(stderr.text), { exclusive: true }),
        ]);
      } catch {
        logError = 'diagnostic log persistence failed';
      }
      resolve(Object.freeze({
        pid: child.pid ?? null,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        exitCode,
        exitSignal,
        timedOut,
        cancelled,
        forcedKill,
        orphanDetected,
        spawnError: spawnError ? 'process spawn failed' : null,
        logError,
        stdoutText: stdout.text,
        stderrText: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdinDelivered,
        stdoutPath,
        stderrPath,
      }));
    };
    child.once('error', (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.once('close', (exitCode, exitSignal) => finish(exitCode, exitSignal));
  });

  return Object.freeze({
    pid: child.pid ?? null,
    args,
    environmentKeys: Object.freeze(Object.keys(env).sort()),
    stdinSha256: sha256(String(stdin ?? '')),
    cancel: () => requestTermination('cancelled'),
    completion,
  });
}
