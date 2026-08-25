import test from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_PROFILES, TRANSPORTS } from '../src/transport-contract.mjs';
import {
  PROVIDER_POLICIES,
  SELECTION_DECISIONS,
  selectTransport,
} from '../src/transport-selection.mjs';

function eligibility(overrides = {}) {
  return {
    eligible: false,
    runtimeVerified: false,
    busy: false,
    compatibilityLevel: 'UNKNOWN',
    reason: 'transport has no applicable runtime evidence',
    permissionProfiles: [PERMISSION_PROFILES.READ_ONLY, PERMISSION_PROFILES.WORKSPACE_WRITE],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    requestedTransport: 'auto',
    providerPolicy: PROVIDER_POLICIES.ALLOW,
    providerExplicitlyRequested: true,
    roleExplicitOnly: false,
    providerId: 'deepseek',
    providerRole: 'coding_worker',
    model: 'deepseek-v4-flash',
    permissionProfile: PERMISSION_PROFILES.WORKSPACE_WRITE,
    native: eligibility({
      compatibilityLevel: 'LEVEL_C_HOST_BLOCKED',
      reason: 'Codex 0.149.x cannot override the parent provider in a native child',
    }),
    external: eligibility({
      eligible: true,
      runtimeVerified: true,
      compatibilityLevel: 'MAINTAINER_RUNTIME_VERIFIED',
      reason: 'bounded external Codex transport evidence passed',
    }),
    ...overrides,
  };
}

test('auto selects external when native is blocked and external is runtime verified', () => {
  const selected = selectTransport(input());
  assert.equal(selected.decision, SELECTION_DECISIONS.ALLOW);
  assert.equal(selected.selectedTransport, TRANSPORTS.EXTERNAL_CODEX);
  assert.equal(selected.providerId, 'deepseek');
  assert.equal(selected.model, 'deepseek-v4-flash');
});

test('an explicit blocked native request never silently falls back to external', () => {
  const selected = selectTransport(input({ requestedTransport: TRANSPORTS.NATIVE }));
  assert.equal(selected.decision, SELECTION_DECISIONS.BLOCK);
  assert.equal(selected.selectedTransport, null);
  assert.match(selected.reason, /0\.149/u);
});

test('auto prefers an eligible runtime-verified native transport', () => {
  const selected = selectTransport(input({
    native: eligibility({
      eligible: true,
      runtimeVerified: true,
      compatibilityLevel: 'LEVEL_A_RUNTIME_VERIFIED',
      reason: 'exact Host contract is runtime verified',
    }),
  }));
  assert.equal(selected.selectedTransport, TRANSPORTS.NATIVE);
});

test('selection blocks when neither transport has applicable runtime evidence', () => {
  const selected = selectTransport(input({ external: eligibility() }));
  assert.equal(selected.decision, SELECTION_DECISIONS.BLOCK);
  assert.equal(selected.selectedTransport, null);
  assert.match(selected.reason, /no runtime-verified transport/u);
});

test('external single-slot concurrency returns an explicit busy decision', () => {
  const selected = selectTransport(input({
    external: eligibility({
      eligible: true,
      runtimeVerified: true,
      busy: true,
      compatibilityLevel: 'MAINTAINER_RUNTIME_VERIFIED',
      reason: 'external transport is verified',
    }),
  }));
  assert.equal(selected.decision, SELECTION_DECISIONS.BUSY);
  assert.equal(selected.reason, 'EXTERNAL CHILD BUSY');
});

test('explicit-only provider role policy is independent of transport', () => {
  for (const requestedTransport of [TRANSPORTS.NATIVE, TRANSPORTS.EXTERNAL_CODEX]) {
    const selected = selectTransport(input({
      requestedTransport,
      roleExplicitOnly: true,
      providerExplicitlyRequested: false,
    }));
    assert.equal(selected.decision, SELECTION_DECISIONS.REQUIRE_EXPLICIT);
    assert.equal(selected.selectedTransport, null);
  }
});

test('provider policy is evaluated before transport availability', () => {
  const denied = selectTransport(input({ providerPolicy: PROVIDER_POLICIES.DENY }));
  assert.equal(denied.decision, SELECTION_DECISIONS.BLOCK);
  const explicit = selectTransport(input({
    providerPolicy: PROVIDER_POLICIES.REQUIRE_EXPLICIT,
    providerExplicitlyRequested: false,
  }));
  assert.equal(explicit.decision, SELECTION_DECISIONS.REQUIRE_EXPLICIT);
});

test('permission incompatibility fails closed without changing provider or model', () => {
  const selected = selectTransport(input({
    requestedTransport: TRANSPORTS.EXTERNAL_CODEX,
    external: eligibility({
      eligible: true,
      runtimeVerified: true,
      compatibilityLevel: 'READ_ONLY_VERIFIED',
      reason: 'only read-only capability is verified',
      permissionProfiles: [PERMISSION_PROFILES.READ_ONLY],
    }),
  }));
  assert.equal(selected.decision, SELECTION_DECISIONS.BLOCK);
  assert.equal(selected.providerId, 'deepseek');
  assert.equal(selected.model, 'deepseek-v4-flash');
  assert.match(selected.reason, /workspace-write/u);
});
