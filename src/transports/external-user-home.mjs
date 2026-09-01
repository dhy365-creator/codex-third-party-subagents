import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

export async function validateExternalUserHome(userHome, {
  expectedUid = currentUid(),
  platform = process.platform,
} = {}) {
  const normalizedInput = platform === 'win32'
    ? path.resolve(userHome ?? '').toLowerCase() === String(userHome ?? '').toLowerCase()
    : path.resolve(userHome ?? '') === userHome;
  if (!path.isAbsolute(userHome ?? '') || !normalizedInput) {
    throw new Error('real user HOME must be a normalized absolute path');
  }
  const normalize = (value) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const unsafe = new Set([path.parse(userHome).root, os.tmpdir(), '/tmp', '/private/tmp'].map(normalize));
  if (unsafe.has(normalize(userHome))) throw new Error('real user HOME is an unsafe root');
  const info = await fs.lstat(userHome);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('real user HOME must be a real directory');
  }
  if (platform !== 'win32' && expectedUid !== null && info.uid !== expectedUid) {
    throw new Error('real user HOME ownership is invalid');
  }
  const canonical = await fs.realpath(userHome);
  const exact = platform === 'win32'
    ? canonical.toLowerCase() === userHome.toLowerCase()
    : canonical === userHome;
  if (!exact) {
    throw new Error('real user HOME must not traverse symlinks');
  }
  return userHome;
}

export async function resolveExternalUserHome({
  userInfoImpl = os.userInfo,
  platform = process.platform,
} = {}) {
  const user = userInfoImpl();
  const uid = currentUid();
  if (!user || typeof user.username !== 'string' || !user.username
    || (platform !== 'win32' && (!Number.isInteger(user.uid) || (uid !== null && user.uid !== uid)))) {
    throw new Error('current user identity is invalid');
  }
  return validateExternalUserHome(user.homedir, {
    expectedUid: platform === 'win32' ? null : user.uid,
    platform,
  });
}
