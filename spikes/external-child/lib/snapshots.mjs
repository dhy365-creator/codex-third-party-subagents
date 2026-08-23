import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fileDigest(filePath) {
  return digest(await fs.readFile(filePath));
}

export async function snapshotTree(root) {
  const files = {};
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink()) files[relative] = 'SYMLINK';
      else if (info.isDirectory()) await visit(target);
      else if (info.isFile()) files[relative] = await fileDigest(target);
      else files[relative] = 'OTHER';
    }
  }
  await visit(root);
  return files;
}

export function compareSnapshots(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return {
    added: names.filter((name) => before[name] === undefined),
    deleted: names.filter((name) => after[name] === undefined),
    changed: names.filter((name) => before[name] !== undefined
      && after[name] !== undefined
      && before[name] !== after[name]),
  };
}

async function snapshotTarget(target) {
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) return { exists: true, type: 'symlink', digest: null, count: 1 };
    if (info.isFile()) return { exists: true, type: 'file', digest: await fileDigest(target), count: 1 };
    if (!info.isDirectory()) return { exists: true, type: 'other', digest: null, count: 1 };
    const files = await snapshotTree(target);
    return { exists: true, type: 'directory', digest: digest(JSON.stringify(files)), count: Object.keys(files).length };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, type: null, digest: null, count: 0 };
    throw error;
  }
}

export async function snapshotParentConfiguration(homeDir = os.homedir()) {
  const codexDir = path.join(path.resolve(homeDir), '.codex');
  const [configToml, agentsMd, agents] = await Promise.all([
    snapshotTarget(path.join(codexDir, 'config.toml')),
    snapshotTarget(path.join(codexDir, 'AGENTS.md')),
    snapshotTarget(path.join(codexDir, 'agents')),
  ]);
  return { configToml, agentsMd, agents };
}

export function parentConfigurationUnchanged(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}
