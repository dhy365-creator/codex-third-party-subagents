import fs from 'node:fs/promises';
import path from 'node:path';

export const SCRATCH_PREFIX = 'codex-third-party-external-child-';

export async function createScratch({ baseDir = '/private/tmp', now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/gu, '');
  const root = await fs.mkdtemp(path.join(baseDir, `${SCRATCH_PREFIX}${stamp}-`));
  await fs.chmod(root, 0o700);
  const names = ['home', 'workspace', 'evidence', 'results', 'logs', 'tasks', 'bridge', 'tmp'];
  const directories = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
  await Promise.all(Object.values(directories).map(async (directory) => {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chmod(directory, 0o700);
  }));
  return { root, ...directories };
}

export async function writePrivateFile(filePath, data, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await fs.open(filePath, exclusive ? 'wx' : 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, 0o600);
  return filePath;
}

async function allowedRuntimeSymlink(root, target) {
  const relative = path.relative(root, target);
  const allowedName = ['applypatch', 'apply_patch', 'codex-execve-wrapper'].includes(path.basename(target));
  if (!allowedName || !relative.startsWith(`home${path.sep}tmp${path.sep}arg0${path.sep}`)) return false;
  const link = await fs.readlink(target);
  if (!path.isAbsolute(link) || path.basename(link) !== 'codex') return false;
  const info = await fs.lstat(link);
  const uid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  return info.isFile() && !info.isSymbolicLink() && info.uid === uid && (info.mode & 0o022) === 0;
}

export async function tightenPrivateTree(root) {
  const info = await fs.lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('scratch root must be a real directory');
  await fs.chmod(root, 0o700);
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const current = await fs.lstat(target);
      if (current.isSymbolicLink()) {
        if (!(await allowedRuntimeSymlink(root, target))) {
          throw new Error(`scratch symlink is not allowed: ${entry.name}`);
        }
        continue;
      }
      if (current.isDirectory()) {
        await fs.chmod(target, 0o700);
        await visit(target);
      } else if (current.isFile()) {
        await fs.chmod(target, 0o600);
      } else {
        throw new Error(`unsupported scratch entry: ${entry.name}`);
      }
    }
  }
  await visit(root);
}

export async function assertPrivateTree(root) {
  const problems = [];
  const allowedSymlinks = [];
  async function visit(target, relative = '.') {
    const info = await fs.lstat(target);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      if (await allowedRuntimeSymlink(root, target)) allowedSymlinks.push(relative);
      else problems.push(`${relative}: symlink`);
    }
    else if (info.isDirectory()) {
      if (mode !== 0o700) problems.push(`${relative}: directory mode ${mode.toString(8)}`);
      for (const entry of await fs.readdir(target)) await visit(path.join(target, entry), path.join(relative, entry));
    } else if (info.isFile()) {
      if (mode !== 0o600) problems.push(`${relative}: file mode ${mode.toString(8)}`);
    } else {
      problems.push(`${relative}: unsupported type`);
    }
  }
  await visit(root);
  return { pass: problems.length === 0, problems, allowedSymlinks };
}
