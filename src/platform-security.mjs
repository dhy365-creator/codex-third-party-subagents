import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const SID_PATTERN = /^S-1-(?:\d+-){1,14}\d+$/u;
let cachedIdentity;
const READ_SECURITY_DESCRIPTOR = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = Get-Acl -LiteralPath $env:CODEX_SECURITY_PATH',
  '[Console]::Out.Write($acl.Sddl)',
].join('\n');
const RESTORE_SECURITY_DESCRIPTOR = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = Get-Acl -LiteralPath $env:CODEX_SECURITY_PATH',
  '$acl.SetSecurityDescriptorSddlForm($env:CODEX_SECURITY_SDDL)',
  'Set-Acl -LiteralPath $env:CODEX_SECURITY_PATH -AclObject $acl',
].join('\n');

function systemExecutable(name, env = process.env) {
  const root = path.resolve(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows');
  return path.join(root, 'System32', name);
}

function powershellPath(env = process.env) {
  const root = path.resolve(env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows');
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function encodedPowerShell(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function powershellEnvironment(env, values) {
  return {
    SystemRoot: env.SystemRoot ?? env.WINDIR,
    WINDIR: env.WINDIR ?? env.SystemRoot,
    ...values,
  };
}

function validSecurityDescriptor(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 16 * 1024
    && value.startsWith('O:')
    && !/[\r\n\0]/u.test(value);
}

export async function captureWindowsSecurityDescriptor(target, {
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const { stdout } = await execFileImpl(powershellPath(env), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    encodedPowerShell(READ_SECURITY_DESCRIPTOR),
  ], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024,
    env: powershellEnvironment(env, { CODEX_SECURITY_PATH: target }),
  });
  const descriptor = String(stdout);
  if (!validSecurityDescriptor(descriptor)) throw new Error('Windows security descriptor is invalid');
  return descriptor;
}

export async function restoreWindowsSecurityDescriptor(target, descriptor, {
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  if (!validSecurityDescriptor(descriptor)) throw new Error('Windows security descriptor is invalid');
  await execFileImpl(powershellPath(env), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    encodedPowerShell(RESTORE_SECURITY_DESCRIPTOR),
  ], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024,
    env: powershellEnvironment(env, {
      CODEX_SECURITY_PATH: target,
      CODEX_SECURITY_SDDL: descriptor,
    }),
  });
}

async function currentIdentity({ env = process.env, execFileImpl = execFile } = {}) {
  if (execFileImpl === execFile && cachedIdentity) return cachedIdentity;
  const { stdout } = await execFileImpl(systemExecutable('whoami.exe', env), [
    '/user', '/fo', 'csv', '/nh',
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
  const match = String(stdout).match(/^"([^"]+)","(S-1-(?:\d+-){1,14}\d+)"/u);
  if (!match || !SID_PATTERN.test(match[2])) throw new Error('current Windows user identity is unavailable');
  const identity = Object.freeze({ account: match[1], sid: match[2] });
  if (execFileImpl === execFile) cachedIdentity = identity;
  return identity;
}

function accessRule(sid, kind) {
  return kind === 'directory' ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
}

export async function hardenWindowsAcl(target, {
  kind,
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  if (!['file', 'directory'].includes(kind)) throw new Error('Windows ACL path kind is invalid');
  const { sid, account } = await currentIdentity({ env, execFileImpl });
  await execFileImpl(systemExecutable('icacls.exe', env), [
    target, '/setowner', `*${sid}`, '/q',
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
  await execFileImpl(systemExecutable('icacls.exe', env), [
    target, '/inheritance:r', '/grant:r', accessRule(sid, kind), '/q',
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
  const ready = await inspectWindowsAcl(target, { kind, sid, account, env, execFileImpl });
  if (!ready) throw new Error('Windows owner-only ACL could not be established');
}

export async function inspectWindowsAcl(target, {
  kind,
  sid,
  account,
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  if (!['file', 'directory'].includes(kind)) return false;
  const identity = account && sid ? { account, sid } : await currentIdentity({ env, execFileImpl });
  const { stdout } = await execFileImpl(systemExecutable('icacls.exe', env), [target], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024,
  });
  const escaped = identity.account.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const expected = kind === 'directory'
    ? new RegExp(`${escaped}:\\(OI\\)\\(CI\\)\\(F\\)`, 'iu')
    : new RegExp(`${escaped}:\\(F\\)`, 'iu');
  const rules = String(stdout).split(/\r?\n/u).filter((line) => line.includes(':('));
  return rules.length === 1 && expected.test(rules[0]) && !rules[0].includes('(I)');
}

export async function secureManagedPath(target, {
  kind,
  mode,
  platform = process.platform,
  ...options
} = {}) {
  if (platform === 'darwin') {
    await fs.chmod(target, mode);
    return;
  }
  if (platform === 'win32') {
    await hardenWindowsAcl(target, { kind, ...options });
    return;
  }
  throw new Error('managed filesystem platform is unsupported');
}

export async function privatePathReady(target, {
  kind,
  mode,
  uid,
  platform = process.platform,
  ...options
} = {}) {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink()) return false;
  if (kind === 'file' && !info.isFile()) return false;
  if (kind === 'directory' && !info.isDirectory()) return false;
  if (platform === 'darwin') {
    return (mode == null || (info.mode & 0o777) === mode) && (uid == null || info.uid === uid);
  }
  if (platform === 'win32') return inspectWindowsAcl(target, { kind, ...options });
  return false;
}

export async function assertNoReparsePath(target, root, {
  platform = process.platform,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('managed path escapes its approved root');
  }
  const rootInfo = await fs.lstat(resolvedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('approved root is not a real directory');
  }
  const rootCanonical = await fs.realpath(resolvedRoot);
  if (platform === 'win32' && rootCanonical.toLowerCase() !== resolvedRoot.toLowerCase()) {
    throw new Error('approved root traverses a reparse point');
  }
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error('managed filesystem platform is unsupported');
  }
  const components = relative ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  let expectedCanonical = rootCanonical;
  for (const component of components) {
    current = path.join(current, component);
    expectedCanonical = path.join(expectedCanonical, component);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('managed path traverses a symlink or junction');
    const canonical = await fs.realpath(current);
    const same = platform === 'win32'
      ? canonical.toLowerCase() === path.resolve(current).toLowerCase()
      : canonical === expectedCanonical;
    if (!same) throw new Error('managed path traverses a reparse point');
  }
}
