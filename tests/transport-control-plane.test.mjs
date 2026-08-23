import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHostCompatibility } from '../src/host-compatibility.mjs';
import { PERMISSION_PROFILES, TRANSPORTS } from '../src/transport-contract.mjs';
import {
  EXTERNAL_CONTROL_PLANE,
  evaluateTransportPreflight,
  externalTransportEligibility,
  installerTransportPlan,
  maintainerExternalEvidence,
  nativeTransportEligibility,
  normalizeTransportPreference,
  productionExternalTransportEligibility,
} from '../src/transport-control-plane.mjs';

function input(overrides = {}) {
  return {
    requestedTransport: 'auto',
    providerPolicy: 'allow',
    providerExplicitlyRequested: true,
    roleExplicitOnly: false,
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
    permissionProfile: PERMISSION_PROFILES.READ_ONLY,
    providerSuitable: true,
    billableAuthorized: false,
    native: nativeTransportEligibility(evaluateHostCompatibility({
      version: '0.149.0',
      multiAgent: true,
    })),
    external: externalTransportEligibility({
      modulePresent: true,
      featureEnabled: true,
      runtimeRouteEnabled: true,
      localRuntimeVerified: true,
      prerequisitesReady: true,
    }),
    ...overrides,
  };
}

test('Phase 2 production External descriptor is present but disabled and unreachable', () => {
  assert.equal(EXTERNAL_CONTROL_PLANE.phase, 2);
  assert.equal(EXTERNAL_CONTROL_PLANE.modulePresent, true);
  assert.equal(EXTERNAL_CONTROL_PLANE.featureEnabled, false);
  assert.equal(EXTERNAL_CONTROL_PLANE.runtimeRouteEnabled, false);
  assert.equal(EXTERNAL_CONTROL_PLANE.factoryAvailable, false);
  const eligibility = productionExternalTransportEligibility({
    localRuntimeVerified: true,
    prerequisitesReady: true,
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.runtimeVerified, true);
  assert.match(eligibility.reason, /disabled until Phase 3/);
});

test('transport preference accepts the documented external alias and rejects unknown values', () => {
  assert.equal(normalizeTransportPreference('external'), TRANSPORTS.EXTERNAL_CODEX);
  assert.equal(normalizeTransportPreference('native'), TRANSPORTS.NATIVE);
  assert.throws(() => normalizeTransportPreference('sidecar'), /auto, native, or external/);
});

test('External selection requires explicit billable authorization even with strict eligibility', () => {
  const required = evaluateTransportPreflight(input());
  assert.equal(required.decision, 'REQUIRE_EXPLICIT');
  assert.equal(required.selectedTransport, null);
  assert.match(required.reason, /BILLABLE PROVIDER REQUEST/);

  const allowed = evaluateTransportPreflight(input({ billableAuthorized: true }));
  assert.equal(allowed.decision, 'ALLOW');
  assert.equal(allowed.selectedTransport, TRANSPORTS.EXTERNAL_CODEX);
  assert.equal(allowed.providerId, 'deepseek');
  assert.equal(allowed.model, 'deepseek-v4-flash');
});

test('explicit Native request blocks without silently switching to eligible External', () => {
  const selected = evaluateTransportPreflight(input({
    requestedTransport: TRANSPORTS.NATIVE,
    billableAuthorized: true,
  }));
  assert.equal(selected.decision, 'BLOCK');
  assert.equal(selected.selectedTransport, null);
  assert.equal(selected.providerId, 'deepseek');
  assert.equal(selected.model, 'deepseek-v4-flash');
});

test('External single-slot busy state is an explicit policy decision', () => {
  const selected = evaluateTransportPreflight(input({
    billableAuthorized: true,
    external: externalTransportEligibility({
      modulePresent: true,
      featureEnabled: true,
      runtimeRouteEnabled: true,
      localRuntimeVerified: true,
      prerequisitesReady: true,
      busy: true,
    }),
  }));
  assert.equal(selected.decision, 'BUSY');
  assert.equal(selected.reason, 'EXTERNAL CHILD BUSY');
});

test('explicit-only Pro policy applies before Transport availability', () => {
  const required = evaluateTransportPreflight(input({
    providerExplicitlyRequested: false,
    roleExplicitOnly: true,
    providerRole: 'deepseek_pro_worker',
    model: 'deepseek-v4-pro',
    billableAuthorized: true,
  }));
  assert.equal(required.decision, 'REQUIRE_EXPLICIT');

  const allowed = evaluateTransportPreflight(input({
    providerExplicitlyRequested: true,
    roleExplicitOnly: true,
    providerRole: 'deepseek_pro_worker',
    model: 'deepseek-v4-pro',
    billableAuthorized: true,
  }));
  assert.equal(allowed.decision, 'ALLOW');
  assert.equal(allowed.providerRole, 'deepseek_pro_worker');
  assert.equal(allowed.model, 'deepseek-v4-pro');
});

test('task suitability and permission incompatibility fail closed without tuple substitution', () => {
  const unsuitable = evaluateTransportPreflight(input({ providerSuitable: false }));
  assert.equal(unsuitable.decision, 'BLOCK');
  assert.equal(unsuitable.providerId, 'deepseek');
  assert.equal(unsuitable.model, 'deepseek-v4-flash');

  const permission = evaluateTransportPreflight(input({
    billableAuthorized: true,
    permissionProfile: PERMISSION_PROFILES.WORKSPACE_WRITE,
    external: externalTransportEligibility({
      modulePresent: true,
      featureEnabled: true,
      runtimeRouteEnabled: true,
      localRuntimeVerified: true,
      prerequisitesReady: true,
      permissionProfiles: [PERMISSION_PROFILES.READ_ONLY],
    }),
  }));
  assert.equal(permission.decision, 'BLOCK');
  assert.equal(permission.providerId, 'deepseek');
  assert.equal(permission.model, 'deepseek-v4-flash');
});

test('maintainer evidence is scoped to Flash and never claims local installation verification', () => {
  const flash = maintainerExternalEvidence('deepseek', 'deepseek-v4-flash');
  assert.equal(flash.available, true);
  assert.equal(flash.evidenceSource, 'maintainer-controlled');
  assert.equal(flash.localInstallationVerified, false);

  for (const [providerId, model] of [
    ['deepseek', 'deepseek-v4-pro'],
    ['minimax', 'MiniMax-M3'],
    ['qwen', 'qwen3.7-max'],
  ]) {
    const evidence = maintainerExternalEvidence(providerId, model);
    assert.equal(evidence.available, false);
    assert.equal(evidence.runtimeEvidence, 'UNKNOWN');
  }
});

test('Installer Phase 2 plans Native configuration and blocks External apply activation', () => {
  const compatible = evaluateHostCompatibility({ version: '0.147.0', multiAgent: true });
  const native = installerTransportPlan({
    requestedTransport: 'auto',
    compatibility: compatible,
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
  });
  assert.equal(native.configurationDecision, 'ALLOW');
  assert.equal(native.selectedTransport, TRANSPORTS.NATIVE);
  assert.equal(native.thirdPartyLiveRequests, 0);

  const external = installerTransportPlan({
    requestedTransport: 'external',
    compatibility: compatible,
    providerId: 'deepseek',
    providerRole: 'deepseek_worker',
    model: 'deepseek-v4-flash',
  });
  assert.equal(external.configurationDecision, 'BLOCK');
  assert.equal(external.applyAllowed, false);
  assert.match(external.reason, /requires Phase 3/);
});
