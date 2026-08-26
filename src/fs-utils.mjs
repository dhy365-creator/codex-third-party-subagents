import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  privatePathReady,
  secureManagedPath,
} from './platform-security.mjs';

export const INSTALL_VERSION = '0.4.0-beta.3';

export async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function lstatIfExists(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

export async function ensureDir(dirPath, mode = 0o700, { enforceMode = true } = {}) {
  const created = await fs.mkdir(dirPath, { recursive: true, mode });
  // New managed directories need an explicit mode because mkdir honors umask.
  // Existing parent directories retain their user-selected mode unless a caller
  // explicitly owns that directory's permission boundary.
  if (enforceMode || created) {
    await secureManagedPath(dirPath, { kind: 'directory', mode });
  }
}

export async function writeFileIfChanged(filePath, contents, { mode = 0o600 } = {}) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const existing = await lstatIfExists(filePath);
  if (existing) {
    if (!existing.isFile()) throw new Error(`managed path is not a regular file: ${filePath}`);
    const current = await fs.readFile(filePath);
    const secure = await privatePathReady(filePath, { kind: 'file', mode });
    if (Buffer.compare(current, data) === 0 && secure) {
      return { changed: false, hash: sha256(data), mode };
    }
  }
  await ensureDir(path.dirname(filePath), 0o700, { enforceMode: false });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.open(tempPath, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await secureManagedPath(tempPath, { kind: 'file', mode });
  await fs.rename(tempPath, filePath);
  return { changed: true, hash: sha256(data), mode };
}

export async function copyOwnerOnly(sourcePath, destinationPath) {
  const data = await fs.readFile(sourcePath);
  await ensureDir(path.dirname(destinationPath), 0o700, { enforceMode: false });
  const tempPath = `${destinationPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await secureManagedPath(tempPath, { kind: 'file', mode: 0o600 });
  await fs.rename(tempPath, destinationPath);
  return sha256(data);
}

export async function removeFileIfExists(filePath) {
  const info = await lstatIfExists(filePath);
  if (!info) return false;
  if (info.isSymbolicLink()) throw new Error(`refusing to remove symlink: ${filePath}`);
  if (!info.isFile()) throw new Error(`refusing to remove non-file: ${filePath}`);
  await fs.unlink(filePath);
  return true;
}

export async function assertOwnerOnly(filePath, expectedMode, expectedUid = process.getuid?.()) {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink()) throw new Error(`symlink not allowed: ${filePath}`);
  const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
  if (!kind || !await privatePathReady(filePath, {
    kind, mode: expectedMode, uid: expectedUid,
  })) throw new Error(`owner-only security is not established for ${filePath}`);
  return info;
}

export function normalizeBasename(value) {
  const finalComponent = path.basename(String(value ?? 'task').trim());
  const normalized = finalComponent
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || 'task';
}

export function redactTask(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    message: '[REDACTED]',
    cwd: '[REDACTED]',
  };
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export { fs, fsConstants };
