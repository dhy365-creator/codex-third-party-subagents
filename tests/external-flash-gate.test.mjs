import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_FLASH_FEATURE_GATE,
  EXTERNAL_FLASH_LIVE_REQUEST_LIMIT,
  consumeExternalFlashExecutionPermit,
  createExternalFlashExecutionPermit,
  evaluateExternalFlashProductionGate,
  externalFlashResultAccepted,
  validateExternalFlashExecutionPermit,
} from '../src/external-flash-gate.mjs';

function input(overrides = {}) {
  return {
    taskName: 'phase3-flash-e2e-fixture',
    requestedTransport: 'external-codex',
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    permissionProfile: 'read-only',
    featureGate: EXTERNAL_FLASH_FEATURE_GATE,
    runtimeRouteEnabled: true,
    billableAuthorized: true,
    providerExplicitlyRequested: true,
    providerSuitable: true,
    providerReady: true,
    credentialReady: true,
    codexVersion: '0.149.0',
    runtimeRootReady: true,
    evidenceDestinationReady: true,
    busy: false,
    liveRequestCount: 0,
    liveRequestLimit: EXTERNAL_FLASH_LIVE_REQUEST_LIMIT,
    authorizationId: 'phase3-fixture-authorization',
    challenge: 'challenge-1234abcd-5678ef90',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    taskName: 'phase3-flash-e2e-fixture',
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    permissionProfile: 'read-only',
    transportPreference: 'external-codex',
    ...overrides,
  };
}

test('controlled Flash gate allows only the exact explicitly authorized tuple', () => {
  const allowed = evaluateExternalFlashProductionGate(input());
  assert.equal(allowed.decision, 'ALLOW');
  assert.equal(allowed.selectedTransport, 'external-codex');
  for (const blocked of [
    input({ billableAuthorized: false }),
    input({ featureGate: 'disabled' }),
    input({ model: 'deepseek-v4-pro', providerRole: 'deepseek_pro_worker' }),
    input({ providerId: 'minimax', model: 'MiniMax-M3', providerRole: 'minimax_worker' }),
    input({ permissionProfile: 'workspace-write' }),
    input({ codexVersion: '0.150.0' }),
    input({ liveRequestCount: 3 }),
  ]) {
    assert.equal(evaluateExternalFlashProductionGate(blocked).decision, 'BLOCK');
  }
  assert.equal(evaluateExternalFlashProductionGate(input({ busy: true })).decision, 'BUSY');
});

test('production permit is exact, one-time, and validates the canonical challenge result', () => {
  const permit = createExternalFlashExecutionPermit(input());
  assert.equal(validateExternalFlashExecutionPermit(permit, request()).providerId, 'deepseek');
  assert.equal(consumeExternalFlashExecutionPermit(permit, request()).model, 'deepseek-v4-flash');
  assert.throws(() => consumeExternalFlashExecutionPermit(permit, request()), /already consumed/u);
  assert.equal(externalFlashResultAccepted(permit, request(), {
    status: 'completed',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: 'external-codex',
    changedFiles: [],
    summary: 'CHALLENGE challenge-1234abcd-5678ef90',
  }), true);
  assert.equal(externalFlashResultAccepted(permit, request(), {
    status: 'completed',
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    transport: 'external-codex',
    changedFiles: [],
    summary: 'self-reported success',
  }), false);
});

test('permit cannot be applied to a substituted task or provider/model tuple', () => {
  const permit = createExternalFlashExecutionPermit(input());
  assert.throws(() => validateExternalFlashExecutionPermit(permit, request({ taskName: 'other' })), /taskName/u);
  assert.throws(() => validateExternalFlashExecutionPermit(permit, request({ providerId: 'openai' })), /providerId/u);
  assert.throws(() => validateExternalFlashExecutionPermit(permit, request({ model: 'deepseek-v4-pro' })), /model/u);
  assert.throws(() => validateExternalFlashExecutionPermit(permit, request({ transportPreference: 'native' })), /External Transport/u);
});
