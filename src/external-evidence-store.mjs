import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { EVIDENCE_SOURCES, validateTransportEvidence } from './transport-evidence.mjs';
import { ensurePrivateDirectory, lstatIfExists, writePrivateFile } from './transports/external-fs-safety.mjs';

const EVIDENCE_DIRECTORY = 'verified-evidence';
const FLASH_EVIDENCE_FILE = 'deepseek-v4-flash.latest.json';
const INSTALLATION_ID_FILE = '.installation-id';
const ENVELOPE_FIELDS = ['schemaVersion', 'binding', 'evidence'];
const BINDING_FIELDS = ['installationId', 'runtimeRootBinding'];

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} fields are invalid`);
  }
}

async function installationIdentity(stateRoot, { create = false } = {}) {
  const directory = path.join(stateRoot, EVIDENCE_DIRECTORY);
  const filePath = path.join(directory, INSTALLATION_ID_FILE);
  if (create) await ensurePrivateDirectory(directory);
  let info = await lstatIfExists(filePath);
  if (!info && create) {
    await writePrivateFile(filePath, `${crypto.randomBytes(32).toString('hex')}\n`, { exclusive: true });
    info = await lstatIfExists(filePath);
  }
  const owner = typeof process.getuid !== 'function' || info?.uid === process.getuid();
  if (!info || !owner || info.isSymbolicLink() || !info.isFile()
    || (info.mode & 0o777) !== 0o600 || info.size > 128) {
    throw new Error('External installation identity is missing or unsafe');
  }
  const installationId = (await fs.readFile(filePath, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/u.test(installationId)) throw new Error('External installation identity is invalid');
  const realRoot = await fs.realpath(stateRoot);
  return Object.freeze({
    installationId,
    runtimeRootBinding: crypto.createHash('sha256').update(`${realRoot}\0${installationId}`).digest('hex'),
  });
}

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
  const envelope = JSON.parse(await fs.readFile(filePath, 'utf8'));
  exactFields(envelope, ENVELOPE_FIELDS, 'stored External Flash evidence envelope');
  exactFields(envelope.binding, BINDING_FIELDS, 'stored External Flash evidence binding');
  if (envelope.schemaVersion !== 2) throw new Error('stored External Flash evidence envelope is unsupported');
  const expected = await installationIdentity(stateRoot);
  if (envelope.binding.installationId !== expected.installationId
    || envelope.binding.runtimeRootBinding !== expected.runtimeRootBinding) {
    throw new Error('stored External Flash evidence belongs to another runtime root');
  }
  return requireFlashEvidence(envelope.evidence);
}

export async function writeExternalFlashEvidence(stateRoot, value) {
  const evidence = requireFlashEvidence(value);
  const filePath = externalFlashEvidencePath(stateRoot);
  const binding = await installationIdentity(stateRoot, { create: true });
  const envelope = { schemaVersion: 2, binding, evidence };
  await writePrivateFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, { maxBytes: 128 * 1024 });
  return filePath;
}
