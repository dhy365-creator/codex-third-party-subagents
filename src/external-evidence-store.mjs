import fs from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE_SOURCES, validateTransportEvidence } from './transport-evidence.mjs';
import { ensurePrivateDirectory, lstatIfExists, writePrivateFile } from './transports/external-fs-safety.mjs';

const EVIDENCE_DIRECTORY = 'verified-evidence';
const FLASH_EVIDENCE_FILE = 'deepseek-v4-flash.latest.json';

export function externalFlashEvidencePath(stateRoot) {
  if (!path.isAbsolute(stateRoot ?? '')) throw new Error('stateRoot must be absolute');
  return path.join(stateRoot, EVIDENCE_DIRECTORY, FLASH_EVIDENCE_FILE);
}

function requireFlashEvidence(value) {
  const evidence = validateTransportEvidence(value);
  if (evidence.evidenceSource !== EVIDENCE_SOURCES.LOCAL_INSTALLATION
    || evidence.transport !== 'external-codex'
    || evidence.providerId !== 'deepseek'
    || evidence.model !== 'deepseek-v4-flash'
    || evidence.runtimeVerified !== true) {
    throw new Error('stored evidence is not strict local External Flash runtime evidence');
  }
  return evidence;
}

export async function readExternalFlashEvidence(stateRoot) {
  const filePath = externalFlashEvidencePath(stateRoot);
  const info = await lstatIfExists(filePath);
  if (!info) return null;
  const owner = typeof process.getuid !== 'function' || info.uid === process.getuid();
  if (info.isSymbolicLink() || !info.isFile() || !owner
    || (info.mode & 0o777) !== 0o600 || info.size > 128 * 1024) {
    throw new Error('stored External Flash evidence is unsafe');
  }
  return requireFlashEvidence(JSON.parse(await fs.readFile(filePath, 'utf8')));
}

export async function writeExternalFlashEvidence(stateRoot, value) {
  const evidence = requireFlashEvidence(value);
  const filePath = externalFlashEvidencePath(stateRoot);
  await ensurePrivateDirectory(path.dirname(filePath));
  await writePrivateFile(filePath, `${JSON.stringify(evidence, null, 2)}\n`, { maxBytes: 128 * 1024 });
  return filePath;
}
