import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

export async function validateExternalUserHome(userHome, { expectedUid = currentUid() } = {}) {
  if (!path.isAbsolute(userHome ?? '') || path.resolve(userHome) !== userHome) {
    throw new Error('real user HOME must be a normalized absolute path');
  }
  const unsafe = new Set(['/', os.tmpdir(), '/tmp', '/private/tmp'].map((value) => path.resolve(value)));
  if (unsafe.has(userHome)) throw new Error('real user HOME is an unsafe root');
  const info = await fs.lstat(userHome);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('real user HOME must be a real directory');
  }
  if (expectedUid !== null && info.uid !== expectedUid) {
    throw new Error('real user HOME ownership is invalid');
  }
  if (await fs.realpath(userHome) !== userHome) {
    throw new Error('real user HOME must not traverse symlinks');
  }
  return userHome;
}

export async function resolveExternalUserHome({ userInfoImpl = os.userInfo } = {}) {
  const user = userInfoImpl();
  const uid = currentUid();
  if (!user || typeof user.username !== 'string' || !user.username
    || !Number.isInteger(user.uid) || (uid !== null && user.uid !== uid)) {
    throw new Error('current macOS user identity is invalid');
  }
  return validateExternalUserHome(user.homedir, { expectedUid: user.uid });
}
