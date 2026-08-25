import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLE_STATES,
  PERMISSION_PROFILES,
  TRANSPORT_METHODS,
  TRANSPORTS,
  transitionLifecycle,
  validateTransportAdapter,
  validateTransportRequest,
  validateTransportResult,
} from '../src/transport-contract.mjs';

const hash = 'a'.repeat(64);

function request(overrides = {}) {
  return {
    taskName: 'bounded-task',
    cwd: '/private/tmp/fixture',
    message: 'Inspect the bounded fixture.',
    providerId: 'deepseek',
    providerRole: 'coding_worker',
    model: 'deepseek-v4-flash',
    expectedScope: ['src/math.js'],
    acceptanceCriteria: ['Only src/math.js changes', 'Tests pass'],
    permissionProfile: PERMISSION_PROFILES.WORKSPACE_WRITE,
    timeoutMs: 180_000,
    explicitOnly: false,
    metadata: { requestId: 'fixture-request' },
    transportPreference: 'auto',
    ...overrides,
  };
}

function lifecycle(overrides = {}) {
  return {
    state: LIFECYCLE_STATES.CLOSED,
    outcome: 'completed',
    pid: 1234,
    startedAt: '2026-08-23T14:00:00.000Z',
    endedAt: '2026-08-23T14:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    exitSignal: null,
    timedOut: false,
    cancelled: false,
    forcedKill: false,
    orphanDetected: false,
    activeSlotReleased: true,
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    taskName: 'bounded-task',
    status: 'completed',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: TRANSPORTS.EXTERNAL_CODEX,
    changedFiles: ['src/math.js'],
    tests: [{ name: 'node --test', status: 'passed', exitCode: 0 }],
    findings: ['The empty-list case divided by zero.'],
    summary: 'Added the bounded empty-list guard.',
    risks: [],
    lifecycle: lifecycle(),
    evidenceRefs: [{ kind: 'runtime', ref: 'runtime:session-1', sha256: hash }],
    ...overrides,
  };
}

test('transport request normalizes bounded scope without changing the provider tuple', () => {
  const checked = validateTransportRequest(request({ expectedScope: ['test/math.test.js', 'src/math.js'] }));
  assert.deepEqual(checked.expectedScope, ['src/math.js', 'test/math.test.js']);
  assert.equal(checked.providerId, 'deepseek');
  assert.equal(checked.model, 'deepseek-v4-flash');
});

test('transport request rejects unsafe permissions, paths, credentials, and unknown fields', () => {
  assert.throws(() => validateTransportRequest(request({ cwd: 'relative' })), /absolute/u);
  assert.throws(() => validateTransportRequest(request({ permissionProfile: 'danger-full-access' })), /unsupported/u);
  assert.throws(() => validateTransportRequest(request({ expectedScope: ['../outside'] })), /invalid/u);
  assert.throws(() => validateTransportRequest(request({ metadata: { apiKey: 'never' } })), /credential/u);
  assert.throws(() => validateTransportRequest({ ...request(), extra: true }), /fields/u);
});

test('transport adapter contract remains small and function based', () => {
  const adapter = Object.fromEntries(TRANSPORT_METHODS.map((method) => [method, () => method]));
  assert.equal(validateTransportAdapter(adapter), adapter);
  assert.throws(() => validateTransportAdapter({ ...adapter, cleanup: null }), /cleanup/u);
});

test('lifecycle state machine accepts only explicit forward transitions', () => {
  assert.equal(transitionLifecycle('prepared', 'running'), 'running');
  assert.equal(transitionLifecycle('running', 'completed'), 'completed');
  assert.equal(transitionLifecycle('completed', 'cleanup_pending'), 'cleanup_pending');
  assert.equal(transitionLifecycle('cleanup_pending', 'closed'), 'closed');
  assert.throws(() => transitionLifecycle('running', 'closed'), /invalid lifecycle/u);
  assert.throws(() => transitionLifecycle('closed', 'running'), /invalid lifecycle/u);
});

test('transport result validates lifecycle, canonical scope, tests, and evidence references', () => {
  const checked = validateTransportResult(result({ changedFiles: ['test/z.js', 'src/math.js'] }));
  assert.deepEqual(checked.changedFiles, ['src/math.js', 'test/z.js']);
  assert.equal(checked.lifecycle.outcome, checked.status);
  assert.equal(checked.evidenceRefs[0].kind, 'runtime');
});

test('transport result fails closed on spoofable or inconsistent output', () => {
  assert.throws(() => validateTransportResult({ ...result(), unknown: true }), /fields/u);
  assert.throws(() => validateTransportResult(result({ changedFiles: ['/private/file'] })), /invalid/u);
  assert.throws(() => validateTransportResult(result({ lifecycle: lifecycle({ orphanDetected: true }) })), /inconsistent/u);
  assert.throws(() => validateTransportResult(result({ lifecycle: lifecycle({ activeSlotReleased: false }) })), /active slot/u);
  assert.throws(() => validateTransportResult(result({ evidenceRefs: [] })), /evidenceRefs/u);
  assert.throws(() => validateTransportResult(result({
    evidenceRefs: [{ kind: 'runtime', ref: '/private/session', sha256: hash }],
  })), /absolute/u);
});
