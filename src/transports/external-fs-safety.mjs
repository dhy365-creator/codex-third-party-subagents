import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

export async function ensurePrivateDirectory(directory, { exclusive = false } = {}) {
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
  if (current.isSymbolicLink() || !current.isDirectory() || current.uid !== ownerUid(current)) {
    throw new Error('private directory ownership or type is invalid');
  }
  await fs.chmod(directory, EXTERNAL_DIRECTORY_MODE);
  return directory;
}

export async function writePrivateFile(filePath, data, { exclusive = false, maxBytes = 1024 * 1024 } = {}) {
  if (!path.isAbsolute(filePath ?? '')) throw new Error('private file path must be absolute');
  const contents = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (contents.byteLength > maxBytes) throw new Error('private file exceeds its size limit');
  await ensurePrivateDirectory(path.dirname(filePath));
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
  await fs.chmod(temporary, EXTERNAL_FILE_MODE);
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
  return filePath;
}

export function createExecutionId(now = new Date()) {
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/gu, '');
  return `${stamp}-${crypto.randomBytes(8).toString('hex')}`;
}

export async function createExecutionTree(stateRoot, executionId) {
  if (!/^[A-Za-z0-9-]{12,96}$/u.test(executionId ?? '')) throw new Error('execution id is invalid');
  await ensurePrivateDirectory(stateRoot);
  const executions = path.join(stateRoot, 'executions');
  await ensurePrivateDirectory(executions);
  const root = path.join(executions, executionId);
  await ensurePrivateDirectory(root, { exclusive: true });
  const names = ['home', 'results', 'logs', 'evidence', 'archive'];
  const directories = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(directories)) await ensurePrivateDirectory(directory);
  directories.tmp = path.join(directories.home, 'tmp');
  await ensurePrivateDirectory(directories.tmp);
  return Object.freeze({ root, ...directories });
}

export async function resolveApprovedCwd(cwd, approvedRoot) {
  if (!path.isAbsolute(cwd ?? '') || !path.isAbsolute(approvedRoot ?? '')) {
    throw new Error('cwd and approvedRoot must be absolute');
  }
  const inputInfo = await fs.lstat(cwd);
  if (inputInfo.isSymbolicLink() || !inputInfo.isDirectory()) throw new Error('cwd must be a real directory');
  const [resolved, resolvedRoot] = await Promise.all([fs.realpath(cwd), fs.realpath(approvedRoot)]);
  const unsafeRoots = new Set(['/', os.homedir(), os.tmpdir(), '/tmp', '/private/tmp']
    .map((value) => path.resolve(value)));
  if (unsafeRoots.has(path.resolve(resolved)) || unsafeRoots.has(path.resolve(resolvedRoot))) {
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

export async function assertStableCwd(expectedCwd) {
  const info = await fs.lstat(expectedCwd);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('cwd changed type before execution');
  if (await fs.realpath(expectedCwd) !== expectedCwd) throw new Error('cwd realpath changed');
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

export async function tightenPrivateTree(root) {
  async function visit(target) {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) throw new Error('private runtime tree contains a symlink');
    if (info.isDirectory()) {
      await fs.chmod(target, EXTERNAL_DIRECTORY_MODE);
      for (const name of await fs.readdir(target)) await visit(path.join(target, name));
    } else if (info.isFile()) {
      await fs.chmod(target, EXTERNAL_FILE_MODE);
    } else throw new Error('private runtime tree contains an unsupported entry');
  }
  await visit(root);
  return root;
}

export async function assertPrivateTree(root) {
  const problems = [];
  async function visit(target, relative = '.') {
    const info = await fs.lstat(target);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) problems.push(`${relative}: symlink`);
    else if (info.isDirectory()) {
      if (mode !== EXTERNAL_DIRECTORY_MODE) problems.push(`${relative}: directory mode ${mode.toString(8)}`);
      for (const name of await fs.readdir(target)) await visit(path.join(target, name), path.join(relative, name));
    } else if (info.isFile()) {
      if (mode !== EXTERNAL_FILE_MODE) problems.push(`${relative}: file mode ${mode.toString(8)}`);
    } else problems.push(`${relative}: unsupported type`);
  }
  await visit(root);
  return Object.freeze({ pass: problems.length === 0, problems: Object.freeze(problems) });
}

export { digest as sha256, lstatIfExists };
