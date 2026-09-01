import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertNoReparsePath,
  privatePathReady,
  secureManagedPath,
} from '../platform-security.mjs';

export const EXTERNAL_DIRECTORY_MODE = 0o700;
export const EXTERNAL_FILE_MODE = 0o600;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function lstatIfExists(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ownerUid(info) {
  return typeof process.getuid === 'function' ? process.getuid() : info.uid;
}

function platformOptions(options = {}) {
  return {
    platform: options.platform ?? process.platform,
    ...(options.securityOptions ?? {}),
  };
}

async function securePath(target, kind, mode, options) {
  const impl = options.securityImpl?.secureManagedPath ?? secureManagedPath;
  await impl(target, { kind, mode, ...platformOptions(options) });
}

async function pathReady(target, kind, mode, options) {
  const impl = options.securityImpl?.privatePathReady ?? privatePathReady;
  return impl(target, { kind, mode, uid: ownerUid(await fs.lstat(target)), ...platformOptions(options) });
}

async function rejectReparse(target, root, options) {
  if ((options.platform ?? process.platform) !== 'win32') return;
  const impl = options.securityImpl?.assertNoReparsePath ?? assertNoReparsePath;
  await impl(target, root, platformOptions(options));
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

export function validateExternalContext(context) {
  const fields = ['approvedRoot', 'parentCodexHome'];
  if (!context || typeof context !== 'object' || Array.isArray(context)
    || JSON.stringify(Object.keys(context).sort()) !== JSON.stringify(fields.sort())) {
    throw new Error('external transport context fields do not match the contract');
  }
  return context;
}

export async function ensurePrivateDirectory(directory, options = {}) {
  const { exclusive = false } = options;
  if (!path.isAbsolute(directory ?? '')) throw new Error('private directory must be absolute');
  const existing = await lstatIfExists(directory);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error('private directory must be a real directory');
  }
  if (exclusive && existing) throw new Error('private directory already exists');
  if (!existing) {
    await fs.mkdir(directory, { recursive: !exclusive, mode: EXTERNAL_DIRECTORY_MODE });
  }
  const current = await fs.lstat(directory);
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error('private directory ownership or type is invalid');
  }
  await rejectReparse(directory, options.approvedRoot ?? directory, options);
  await securePath(directory, 'directory', EXTERNAL_DIRECTORY_MODE, options);
  if (!(await pathReady(directory, 'directory', EXTERNAL_DIRECTORY_MODE, options))) {
    throw new Error('private directory security is invalid');
  }
  return directory;
}

export async function writePrivateFile(filePath, data, options = {}) {
  const { exclusive = false, maxBytes = 1024 * 1024 } = options;
  if (!path.isAbsolute(filePath ?? '')) throw new Error('private file path must be absolute');
  const contents = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (contents.byteLength > maxBytes) throw new Error('private file exceeds its size limit');
  const directoryOptions = { ...options };
  delete directoryOptions.exclusive;
  delete directoryOptions.maxBytes;
  await ensurePrivateDirectory(path.dirname(filePath), directoryOptions);
  await rejectReparse(filePath, options.approvedRoot ?? path.dirname(filePath), options);
  const existing = await lstatIfExists(filePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('private file target is unsafe');
  }
  if (exclusive && existing) throw new Error('private file already exists');
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.open(temporary, 'wx', EXTERNAL_FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await securePath(temporary, 'file', EXTERNAL_FILE_MODE, options);
  try {
    if (exclusive) {
      await fs.link(temporary, filePath);
      await fs.unlink(temporary);
    } else {
      await fs.rename(temporary, filePath);
    }
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  if (!(await pathReady(filePath, 'file', EXTERNAL_FILE_MODE, options))) {
    throw new Error('private file security is invalid');
  }
  return filePath;
}

export function createExecutionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/gu, '');
  return `${stamp}-${crypto.randomBytes(8).toString('hex')}`;
}

export async function createExecutionTree(stateRoot, executionId, options = {}) {
  if (!/^[A-Za-z0-9-]{12,96}$/u.test(executionId ?? '')) throw new Error('execution id is invalid');
  await ensurePrivateDirectory(stateRoot, { ...options, approvedRoot: stateRoot });
  const executions = path.join(stateRoot, 'executions');
  await ensurePrivateDirectory(executions, { ...options, approvedRoot: stateRoot });
  const root = path.join(executions, executionId);
  await ensurePrivateDirectory(root, { ...options, exclusive: true, approvedRoot: stateRoot });
  const names = ['home', 'results', 'logs', 'evidence', 'archive'];
  const directories = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(directories)) {
    await ensurePrivateDirectory(directory, { ...options, approvedRoot: stateRoot });
  }
  directories.tmp = path.join(directories.home, 'tmp');
  await ensurePrivateDirectory(directories.tmp, { ...options, approvedRoot: stateRoot });
  return Object.freeze({ root, ...directories });
}

export async function resolveApprovedCwd(cwd, approvedRoot, { platform = process.platform } = {}) {
  if (!path.isAbsolute(cwd ?? '') || !path.isAbsolute(approvedRoot ?? '')) {
    throw new Error('cwd and approvedRoot must be absolute');
  }
  const inputInfo = await fs.lstat(cwd);
  if (inputInfo.isSymbolicLink() || !inputInfo.isDirectory()) throw new Error('cwd must be a real directory');
  const [resolved, resolvedRoot] = await Promise.all([fs.realpath(cwd), fs.realpath(approvedRoot)]);
  const normalize = (value) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const unsafeRoots = new Set([path.parse(resolved).root, os.homedir(), os.tmpdir(), '/tmp', '/private/tmp']
    .map(normalize));
  if (unsafeRoots.has(normalize(resolved)) || unsafeRoots.has(normalize(resolvedRoot))) {
    throw new Error('cwd or approvedRoot is an unsafe root');
  }
  if (!isPathInside(resolvedRoot, resolved)) throw new Error('cwd escapes approvedRoot');
  return Object.freeze({ cwd: resolved, approvedRoot: resolvedRoot });
}

async function nearestExisting(target) {
  let current = target;
  while (current !== path.dirname(current)) {
    if (await lstatIfExists(current)) return current;
    current = path.dirname(current);
  }
  return current;
}

export async function canonicalizeExpectedScope(cwd, expectedScope) {
  const canonical = [];
  for (const relative of expectedScope) {
    const candidate = path.resolve(cwd, relative);
    if (!isPathInside(cwd, candidate)) throw new Error('expectedScope escapes cwd');
    const existing = await nearestExisting(candidate);
    const resolvedExisting = await fs.realpath(existing);
    if (!isPathInside(cwd, resolvedExisting)) throw new Error('expectedScope follows a symlink outside cwd');
    canonical.push(path.relative(cwd, candidate));
  }
  return Object.freeze([...new Set(canonical)].sort());
}

export async function assertStableCwd(expectedCwd, { platform = process.platform } = {}) {
  const info = await fs.lstat(expectedCwd);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('cwd changed type before execution');
  const canonical = await fs.realpath(expectedCwd);
  const stable = platform === 'win32'
    ? canonical.toLowerCase() === expectedCwd.toLowerCase()
    : canonical === expectedCwd;
  if (!stable) throw new Error('cwd realpath changed');
  return expectedCwd;
}

export async function snapshotTree(root, { maxFiles = 10_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  const files = {};
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) {
        const resolved = await fs.realpath(target);
        if (!isPathInside(root, resolved)) throw new Error('workspace symlink escapes cwd');
        files[relative] = `SYMLINK:${path.relative(root, resolved)}`;
      } else if (info.isDirectory()) {
        await visit(target);
      } else if (info.isFile()) {
        fileCount += 1;
        totalBytes += info.size;
        if (fileCount > maxFiles || totalBytes > maxBytes) throw new Error('workspace snapshot exceeds its bounds');
        files[relative] = digest(await fs.readFile(target));
      } else {
        throw new Error('workspace contains an unsupported filesystem entry');
      }
    }
  }
  await visit(root);
  return Object.freeze(files);
}

export function compareSnapshots(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.freeze({
    added: names.filter((name) => before[name] === undefined),
    deleted: names.filter((name) => after[name] === undefined),
    changed: names.filter((name) => before[name] !== undefined
      && after[name] !== undefined && before[name] !== after[name]),
  });
}

async function snapshotTarget(target) {
  const info = await lstatIfExists(target);
  if (!info) return { exists: false, type: null, digest: null, count: 0 };
  if (info.isSymbolicLink()) return { exists: true, type: 'symlink', digest: null, count: 1 };
  if (info.isFile()) return { exists: true, type: 'file', digest: digest(await fs.readFile(target)), count: 1 };
  if (!info.isDirectory()) return { exists: true, type: 'other', digest: null, count: 1 };
  const files = await snapshotTree(target);
  return { exists: true, type: 'directory', digest: digest(JSON.stringify(files)), count: Object.keys(files).length };
}

export async function snapshotParentConfiguration(parentCodexHome) {
  if (!path.isAbsolute(parentCodexHome ?? '')) throw new Error('parentCodexHome must be absolute');
  const [configToml, agentsMd, agents] = await Promise.all([
    snapshotTarget(path.join(parentCodexHome, 'config.toml')),
    snapshotTarget(path.join(parentCodexHome, 'AGENTS.md')),
    snapshotTarget(path.join(parentCodexHome, 'agents')),
  ]);
  return Object.freeze({ configToml, agentsMd, agents });
}

export function parentConfigurationUnchanged(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

async function allowedRuntimeSymlink(root, target, allowedExecutable) {
  if (!path.isAbsolute(allowedExecutable ?? '')) return false;
  const relative = path.relative(root, target);
  const allowedName = ['applypatch', 'apply_patch', 'codex-execve-wrapper'].includes(path.basename(target));
  const parts = relative.split(path.sep);
  const executionRootRelative = parts[0] === 'home' && parts[1] === 'tmp' && parts[2] === 'arg0';
  const stateRootRelative = parts[0] === 'executions'
    && /^[A-Za-z0-9-]{12,96}$/u.test(parts[1] ?? '')
    && parts[2] === 'home' && parts[3] === 'tmp' && parts[4] === 'arg0';
  if (!allowedName || (!executionRootRelative && !stateRootRelative)) return false;
  const link = await fs.readlink(target);
  if (!path.isAbsolute(link)) return false;
  try {
    const [resolvedLink, resolvedAllowed] = await Promise.all([
      fs.realpath(link),
      fs.realpath(allowedExecutable),
    ]);
    const info = await fs.stat(resolvedLink);
    const marker = `${path.sep}node_modules${path.sep}@openai${path.sep}codex${path.sep}`;
    const packageOffset = resolvedAllowed.indexOf(marker);
    const packageRoot = packageOffset === -1
      ? null
      : resolvedAllowed.slice(0, packageOffset + marker.length - 1);
    const exactExecutable = resolvedLink === resolvedAllowed;
    const packagedRuntime = packageRoot !== null
      && isPathInside(packageRoot, resolvedLink)
      && path.basename(resolvedLink) === 'codex';
    return (exactExecutable || packagedRuntime)
      && info.isFile() && (info.mode & 0o111) !== 0 && (info.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

export async function tightenPrivateTree(root, options = {}) {
  const { allowedExecutable = null, platform = process.platform } = options;
  async function visit(target) {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) {
      if (platform === 'win32' || !(await allowedRuntimeSymlink(root, target, allowedExecutable))) {
        throw new Error('private runtime tree contains an unsafe symlink');
      }
      return;
    }
    if (info.isDirectory()) {
      await rejectReparse(target, root, options);
      await securePath(target, 'directory', EXTERNAL_DIRECTORY_MODE, options);
      for (const name of await fs.readdir(target)) await visit(path.join(target, name));
    } else if (info.isFile()) {
      await rejectReparse(target, root, options);
      await securePath(target, 'file', EXTERNAL_FILE_MODE, options);
    } else throw new Error('private runtime tree contains an unsupported entry');
  }
  await visit(root);
  return root;
}

export async function assertPrivateTree(root, options = {}) {
  const { allowedExecutable = null, platform = process.platform } = options;
  const problems = [];
  async function visit(target, relative = '.') {
    const info = await fs.lstat(target);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      if (platform === 'win32' || !(await allowedRuntimeSymlink(root, target, allowedExecutable))) {
        problems.push(`${relative}: symlink`);
      }
    }
    else if (info.isDirectory()) {
      try { await rejectReparse(target, root, options); } catch { problems.push(`${relative}: reparse`); }
      if (!(await pathReady(target, 'directory', EXTERNAL_DIRECTORY_MODE, options))) {
        problems.push(`${relative}: directory security`);
      }
      for (const name of await fs.readdir(target)) await visit(path.join(target, name), path.join(relative, name));
    } else if (info.isFile()) {
      try { await rejectReparse(target, root, options); } catch { problems.push(`${relative}: reparse`); }
      if (!(await pathReady(target, 'file', EXTERNAL_FILE_MODE, options))) {
        problems.push(`${relative}: file security`);
      }
    } else problems.push(`${relative}: unsupported type`);
  }
  await visit(root);
  return Object.freeze({ pass: problems.length === 0, problems: Object.freeze(problems) });
}

export { digest as sha256, lstatIfExists };
