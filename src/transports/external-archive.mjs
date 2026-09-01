import fs from 'node:fs/promises';
import path from 'node:path';
import { containsSensitiveText, redactPortableData } from './external-evidence.mjs';
import {
  EXTERNAL_FILE_MODE,
  ensurePrivateDirectory,
  isPathInside,
  sha256,
  writePrivateFile,
} from './external-fs-safety.mjs';
import { privatePathReady } from '../platform-security.mjs';

const SLOT_FIELDS = Object.freeze(['schemaVersion', 'executionId', 'taskName', 'createdAt']);

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields do not match the contract`);
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function privateFileReady(target, fsOptions = {}) {
  const impl = fsOptions.securityImpl?.privatePathReady ?? privatePathReady;
  return impl(target, {
    kind: 'file', mode: EXTERNAL_FILE_MODE,
    platform: fsOptions.platform ?? process.platform,
    ...(fsOptions.securityOptions ?? {}),
  });
}

export async function acquireExternalSlot({
  stateRoot, executionId, taskName, now = new Date(), fsOptions = {},
} = {}) {
  await ensurePrivateDirectory(stateRoot, { ...fsOptions, approvedRoot: stateRoot });
  const slotPath = path.join(stateRoot, 'active.json');
  const slot = {
    schemaVersion: 1,
    executionId,
    taskName,
    createdAt: now.toISOString(),
  };
  try {
    await writePrivateFile(slotPath, `${JSON.stringify(slot, null, 2)}\n`, {
      ...fsOptions, approvedRoot: stateRoot, exclusive: true,
    });
  } catch (error) {
    try {
      const current = await fs.lstat(slotPath);
      if (current.isFile() && !current.isSymbolicLink()) {
        throw codedError('EXTERNAL_CHILD_BUSY', 'EXTERNAL_CHILD_BUSY');
      }
    } catch (inspectionError) {
      if (inspectionError?.code === 'EXTERNAL_CHILD_BUSY') throw inspectionError;
      if (inspectionError?.code !== 'ENOENT') throw codedError('EXTERNAL_SLOT_UNSAFE', 'external slot is unsafe');
    }
    throw error;
  }
  return Object.freeze({ slotPath, ...slot });
}

export async function assertExternalSlot(slot, { fsOptions = {} } = {}) {
  const info = await fs.lstat(slot.slotPath);
  if (info.isSymbolicLink() || !info.isFile() || !(await privateFileReady(slot.slotPath, fsOptions))) {
    throw codedError('EXTERNAL_SLOT_UNSAFE', 'external slot type or mode is unsafe');
  }
  const current = JSON.parse(await fs.readFile(slot.slotPath, 'utf8'));
  exactFields(current, SLOT_FIELDS, 'external slot');
  if (current.schemaVersion !== 1 || current.executionId !== slot.executionId
    || current.taskName !== slot.taskName) {
    throw codedError('EXTERNAL_SLOT_MISMATCH', 'external slot ownership changed');
  }
  return current;
}

export async function evidenceReference({ kind, filePath, executionRoot, prefix = 'evidence' } = {}) {
  if (!['runtime', 'workspace', 'result', 'lifecycle'].includes(kind)) {
    throw new Error('evidence reference kind is invalid');
  }
  if (!isPathInside(executionRoot, filePath)) throw new Error('evidence path escapes execution root');
  const data = await fs.readFile(filePath);
  return Object.freeze({
    kind,
    ref: `${prefix}:${path.basename(filePath)}`,
    sha256: sha256(data),
  });
}

export async function finalizeExternalArchive({
  archiveDir,
  executionId,
  request,
  status,
  lifecycle,
  collection,
  evidenceRefs,
  now = new Date(),
  fsOptions = {},
} = {}) {
  if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(status)) {
    throw new Error('archive status is invalid');
  }
  await ensurePrivateDirectory(archiveDir, { ...fsOptions, approvedRoot: archiveDir });
  const archivePath = path.join(archiveDir, `${status}-${executionId}.json`);
  const payload = redactPortableData({
    schemaVersion: 1,
    executionId,
    taskName: request.taskName,
    status,
    providerId: request.providerId,
    model: request.model,
    transport: 'external-codex',
    request: { cwd: request.cwd, message: request.message },
    changedFiles: collection.changedFiles,
    tests: collection.childResult?.tests ?? [],
    findings: collection.childResult?.findings ?? collection.issues,
    summary: collection.childResult?.summary ?? `External Codex child ${status}.`,
    risks: collection.childResult?.risks ?? collection.issues,
    lifecycle,
    evidenceRefs,
    finalizedAt: now.toISOString(),
  }, { cwd: request.cwd, message: request.message });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (containsSensitiveText(serialized)) throw new Error('portable archive still contains sensitive data');
  await writePrivateFile(archivePath, serialized, {
    ...fsOptions, approvedRoot: archiveDir, exclusive: true, maxBytes: 128 * 1024,
  });
  return Object.freeze({
    archivePath,
    archiveRef: Object.freeze({
      kind: 'lifecycle',
      ref: `archive:${path.basename(archivePath)}`,
      sha256: sha256(await fs.readFile(archivePath)),
    }),
  });
}

export async function releaseExternalSlot(slot, archivePath, { fsOptions = {} } = {}) {
  await assertExternalSlot(slot, { fsOptions });
  const archive = await fs.lstat(archivePath);
  if (archive.isSymbolicLink() || !archive.isFile() || !(await privateFileReady(archivePath, fsOptions))) {
    throw new Error('archive must be finalized before slot release');
  }
  await fs.unlink(slot.slotPath);
  return true;
}
