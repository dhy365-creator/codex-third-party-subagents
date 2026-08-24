import {
  PERMISSION_PROFILES,
  TRANSPORT_PREFERENCES,
  TRANSPORTS,
} from './transport-contract.mjs';
import { HOST_COMPATIBILITY_LEVELS } from './host-compatibility.mjs';
import {
  PROVIDER_POLICIES,
  SELECTION_DECISIONS,
  selectTransport,
} from './transport-selection.mjs';

const PERMISSIONS = Object.freeze(Object.values(PERMISSION_PROFILES));

export const EXTERNAL_CONTROL_PLANE = Object.freeze({
  phase: 3,
  name: TRANSPORTS.EXTERNAL_CODEX,
  modulePresent: true,
  featureEnabled: false,
  runtimeRouteEnabled: false,
  factoryAvailable: false,
  billable: true,
  maxConcurrency: 1,
  permissionProfiles: PERMISSIONS,
  disabledReason: 'EXTERNAL_TRANSPORT_DEFAULT_OFF_REQUIRES_EXPLICIT_FLASH_E2E_GATE',
});

const FLASH_MAINTAINER_EVIDENCE = Object.freeze({
  available: true,
  evidenceSource: 'maintainer-controlled',
  scope: 'controlled-maintainer-fixture',
  providerId: 'deepseek',
  model: 'deepseek-v4-flash',
  codexVersion: '0.149.0',
  runtimeEvidence: 'VERIFIED',
  localInstallationVerified: false,
  independentUserAccepted: false,
  reference: 'spikes/external-child/evidence/runtime-completion-2026-08-23.json',
});

export function maintainerExternalEvidence(providerId, model) {
  if (providerId === FLASH_MAINTAINER_EVIDENCE.providerId
    && model === FLASH_MAINTAINER_EVIDENCE.model) {
    return FLASH_MAINTAINER_EVIDENCE;
  }
  return Object.freeze({
    available: false,
    evidenceSource: null,
    scope: 'none',
    providerId,
    model,
    codexVersion: null,
    runtimeEvidence: 'UNKNOWN',
    localInstallationVerified: false,
    independentUserAccepted: false,
    reference: null,
  });
}

export function normalizeTransportPreference(value = TRANSPORT_PREFERENCES.AUTO) {
  const normalized = String(value ?? '').trim().toLowerCase();
  const aliased = normalized === 'external' ? TRANSPORTS.EXTERNAL_CODEX : normalized;
  if (!Object.values(TRANSPORT_PREFERENCES).includes(aliased)) {
    throw new Error('transport preference must be auto, native, or external');
  }
  return aliased;
}

export function roleRequiresExplicitProvider(providerRole) {
  return providerRole === 'deepseek_pro_worker';
}

export function nativeTransportEligibility(compatibility) {
  const runtimeVerified = compatibility?.level === HOST_COMPATIBILITY_LEVELS.RUNTIME_VERIFIED
    && compatibility?.automaticRoutingAllowed === true;
  return Object.freeze({
    eligible: runtimeVerified,
    runtimeVerified,
    busy: false,
    compatibilityLevel: compatibility?.level ?? HOST_COMPATIBILITY_LEVELS.UNKNOWN,
    reason: compatibility?.reason ?? 'Native Host compatibility is unknown',
    permissionProfiles: PERMISSIONS,
  });
}

export function externalTransportEligibility({
  modulePresent = EXTERNAL_CONTROL_PLANE.modulePresent,
  featureEnabled = EXTERNAL_CONTROL_PLANE.featureEnabled,
  runtimeRouteEnabled = EXTERNAL_CONTROL_PLANE.runtimeRouteEnabled,
  localRuntimeVerified = false,
  prerequisitesReady = false,
  busy = false,
  permissionProfiles = PERMISSIONS,
} = {}) {
  const eligible = modulePresent && featureEnabled && runtimeRouteEnabled
    && localRuntimeVerified && prerequisitesReady;
  let reason = 'External Transport prerequisites and local runtime evidence are ready';
  if (!modulePresent) reason = 'External Transport module is unavailable';
  else if (!featureEnabled || !runtimeRouteEnabled) {
    reason = 'External Transport is default-off and requires the controlled Phase 3 Flash gate';
  } else if (!prerequisitesReady) reason = 'External Transport prerequisites are incomplete';
  else if (!localRuntimeVerified) reason = 'External local installation runtime evidence is unavailable';
  return Object.freeze({
    eligible,
    runtimeVerified: localRuntimeVerified === true,
    busy: busy === true,
    compatibilityLevel: eligible ? 'LOCAL_RUNTIME_VERIFIED' : 'PHASE_2_DISABLED_OR_UNVERIFIED',
    reason,
    permissionProfiles: Object.freeze([...permissionProfiles]),
  });
}

export function productionExternalTransportEligibility(options = {}) {
  return externalTransportEligibility({
    ...options,
    modulePresent: EXTERNAL_CONTROL_PLANE.modulePresent,
    featureEnabled: EXTERNAL_CONTROL_PLANE.featureEnabled,
    runtimeRouteEnabled: EXTERNAL_CONTROL_PLANE.runtimeRouteEnabled,
  });
}

function policyResponse(input, decision, reason) {
  return Object.freeze({
    decision,
    requestedTransport: input.requestedTransport,
    selectedTransport: null,
    providerId: input.providerId,
    providerRole: input.providerRole,
    model: input.model,
    permissionProfile: input.permissionProfile,
    compatibilityLevel: null,
    billableAuthorized: input.billableAuthorized,
    providerReady: input.providerReady ?? null,
    reason,
  });
}

export function evaluateTransportPreflight(input) {
  const requestedTransport = normalizeTransportPreference(input.requestedTransport);
  const normalized = { ...input, requestedTransport };
  if (normalized.providerSuitable !== true) {
    return policyResponse(normalized, SELECTION_DECISIONS.BLOCK, 'task is not suitable for the requested provider');
  }
  if (normalized.providerReady === false) {
    return policyResponse(
      normalized,
      SELECTION_DECISIONS.BLOCK,
      'provider configuration or credential readiness is incomplete',
    );
  }
  if (normalized.providerReady !== undefined
    && normalized.providerReady !== null
    && normalized.providerReady !== true) {
    throw new Error('providerReady must be true, false, or null');
  }
  const selected = selectTransport({
    requestedTransport,
    providerPolicy: normalized.providerPolicy ?? PROVIDER_POLICIES.ALLOW,
    providerExplicitlyRequested: normalized.providerExplicitlyRequested === true,
    roleExplicitOnly: normalized.roleExplicitOnly === true,
    providerId: normalized.providerId,
    providerRole: normalized.providerRole,
    model: normalized.model,
    permissionProfile: normalized.permissionProfile,
    native: normalized.native,
    external: normalized.external,
  });
  if (selected.decision === SELECTION_DECISIONS.ALLOW
    && selected.selectedTransport === TRANSPORTS.EXTERNAL_CODEX
    && normalized.billableAuthorized !== true) {
    return policyResponse(
      normalized,
      SELECTION_DECISIONS.REQUIRE_EXPLICIT,
      'BILLABLE PROVIDER REQUEST authorization is required for External Transport',
    );
  }
  return Object.freeze({
    ...selected,
    billableAuthorized: normalized.billableAuthorized === true,
    providerReady: normalized.providerReady ?? null,
  });
}

export function installerTransportPlan({
  requestedTransport,
  compatibility,
  providerId,
  providerRole,
  model,
} = {}) {
  const requested = normalizeTransportPreference(requestedTransport);
  const nativeAllowed = compatibility?.configurationInstallAllowed === true;
  const explicitExternal = requested === TRANSPORTS.EXTERNAL_CODEX;
  const configurationDecision = explicitExternal || !nativeAllowed
    ? SELECTION_DECISIONS.BLOCK
    : SELECTION_DECISIONS.ALLOW;
  const reason = explicitExternal
    ? 'Public External installation remains disabled; Phase 3 uses a separate controlled Flash E2E entry point'
    : nativeAllowed
      ? 'Native configuration installation remains allowed by the Host compatibility contract'
      : `Native configuration is unavailable and ${EXTERNAL_CONTROL_PLANE.disabledReason}`;
  return Object.freeze({
    phase: EXTERNAL_CONTROL_PLANE.phase,
    requestedTransport: requested,
    configurationDecision,
    selectedTransport: configurationDecision === SELECTION_DECISIONS.ALLOW ? TRANSPORTS.NATIVE : null,
    applyAllowed: configurationDecision === SELECTION_DECISIONS.ALLOW,
    providerId,
    providerRole,
    model,
    external: EXTERNAL_CONTROL_PLANE,
    thirdPartyLiveRequests: 0,
    reason,
  });
}
