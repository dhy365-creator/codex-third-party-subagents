import path from 'node:path';

export const TRANSPORTS = Object.freeze({
  NATIVE: 'native',
  EXTERNAL_CODEX: 'external-codex',
});

export const TRANSPORT_PREFERENCES = Object.freeze({
  AUTO: 'auto',
  ...TRANSPORTS,
});

export const PERMISSION_PROFILES = Object.freeze({
  READ_ONLY: 'read-only',
  WORKSPACE_WRITE: 'workspace-write',
});

export const TRANSPORT_METHODS = Object.freeze([
  'prepare',
  'execute',
  'cancel',
  'collect',
  'cleanup',
  'describe',
]);

export const LIFECYCLE_STATES = Object.freeze({
  PREPARED: 'prepared',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  CLEANUP_PENDING: 'cleanup_pending',
  CLOSED: 'closed',
});

const OUTCOMES = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
const TRANSITIONS = Object.freeze({
  prepared: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['completed', 'failed', 'timed_out', 'cancelled']),
  completed: new Set(['cleanup_pending']),
  failed: new Set(['cleanup_pending']),
  timed_out: new Set(['cleanup_pending']),
  cancelled: new Set(['cleanup_pending']),
  cleanup_pending: new Set(['closed']),
  closed: new Set(),
});

const REQUEST_FIELDS = [
  'taskName', 'cwd', 'message', 'providerId', 'providerRole', 'model',
  'expectedScope', 'acceptanceCriteria', 'permissionProfile', 'timeoutMs',
  'explicitOnly', 'metadata', 'transportPreference',
];
const RESULT_FIELDS = [
  'taskName', 'status', 'providerId', 'model', 'transport', 'changedFiles',
  'tests', 'findings', 'summary', 'risks', 'lifecycle', 'evidenceRefs',
];
const LIFECYCLE_FIELDS = [
  'state', 'outcome', 'pid', 'startedAt', 'endedAt', 'durationMs', 'exitCode',
  'exitSignal', 'timedOut', 'cancelled', 'forcedKill', 'orphanDetected',
  'activeSlotReleased',
];

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields do not match the contract`);
  }
}

function boundedString(value, label, maxLength = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function safeRelativeFile(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const portable = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(portable) || /^[A-Za-z]:\//u.test(portable)) return false;
  const normalized = path.posix.normalize(portable);
  return normalized === portable && normalized !== '..' && !normalized.startsWith('../');
}

function stringArray(value, label, { relative = false, maxItems = 64 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must be a bounded array`);
  if (value.some((item) => typeof item !== 'string' || (relative && !safeRelativeFile(item)))) {
    throw new Error(`${label} contains an invalid value`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return value;
}

function plainMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('metadata must be plain data');
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('metadata must be JSON serializable');
  }
  if (Buffer.byteLength(serialized ?? '') > 16 * 1024) throw new Error('metadata is too large');
  if (/"(?:api[_-]?key|token|secret|password|authorization)"\s*:/iu.test(serialized)) {
    throw new Error('metadata contains a credential-like field');
  }
  return value;
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return value;
}

export function validateTransportAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('transport adapter is required');
  for (const method of TRANSPORT_METHODS) {
    if (typeof adapter[method] !== 'function') throw new Error(`transport adapter is missing ${method}()`);
  }
  return adapter;
}

export function validateTransportRequest(request) {
  exactFields(request, REQUEST_FIELDS, 'transport request');
  boundedString(request.taskName, 'taskName', 96);
  if (!/^[A-Za-z0-9._-]+$/u.test(request.taskName)) throw new Error('taskName is invalid');
  if (!path.isAbsolute(request.cwd)) throw new Error('cwd must be absolute');
  boundedString(request.message, 'message');
  for (const field of ['providerId', 'providerRole', 'model']) boundedString(request[field], field, 128);
  stringArray(request.expectedScope, 'expectedScope', { relative: true });
  const acceptanceCriteria = stringArray(request.acceptanceCriteria, 'acceptanceCriteria', { maxItems: 32 });
  if (!acceptanceCriteria.length || acceptanceCriteria.some((item) => !item.trim())) {
    throw new Error('acceptanceCriteria must not be empty');
  }
  if (!Object.values(PERMISSION_PROFILES).includes(request.permissionProfile)) {
    throw new Error('permissionProfile is unsupported');
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 10_000 || request.timeoutMs > 300_000) {
    throw new Error('timeoutMs is outside the bounded range');
  }
  if (typeof request.explicitOnly !== 'boolean') throw new Error('explicitOnly must be boolean');
  if (!Object.values(TRANSPORT_PREFERENCES).includes(request.transportPreference)) {
    throw new Error('transportPreference is unsupported');
  }
  plainMetadata(request.metadata);
  return Object.freeze({
    ...request,
    expectedScope: Object.freeze([...request.expectedScope].sort()),
    acceptanceCriteria: Object.freeze([...request.acceptanceCriteria]),
    metadata: Object.freeze({ ...request.metadata }),
  });
}

export function transitionLifecycle(current, next) {
  if (!TRANSITIONS[current]?.has(next)) throw new Error(`invalid lifecycle transition: ${current} -> ${next}`);
  return next;
}

export function validateLifecycleRecord(lifecycle) {
  exactFields(lifecycle, LIFECYCLE_FIELDS, 'lifecycle');
  if (lifecycle.state !== LIFECYCLE_STATES.CLOSED) throw new Error('lifecycle must be closed before collection');
  if (!OUTCOMES.has(lifecycle.outcome)) throw new Error('lifecycle outcome is invalid');
  if (!Number.isInteger(lifecycle.pid) || lifecycle.pid <= 0) throw new Error('lifecycle pid is invalid');
  const startedAt = isoTimestamp(lifecycle.startedAt, 'startedAt');
  const endedAt = isoTimestamp(lifecycle.endedAt, 'endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new Error('lifecycle timestamps are reversed');
  if (!Number.isInteger(lifecycle.durationMs) || lifecycle.durationMs < 0) throw new Error('durationMs is invalid');
  if (lifecycle.exitCode !== null && !Number.isInteger(lifecycle.exitCode)) throw new Error('exitCode is invalid');
  if (lifecycle.exitSignal !== null && typeof lifecycle.exitSignal !== 'string') throw new Error('exitSignal is invalid');
  for (const field of ['timedOut', 'cancelled', 'forcedKill', 'orphanDetected', 'activeSlotReleased']) {
    if (typeof lifecycle[field] !== 'boolean') throw new Error(`${field} must be boolean`);
  }
  if (lifecycle.timedOut && lifecycle.cancelled) throw new Error('lifecycle cannot be timed out and cancelled');
  if (lifecycle.outcome === 'completed'
    && (lifecycle.exitCode !== 0 || lifecycle.timedOut || lifecycle.cancelled || lifecycle.orphanDetected)) {
    throw new Error('completed lifecycle is inconsistent');
  }
  if (lifecycle.outcome === 'timed_out' && !lifecycle.timedOut) throw new Error('timed_out outcome is inconsistent');
  if (lifecycle.outcome === 'cancelled' && !lifecycle.cancelled) throw new Error('cancelled outcome is inconsistent');
  if (!lifecycle.activeSlotReleased) throw new Error('closed lifecycle must release its active slot');
  return lifecycle;
}

export function validateEvidenceRef(reference) {
  exactFields(reference, ['kind', 'ref', 'sha256'], 'evidence reference');
  if (!['runtime', 'workspace', 'result', 'lifecycle'].includes(reference.kind)) {
    throw new Error('evidence reference kind is invalid');
  }
  boundedString(reference.ref, 'evidence ref', 256);
  if (path.isAbsolute(reference.ref) || reference.ref.includes('..')) {
    throw new Error('evidence ref must not expose an absolute or parent path');
  }
  if (!/^[a-f0-9]{64}$/u.test(reference.sha256)) throw new Error('evidence reference hash is invalid');
  return reference;
}

export function validateTransportResult(result) {
  exactFields(result, RESULT_FIELDS, 'transport result');
  boundedString(result.taskName, 'taskName', 96);
  if (!OUTCOMES.has(result.status)) throw new Error('result status is invalid');
  for (const field of ['providerId', 'model']) boundedString(result[field], field, 128);
  if (!Object.values(TRANSPORTS).includes(result.transport)) throw new Error('result transport is invalid');
  const changedFiles = stringArray(result.changedFiles, 'changedFiles', { relative: true });
  if (!Array.isArray(result.tests) || result.tests.length > 64) throw new Error('tests must be a bounded array');
  for (const test of result.tests) {
    exactFields(test, ['name', 'status', 'exitCode'], 'test result');
    boundedString(test.name, 'test name', 256);
    if (!['passed', 'failed', 'not-run'].includes(test.status)) throw new Error('test status is invalid');
    if (test.exitCode !== null && !Number.isInteger(test.exitCode)) throw new Error('test exitCode is invalid');
  }
  stringArray(result.findings, 'findings');
  stringArray(result.risks, 'risks');
  boundedString(result.summary, 'summary', 8192);
  const lifecycle = validateLifecycleRecord(result.lifecycle);
  if (lifecycle.outcome !== result.status) throw new Error('result and lifecycle outcomes differ');
  if (!Array.isArray(result.evidenceRefs) || !result.evidenceRefs.length || result.evidenceRefs.length > 32) {
    throw new Error('evidenceRefs must be a bounded array');
  }
  result.evidenceRefs.forEach(validateEvidenceRef);
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new Error('transport result is too large');
  return Object.freeze({
    ...result,
    changedFiles: Object.freeze([...changedFiles].sort()),
    tests: Object.freeze(result.tests.map((test) => Object.freeze({ ...test }))),
    findings: Object.freeze([...result.findings]),
    risks: Object.freeze([...result.risks]),
    evidenceRefs: Object.freeze(result.evidenceRefs.map((reference) => Object.freeze({ ...reference }))),
  });
}
