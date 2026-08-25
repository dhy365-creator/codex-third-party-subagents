import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTERNAL_FLASH_LIVE_REQUEST_LIMIT } from './external-flash-gate.mjs';
import { ensurePrivateDirectory, lstatIfExists, writePrivateFile } from './transports/external-fs-safety.mjs';

const FILE_NAME = 'deepseek-flash-live-request-ledger.json';
const OUTCOMES = new Set(['started', 'completed', 'failed']);

function ledgerPath(stateRoot) {
  return path.join(stateRoot, FILE_NAME);
}

function validateAttempt(attempt, index) {
  const fields = ['number', 'purpose', 'startedAt', 'completedAt', 'outcome', 'evidenceId'];
  if (!attempt || JSON.stringify(Object.keys(attempt).sort()) !== JSON.stringify(fields.sort())) {
    throw new Error('live-request attempt fields are invalid');
  }
  if (attempt.number !== index + 1 || typeof attempt.purpose !== 'string' || !attempt.purpose.trim()) {
    throw new Error('live-request attempt identity is invalid');
  }
  if (Number.isNaN(Date.parse(attempt.startedAt)) || !OUTCOMES.has(attempt.outcome)) {
    throw new Error('live-request attempt state is invalid');
  }
  if ((attempt.completedAt !== null && Number.isNaN(Date.parse(attempt.completedAt)))
    || (attempt.evidenceId !== null && !/^[a-f0-9]{16,64}$/u.test(attempt.evidenceId))) {
    throw new Error('live-request attempt completion evidence is invalid');
  }
  if ((attempt.outcome === 'started') !== (attempt.completedAt === null)) {
    throw new Error('live-request attempt completion state is inconsistent');
  }
  return attempt;
}

function validateLedger(ledger) {
  const fields = ['schemaVersion', 'providerId', 'model', 'limit', 'attempts'];
  if (!ledger || JSON.stringify(Object.keys(ledger).sort()) !== JSON.stringify(fields.sort())) {
    throw new Error('live-request ledger fields are invalid');
  }
  if (ledger.schemaVersion !== 1 || ledger.providerId !== 'deepseek'
    || ledger.model !== 'deepseek-v4-flash'
    || ledger.limit !== EXTERNAL_FLASH_LIVE_REQUEST_LIMIT
    || !Array.isArray(ledger.attempts)
    || ledger.attempts.length > ledger.limit) {
    throw new Error('live-request ledger identity is invalid');
  }
  ledger.attempts.forEach(validateAttempt);
  return ledger;
}

function emptyLedger() {
  return {
    schemaVersion: 1,
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    limit: EXTERNAL_FLASH_LIVE_REQUEST_LIMIT,
    attempts: [],
  };
}

export async function readExternalLiveRequestLedger(stateRoot) {
  if (!path.isAbsolute(stateRoot ?? '')) throw new Error('stateRoot must be absolute');
  const filePath = ledgerPath(stateRoot);
  const info = await lstatIfExists(filePath);
  if (!info) return Object.freeze(emptyLedger());
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 64 * 1024) {
    throw new Error('live-request ledger is unsafe');
  }
  const ledger = validateLedger(JSON.parse(await fs.readFile(filePath, 'utf8')));
  return Object.freeze({ ...ledger, attempts: Object.freeze(ledger.attempts.map((item) => Object.freeze({ ...item }))) });
}

async function writeLedger(stateRoot, ledger) {
  validateLedger(ledger);
  await ensurePrivateDirectory(stateRoot);
  await writePrivateFile(ledgerPath(stateRoot), `${JSON.stringify(ledger, null, 2)}\n`, { maxBytes: 64 * 1024 });
  return ledger;
}

export async function beginExternalLiveRequest(stateRoot, {
  purpose = 'canonical production-path Flash E2E',
  now = new Date(),
} = {}) {
  const current = await readExternalLiveRequestLedger(stateRoot);
  if (current.attempts.length >= EXTERNAL_FLASH_LIVE_REQUEST_LIMIT) {
    const error = new Error('DeepSeek Flash live-request ceiling reached');
    error.code = 'EXTERNAL_LIVE_REQUEST_LIMIT';
    throw error;
  }
  const attempt = {
    number: current.attempts.length + 1,
    purpose,
    startedAt: now.toISOString(),
    completedAt: null,
    outcome: 'started',
    evidenceId: null,
  };
  await writeLedger(stateRoot, { ...current, attempts: [...current.attempts, attempt] });
  return Object.freeze({ ...attempt });
}

export async function finishExternalLiveRequest(stateRoot, number, {
  outcome,
  evidenceId = null,
  now = new Date(),
} = {}) {
  if (!['completed', 'failed'].includes(outcome)) throw new Error('live-request outcome is invalid');
  const current = await readExternalLiveRequestLedger(stateRoot);
  const attempt = current.attempts[number - 1];
  if (!attempt || attempt.outcome !== 'started') throw new Error('live-request attempt cannot be finalized');
  const updated = {
    ...attempt,
    completedAt: now.toISOString(),
    outcome,
    evidenceId,
  };
  const attempts = current.attempts.map((item, index) => index === number - 1 ? updated : item);
  await writeLedger(stateRoot, { ...current, attempts });
  return Object.freeze({ ...updated });
}
